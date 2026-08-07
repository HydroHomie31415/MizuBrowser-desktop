/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Same-network tab sync: one tab set, held by this desktop and by every phone
 * paired with it.
 *
 * A synced tab is an ordinary tab. Opening one here opens it there, closing it
 * on either device closes it on both, and navigating one moves the other copy
 * with it. There is no separate list of somebody else's tabs, which is the
 * whole point: the shared set is the tab strip.
 *
 * The merge rules live in MizuTabSyncState. What is here is everything that
 * has to touch Gecko for them: the listener the phone talks to, the window and
 * tab events that turn local browsing into records, and the reconciliation
 * that turns records back into tabs.
 *
 * Two properties keep that reconciliation from fighting itself:
 *
 *   - Records describe what a tab *is*, so a tab that navigated because the
 *     other device asked it to reports back exactly what the record already
 *     says and produces no new revision. Echoes die on their own rather than
 *     being suppressed by flags.
 *   - Applying the set is a full reconcile, not a list of deltas. A missed
 *     event, a window that was closed while a sync was in flight, or a state
 *     file from a previous session all converge on the next pass.
 */

// The merge rules are not deferred: this module is only loaded when tab sync
// is on, and it cannot do anything at all without them.
import {
  MAX_LIVE_RECORDS,
  MAX_TOMBSTONES,
  PROTOCOL_VERSION,
  TabSyncState,
  isShareableURL,
} from "resource:///modules/MizuTabSyncState.sys.mjs";

const PREF_BRANCH = "mizu.tabsync.";
const MAX_REQUEST_BYTES = 512 * 1024;
const PEER_TTL_MS = 5 * 60 * 1000;
const PAIRING_VERSION = 1;
const ADDRESS_TIMEOUT_MS = 1500;
// How long a phone may ask to be left waiting for something to change. It is
// well under the read timeout on the other end, so an idle link is a parked
// connection rather than a poll every few seconds.
const MAX_WAIT_MS = 25 * 1000;
const SAVE_DELAY_MS = 1500;
const STATE_FILE = "mizu-tabsync.json";
// Session store carries this across restarts, so a tab that was open when Mizu
// last quit is still the same tab to the phone when it comes back.
const TAB_ID_KEY = "mizu-tabsync-id";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

// Pages arrive from another device, so they load with no more authority than a
// link from nowhere would carry.
function syncPrincipal() {
  return Services.scriptSecurityManager.createNullPrincipal({});
}

function randomId() {
  return `${Services.uuid.generateUUID()}${Services.uuid.generateUUID()}`.replaceAll(
    /[{}-]/g,
    ""
  );
}

function isLoopbackAddress(host) {
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (host.startsWith("::ffff:")) {
    host = host.slice(7);
  }
  return host == "::1" || /^127\./.test(host);
}

// A phone cannot reach a link-local IPv6 address without the scope identifier
// of the interface it was learned on, which is meaningless on the other device.
function isScopedAddress(host) {
  return host
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .startsWith("fe80:");
}

// Addresses that exist only inside this machine. A container or virtual-machine
// bridge answers here and nowhere else, and it is not a theoretical hazard: a
// name server for the desktop's own host name will hand one out (Avahi
// publishes every interface), so a phone told to use it never connects.
const VIRTUAL_ADDRESSES = [
  /^172\.(1[7-9]|2\d|3[01])\./, // Docker's default bridge and network pool
  /^192\.168\.122\./, // libvirt
  /^10\.0\.2\./, // QEMU and VirtualBox NAT
];

// Ordering, not exclusion: the pairing code carries every address and the phone
// tries them in turn, so a wrong guess here costs a retry rather than a pairing.
function addressRank(host) {
  if (host.includes(":")) {
    return 3; // IPv6, which a phone on a v4-only network cannot route to
  }
  if (/^169\.254\./.test(host)) {
    return 2; // link-local, only usable with no router between the two
  }
  return VIRTUAL_ADDRESSES.some(range => range.test(host)) ? 1 : 0;
}

// An IPv6 address only survives being written next to a port in brackets, which
// is also the form the other end has to hand to its own URL parser.
function formatEndpoint(host, port) {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]:${port}`;
  }
  return `${host}:${port}`;
}

function isPrivateAddress(host) {
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (host.startsWith("::ffff:")) {
    host = host.slice(7);
  }
  if (
    host == "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  ) {
    return true;
  }
  let match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!match) {
    return false;
  }
  let [, a, b] = match.map(Number);
  return (
    a == 10 ||
    a == 127 ||
    (a == 169 && b == 254) ||
    (a == 172 && b >= 16 && b <= 31) ||
    (a == 192 && b == 168)
  );
}

function bytesToString(bytes) {
  return new TextDecoder().decode(
    Uint8Array.from(bytes, byte => byte.charCodeAt(0))
  );
}

function stringToBytes(value) {
  let bytes = new TextEncoder().encode(value);
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return result;
}

// The window a tab or a browser belongs to. `ownerGlobal` is the usual way to
// ask, but it is a chrome-only attribute that these elements do not hand over
// to a module in the system global, where it reads as undefined rather than
// failing. The document's view is the way in that works from here.
function ownerWindow(element) {
  return element?.ownerDocument?.defaultView || null;
}

function tabURL(tab) {
  try {
    return tab.linkedBrowser?.currentURI?.spec || "";
  } catch (_) {
    // A tab being torn down can have lost its browser already.
    return "";
  }
}

// A lazy tab is one session store has not restored yet: it has a label and a
// URL but no content process behind it. Remote tabs are created this way, so a
// phone with forty tabs costs this desktop forty rows in the tab strip rather
// than forty page loads.
function isLazyTab(tab) {
  return !tab.linkedPanel;
}

class Connection {
  constructor(owner, transport) {
    this.owner = owner;
    this.transport = transport;
    this.input = transport.openInputStream(0, 0, 0);
    this.output = transport.openOutputStream(0, 0, 0);
    this.data = "";
    this.responded = false;
    this.handled = false;
    // Set while the connection is parked waiting for something to change, so
    // the client hanging up is an ordinary end rather than a failed request.
    this.onClosed = null;

    this.scriptable = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    this.scriptable.init(this.input);
    this.pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(
      Ci.nsIInputStreamPump
    );
    this.pump.init(this.input, 0, 0, false);
    this.pump.asyncRead(this);
  }

  onStartRequest() {}

  onDataAvailable(_request, stream, _offset, count) {
    this.data += this.scriptable.readBytes(count);
    if (this.data.length > MAX_REQUEST_BYTES) {
      this.reply(413, { error: "request_too_large" });
      return;
    }
    this.maybeHandle();
  }

  onStopRequest() {
    if (this.responded) {
      return;
    }
    if (this.onClosed) {
      this.onClosed();
      return;
    }
    this.reply(400, { error: "incomplete_request" });
  }

  maybeHandle() {
    if (this.handled) {
      return;
    }
    let headerEnd = this.data.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }
    let headerLines = this.data.slice(0, headerEnd).split("\r\n");
    let [method, path, version] = headerLines.shift().split(" ");
    let headers = new Map();
    for (let line of headerLines) {
      let colon = line.indexOf(":");
      if (colon > 0) {
        headers.set(
          line.slice(0, colon).trim().toLowerCase(),
          line.slice(colon + 1).trim()
        );
      }
    }
    let contentLength = Number(headers.get("content-length") || 0);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > MAX_REQUEST_BYTES
    ) {
      this.reply(413, { error: "request_too_large" });
      return;
    }
    let bodyStart = headerEnd + 4;
    if (this.data.length < bodyStart + contentLength) {
      return;
    }
    this.handled = true;
    this.owner.handle(this, {
      method,
      path,
      version,
      headers,
      body: bytesToString(
        this.data.slice(bodyStart, bodyStart + contentLength)
      ),
    });
  }

  reply(status, value) {
    if (this.responded) {
      return;
    }
    this.responded = true;
    this.onClosed = null;
    let body = stringToBytes(JSON.stringify(value));
    let reason =
      {
        200: "OK",
        400: "Bad Request",
        401: "Unauthorized",
        403: "Forbidden",
        404: "Not Found",
        405: "Method Not Allowed",
        413: "Payload Too Large",
      }[status] || "Error";
    let response = `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n${body}`;
    try {
      this.output.write(response, response.length);
      // Closing the stream is what sends the response. Closing the transport
      // instead tears the socket down with the reply still buffered in it,
      // which the other end sees as a connection that answered nothing. There
      // is nothing to keep open afterwards: every reply says Connection: close.
      this.output.close();
    } catch (error) {
      console.error("Mizu tab sync could not write a response", error);
    }
  }
}

export const MizuTabSync = {
  PEER_TOPIC: "mizu-tabsync-peer",

  _initialized: false,
  _loaded: false,
  _server: null,
  _state: null,
  _peers: new Map(),
  // Records this desktop is currently showing, both ways round. The forward
  // map is what reconciliation walks; the reverse one is what a tab event has
  // to start from.
  _tabs: new Map(),
  _ids: new WeakMap(),
  _windows: new Set(),
  _waiters: new Set(),
  _saveTimer: null,
  // Non-zero while this module is the one moving tabs around, so its own work
  // does not read back as the user opening or closing something.
  _applying: 0,
  _reconciling: false,
  _quitting: false,

  get deviceName() {
    return Services.dns.myHostName || "Mizu desktop";
  },

  get enabled() {
    return Services.prefs.getBoolPref(`${PREF_BRANCH}enabled`, false);
  },

  get listening() {
    return !!this._server;
  },

  get port() {
    return Services.prefs.getIntPref(`${PREF_BRANCH}port`, 8765);
  },

  get token() {
    let token = Services.prefs.getStringPref(`${PREF_BRANCH}token`, "");
    if (!token) {
      token = randomId();
      Services.prefs.setStringPref(`${PREF_BRANCH}token`, token);
    }
    return token;
  },

  get deviceId() {
    let id = Services.prefs.getStringPref(`${PREF_BRANCH}device-id`, "");
    if (!id) {
      id = randomId();
      Services.prefs.setStringPref(`${PREF_BRANCH}device-id`, id);
    }
    return id;
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this._state = new TabSyncState(this.deviceId);
    Services.prefs.addObserver(PREF_BRANCH, this);
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
    Services.obs.addObserver(this, "sessionstore-windows-restored");
    Services.obs.addObserver(this, "quit-application-granted");
    this._ready = this._load();
    this._updateServer();
  },

  observe(subject, topic, data) {
    switch (topic) {
      case "nsPref:changed":
        if (data == `${PREF_BRANCH}enabled` || data == `${PREF_BRANCH}port`) {
          this._updateServer();
          if (this.enabled) {
            this._ready.then(() => this._adoptWindows());
          } else {
            // The shared set is kept, but this desktop stops both contributing
            // to it and being moved by it until sync is turned back on.
            for (let window of [...this._windows]) {
              this._forgetWindow(window);
            }
          }
        }
        break;
      case "browser-delayed-startup-finished":
        this._ready.then(() => this._adoptWindow(subject));
        break;
      case "sessionstore-windows-restored":
        // The tabs from the last session are all in place by now, including
        // the ones that were still being created when their window was adopted.
        this._ready.then(() => {
          this._adoptWindows();
          this._scanWindows();
        });
        break;
      case "quit-application-granted":
        // Quitting is not closing tabs. Session store will bring them back and
        // the phone should still have them in the meantime.
        this._quitting = true;
        this._releaseWaiters();
        this._save();
        break;
    }
  },

  /* Shared state -------------------------------------------------------- */

  get _statePath() {
    return PathUtils.join(PathUtils.profileDir, STATE_FILE);
  },

  async _load() {
    try {
      this._state.load(await IOUtils.readJSON(this._statePath));
    } catch (error) {
      if (error.name != "NotFoundError") {
        console.error("Mizu tab sync could not read its saved tabs", error);
      }
    }
    this._state.prune();
    this._loaded = true;
    if (this.enabled) {
      this._adoptWindows();
    }
  },

  _scheduleSave() {
    if (this._saveTimer) {
      return;
    }
    this._saveTimer = lazy.setTimeout(() => this._save(), SAVE_DELAY_MS);
  },

  _save() {
    if (this._saveTimer) {
      lazy.clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this._loaded) {
      return;
    }
    IOUtils.writeJSON(this._statePath, this._state.toJSON(), {
      tmpPath: `${this._statePath}.tmp`,
    }).catch(error =>
      console.error("Mizu tab sync could not save its tabs", error)
    );
  },

  /**
   * Something in the shared set moved. Anything waiting to hear about it is
   * answered now rather than on its next poll.
   */
  _changed() {
    this._scheduleSave();
    this._releaseWaiters();
  },

  /* Windows and tabs ---------------------------------------------------- */

  _adoptWindows() {
    for (let window of Services.wm.getEnumerator("navigator:browser")) {
      this._adoptWindow(window);
    }
  },

  _adoptWindow(window) {
    if (
      !this.enabled ||
      !this._loaded ||
      this._windows.has(window) ||
      window.closed ||
      !window.gBrowser ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(window)
    ) {
      return;
    }
    this._windows.add(window);
    let container = window.gBrowser.tabContainer;
    container.addEventListener("TabOpen", this);
    container.addEventListener("TabClose", this);
    container.addEventListener("TabAttrModified", this);
    window.gBrowser.addTabsProgressListener(this._progressListener);
    window.addEventListener("unload", this, { once: true });

    this._scanWindows();
  },

  /**
   * Take stock of every tab that is open, whether this module has seen it
   * before or not.
   *
   * Session restore is why this is not only done once per window: a restored
   * window is adopted before its tabs are put back into it, and the tabs it
   * then creates announce themselves before they have either their URL or the
   * identifier they carried out of the last session. A tab left unrecognised
   * that way would be a tab the shared set thinks nobody has, which is to say
   * a second copy of it opened on the next reconcile.
   */
  _scanWindows() {
    for (let window of [...this._windows]) {
      if (window.closed || !window.gBrowser) {
        continue;
      }
      for (let tab of window.gBrowser.tabs) {
        this._scanTab(tab);
      }
    }
    this._applyState();
  },

  _scanTab(tab) {
    if (this._idFor(tab)) {
      return;
    }
    let id = lazy.SessionStore.getCustomTabValue(tab, TAB_ID_KEY);
    if (id && this._state.get(id)) {
      // A tab from the last session, and the shared set still knows it. What
      // the record says now outranks what this tab was left showing: the phone
      // may have moved or closed it while Mizu was not running, and reading the
      // tab back in would overwrite that with stale news.
      this._ids.set(tab, id);
      this._tabs.set(id, tab);
      return;
    }
    this._captureTab(tab);
  },

  _forgetWindow(window) {
    if (!this._windows.delete(window)) {
      return;
    }
    let container = window.gBrowser?.tabContainer;
    container?.removeEventListener("TabOpen", this);
    container?.removeEventListener("TabClose", this);
    container?.removeEventListener("TabAttrModified", this);
    window.gBrowser?.removeTabsProgressListener(this._progressListener);
  },

  handleEvent(event) {
    if (event.type == "unload") {
      // The listener is on the window, but unload is dispatched at its
      // document, so the window comes off the listener rather than the target.
      this._onWindowUnload(event.currentTarget);
      return;
    }
    if (this._applying || !this._loaded || !this.enabled) {
      return;
    }
    let tab = event.target;
    switch (event.type) {
      case "TabOpen":
        // Read on the next tick rather than now: a tab session store is
        // restoring is announced before its URL and its stored identifier have
        // been put on it, and both are in place by the time this runs.
        lazy.setTimeout(() => {
          this._scanTab(tab);
          this._applyState();
        }, 0);
        break;
      case "TabClose":
        // A tab dragged into another window closes here and opens there. It is
        // the same tab throughout, and the window it lands in re-adopts it.
        if (!event.detail?.adoptedBy) {
          this._closeRecordFor(tab);
        }
        break;
      case "TabAttrModified":
        if (event.detail?.changed?.includes("label")) {
          this._captureTab(tab);
        }
        break;
    }
  },

  _onWindowUnload(window) {
    // Closing a window tears its tabs down without firing TabClose, so the
    // difference between a window the user closed and one that is going away
    // because Mizu is quitting has to be drawn here. Only the first is a
    // decision to close those tabs everywhere.
    if (!this._quitting && this._windows.has(window) && window.gBrowser) {
      for (let tab of window.gBrowser.tabs) {
        this._closeRecordFor(tab);
      }
    }
    this._forgetWindow(window);
  },

  _progressListener: {
    onLocationChange(browser, webProgress) {
      if (!webProgress?.isTopLevel) {
        return;
      }
      MizuTabSync._onLocationChange(browser);
    },
  },

  _onLocationChange(browser) {
    if (this._applying || !this._loaded || !this.enabled) {
      return;
    }
    let window = ownerWindow(browser);
    let tab = window?.gBrowser?.getTabForBrowser(browser);
    if (tab) {
      this._captureTab(tab);
    }
  },

  _idFor(tab) {
    return this._ids.get(tab);
  },

  _assignId(tab, id) {
    this._ids.set(tab, id);
    this._tabs.set(id, tab);
    try {
      lazy.SessionStore.setCustomTabValue(tab, TAB_ID_KEY, id);
    } catch (error) {
      // A tab already on its way out cannot carry a value into the next
      // session, which costs nothing while this one lasts.
      console.error("Mizu tab sync could not label a tab", error);
    }
  },

  /**
   * Fold a tab's current state into the shared set. This is the only path from
   * local browsing into a record, and it compares rather than assumes: a tab
   * that already matches its record produces nothing, which is what stops a
   * change this desktop applied on the phone's behalf from bouncing back.
   *
   * @param {MozTabbrowserTab} tab
   */
  _captureTab(tab) {
    // A tab can be handed here without a window: one that has been detached on
    // its way into another window, or one being torn down. It is not this
    // desktop's to report either way until it has landed somewhere.
    let window = ownerWindow(tab);
    if (
      !this.enabled ||
      !this._loaded ||
      !tab.isConnected ||
      !window ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(window)
    ) {
      return;
    }
    let url = tabURL(tab);
    if (!isShareableURL(url)) {
      // An `about:` page or a blank new tab. It is not shared, and a tab that
      // was shared and has wandered onto one keeps the last URL that was.
      return;
    }
    let id = this._idFor(tab);
    if (!id) {
      let restored = lazy.SessionStore.getCustomTabValue(tab, TAB_ID_KEY);
      id = restored || randomId();
      this._assignId(tab, id);
      if (restored && this._state.get(id)) {
        // A tab session store has just brought back. It is showing where it
        // was when Mizu last quit, which is older news than the shared set:
        // reading it back in here would undo whatever the phone did in the
        // meantime. Let reconciliation move it instead.
        this._applyState();
        return;
      }
    }
    let record = this._state.writeLocal(id, { url, title: tab.label });
    if (record) {
      this._changed();
    }
  },

  _closeRecordFor(tab) {
    let id = this._idFor(tab);
    if (!id) {
      return;
    }
    this._ids.delete(tab);
    if (this._tabs.get(id) === tab) {
      this._tabs.delete(id);
    }
    if (this._state.closeLocal(id)) {
      this._changed();
    }
  },

  /* Applying the shared set --------------------------------------------- */

  _targetWindow() {
    let window = lazy.BrowserWindowTracker.getTopWindow({ private: false });
    if (window && this._windows.has(window)) {
      return window;
    }
    for (let candidate of this._windows) {
      if (!candidate.closed) {
        return candidate;
      }
    }
    return null;
  },

  /**
   * Make this desktop's tabs match the shared set.
   *
   * Every pass looks at the whole set rather than at what just arrived, so a
   * tab that could not be created because no window was open, or a close that
   * landed while a window was being torn down, is simply picked up next time.
   */
  _applyState() {
    // Reconciliation reads tabs back in as it goes, and reading a tab back in
    // can ask for reconciliation. One pass at a time is enough for both.
    if (
      this._reconciling ||
      !this.enabled ||
      !this._loaded ||
      this._quitting
    ) {
      return;
    }
    this._reconciling = true;
    try {
      this._reconcile();
    } finally {
      this._reconciling = false;
    }
  },

  _reconcile() {
    for (let [id, tab] of [...this._tabs]) {
      let window = ownerWindow(tab);
      if (!tab.isConnected || !window || window.closed) {
        this._tabs.delete(id);
        continue;
      }
      let record = this._state.get(id);
      if (!record) {
        // The record was pruned out from under a tab that is still here. Put
        // it back rather than closing a tab nobody asked to close.
        this._captureTab(tab);
        continue;
      }
      if (record.closed) {
        this._removeTab(tab);
        this._ids.delete(tab);
        this._tabs.delete(id);
        continue;
      }
      this._updateTab(tab, record);
    }
    let target = this._targetWindow();
    if (!target) {
      return;
    }
    for (let record of this._state.live) {
      if (!this._tabs.has(record.id)) {
        this._createTab(target, record);
      }
    }
  },

  /**
   * Whether a tab is the one somebody is looking at right now. The shared set
   * moves a tab's copy to wherever it was navigated, and this is the exception:
   * the page in front of somebody is not pulled out from under them, and this
   * device's URL for it wins instead.
   *
   * @param {MozTabbrowserTab} tab
   * @returns {boolean}
   */
  _isInUse(tab) {
    return tab.selected && Services.focus.activeWindow == ownerWindow(tab);
  },

  _createTab(window, record) {
    this._applying++;
    try {
      let tab = window.gBrowser.addTab(record.url, {
        createLazyBrowser: true,
        lazyTabTitle: record.title,
        inBackground: true,
        skipAnimation: true,
        triggeringPrincipal: syncPrincipal(),
      });
      if (tab) {
        this._assignId(tab, record.id);
      }
    } catch (error) {
      console.error("Mizu tab sync could not open a synced tab", error);
    } finally {
      this._applying--;
    }
  },

  _updateTab(tab, record) {
    let url = tabURL(tab);
    if (url == record.url) {
      return;
    }
    if (!isShareableURL(url)) {
      // The tab has been taken somewhere that is not shared — an `about:` page,
      // a file, or nowhere yet. Moving it back to where the record left it
      // would be arguing with whoever took it there; the record keeps the last
      // shared URL, and the phone's copy stays on it.
      return;
    }
    if (this._isInUse(tab)) {
      this._captureTab(tab);
      return;
    }
    this._applying++;
    try {
      if (isLazyTab(tab)) {
        // The tab has never been restored, so there is no page to navigate.
        // Rewriting the state session store would have restored is both
        // cheaper and less disruptive than loading one to move it.
        lazy.SessionStore.setTabState(tab, {
          entries: [
            {
              url: record.url,
              title: record.title,
              triggeringPrincipal_base64: lazy.E10SUtils.serializePrincipal(
                syncPrincipal()
              ),
            },
          ],
          index: 1,
        });
        // The lazy browser answers currentURI out of a cache it filled the
        // first time it was asked, which is now a URL this tab has left.
        delete tab.linkedBrowser._cachedCurrentURI;
        tab.label = record.title;
      } else {
        tab.linkedBrowser.loadURI(Services.io.newURI(record.url), {
          triggeringPrincipal: syncPrincipal(),
        });
      }
    } catch (error) {
      console.error("Mizu tab sync could not move a synced tab", error);
    } finally {
      this._applying--;
    }
  },

  _removeTab(tab) {
    let window = ownerWindow(tab);
    if (!window?.gBrowser) {
      return;
    }
    this._applying++;
    try {
      // Closing the last tab in a window closes the window. A tab closed on a
      // phone should not take a desktop window with it.
      if (window.gBrowser.tabs.length == 1) {
        let blank = window.BROWSER_NEW_TAB_URL || "about:newtab";
        window.gBrowser.addTrustedTab(blank, {
          inBackground: false,
          skipAnimation: true,
        });
      }
      window.gBrowser.removeTab(tab, { animate: false });
    } catch (error) {
      console.error("Mizu tab sync could not close a synced tab", error);
    } finally {
      this._applying--;
    }
  },

  /* Listener ------------------------------------------------------------ */

  _updateServer() {
    this._server?.close();
    this._server = null;
    this._releaseWaiters();
    if (!this.enabled) {
      return;
    }
    try {
      let server = Cc["@mozilla.org/network/server-socket;1"].createInstance(
        Ci.nsIServerSocket
      );
      server.initSpecialConnection(
        this.port,
        Ci.nsIServerSocket.KeepWhenOffline,
        8
      );
      server.asyncListen(this);
      this._server = server;
      void this.token;
    } catch (error) {
      console.error(
        `Mizu tab sync could not listen on port ${this.port}`,
        error
      );
    }
  },

  onSocketAccepted(_socket, transport) {
    if (!isPrivateAddress(transport.host)) {
      transport.close(Cr.NS_ERROR_CONNECTION_REFUSED);
      return;
    }
    new Connection(this, transport);
  },

  onStopListening() {},

  handle(connection, request) {
    if (request.method != "POST") {
      connection.reply(405, { error: "method_not_allowed" });
      return;
    }
    if (request.path == "/v1/sync") {
      // The tab list protocol this replaced. Saying so is worth more than a
      // 404, because the phone can put it in front of the person holding it.
      connection.reply(400, {
        error: "version_mismatch",
        message: "Update Mizu on this device to keep tabs in sync",
      });
      return;
    }
    if (request.path != "/v2/sync") {
      connection.reply(404, { error: "not_found" });
      return;
    }
    if (request.headers.get("authorization") != `Bearer ${this.token}`) {
      connection.reply(401, { error: "unauthorized" });
      return;
    }
    let value;
    try {
      value = JSON.parse(request.body);
    } catch (_) {
      connection.reply(400, { error: "invalid_json" });
      return;
    }
    if (
      value?.version != PROTOCOL_VERSION ||
      typeof value.deviceId != "string" ||
      !value.deviceId ||
      value.deviceId.length > 128 ||
      !Array.isArray(value.records)
    ) {
      connection.reply(400, { error: "invalid_payload" });
      return;
    }
    if (!this._loaded) {
      // The saved set is still being read. Merging into an empty one would
      // read as this desktop having closed every tab it has.
      this._ready.then(() => this.handle(connection, request));
      return;
    }

    let limit =
      MAX_LIVE_RECORDS +
      MAX_TOMBSTONES;
    let changed = this._state.merge(value.records.slice(0, limit));
    this._state.prune();
    this._peers.set(value.deviceId, {
      id: value.deviceId,
      name:
        typeof value.deviceName == "string"
          ? value.deviceName.slice(0, 80)
          : "Mobile device",
      updatedAt: Date.now(),
    });
    // The pairing dialog is waiting for exactly this: the first request a
    // scanned device makes is what proves the code was read and accepted.
    Services.obs.notifyObservers(null, this.PEER_TOPIC, value.deviceId);
    if (changed) {
      this._applyState();
      this._changed();
    }

    let known = Number.isSafeInteger(value.known) ? value.known : -1;
    let wait = Number.isSafeInteger(value.waitMs)
      ? Math.min(Math.max(value.waitMs, 0), MAX_WAIT_MS)
      : 0;
    if (wait && known == this._state.version) {
      this._park(connection, wait);
      return;
    }
    this._reply(connection);
  },

  _reply(connection) {
    connection.reply(200, {
      version: PROTOCOL_VERSION,
      stateVersion: this._state.version,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      records: this._state.toJSON(),
    });
  },

  /**
   * Hold a request open until the shared set moves. A phone that is up to date
   * has nothing to be told, and answering it immediately only means it asks
   * again in a moment; parked, it hears about a closed tab as it happens.
   *
   * @param {Connection} connection
   * @param {number} wait
   */
  _park(connection, wait) {
    let waiter = { connection, timer: null };
    waiter.timer = lazy.setTimeout(() => this._release(waiter), wait);
    connection.onClosed = () => {
      this._waiters.delete(waiter);
      lazy.clearTimeout(waiter.timer);
    };
    this._waiters.add(waiter);
  },

  _release(waiter) {
    if (!this._waiters.delete(waiter)) {
      return;
    }
    lazy.clearTimeout(waiter.timer);
    waiter.connection.onClosed = null;
    this._reply(waiter.connection);
  },

  _releaseWaiters() {
    for (let waiter of [...this._waiters]) {
      this._release(waiter);
    }
  },

  /* Pairing ------------------------------------------------------------- */

  get sharedTabCount() {
    return this._state ? this._state.live.length : 0;
  },

  get peers() {
    let cutoff = Date.now() - PEER_TTL_MS;
    let peers = [];
    for (let [id, peer] of this._peers) {
      if (peer.updatedAt < cutoff) {
        this._peers.delete(id);
        continue;
      }
      peers.push({ id: peer.id, name: peer.name, updatedAt: peer.updatedAt });
    }
    return peers.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  // Pairing hands out the token, so it is also the point where an old token can
  // be retired: every device that scanned the previous code stops being able to
  // sync, and the next code carries the replacement.
  rotateToken() {
    this._peers.clear();
    Services.prefs.setStringPref(`${PREF_BRANCH}token`, "");
    return this.token;
  },

  _resolve(hostName) {
    return new Promise(resolve => {
      let addresses = [];
      let settled = false;
      let finish = () => {
        if (!settled) {
          settled = true;
          resolve(addresses);
        }
      };
      let listener = {
        onLookupComplete(_request, record, status) {
          if (Components.isSuccessCode(status) && record) {
            record.QueryInterface(Ci.nsIDNSAddrRecord);
            while (record.hasMore()) {
              addresses.push(record.getNextAddrAsString());
            }
          }
          finish();
        },
      };
      try {
        Services.dns.asyncResolve(
          hostName,
          Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT,
          Ci.nsIDNSService.RESOLVE_DISABLE_TRR |
            Ci.nsIDNSService.RESOLVE_BYPASS_CACHE,
          null,
          listener,
          Services.tm.mainThread,
          {}
        );
      } catch (_) {
        finish();
        return;
      }
      // A name that no resolver on this network knows about can otherwise hold
      // the pairing dialog open until the lookup itself gives up.
      lazy.setTimeout(finish, ADDRESS_TIMEOUT_MS);
    });
  },

  /**
   * The addresses a device on this network can reach this desktop at, best
   * first. The host name is what the desktop calls itself; it is only worth
   * putting in a pairing code once something has resolved it to an address the
   * phone can dial, so loopback and scoped results are dropped rather than
   * offered.
   *
   * @param {string[]} [candidates]
   *   Addresses the caller found by other means. Resolving the host name only
   *   reports what a name server believes, which on a machine with container or
   *   virtual interfaces is regularly the wrong interface, or nothing at all.
   * @returns {Promise<string[]>}
   */
  async addresses(candidates = []) {
    let hostName = Services.dns.myHostName;
    let found = [...candidates];
    for (let name of [hostName, hostName ? `${hostName}.local` : ""]) {
      if (!name) {
        continue;
      }
      found.push(...(await this._resolve(name)));
    }
    let addresses = [];
    for (let address of found) {
      if (
        isPrivateAddress(address) &&
        !isLoopbackAddress(address) &&
        !isScopedAddress(address) &&
        !addresses.includes(address)
      ) {
        addresses.push(address);
      }
    }
    return addresses.sort((a, b) => addressRank(a) - addressRank(b));
  },

  /**
   * Everything a device needs to start syncing with this desktop.
   *
   * @param {string[]} [candidates]
   *   Extra addresses for this desktop, as for addresses().
   * @returns {Promise<object>}
   */
  async pairingInfo(candidates = []) {
    let hosts = await this.addresses(candidates);
    let hostName = Services.dns.myHostName;
    if (!hosts.length && hostName) {
      hosts = [hostName];
    }
    let port = this.port;
    let endpoints = hosts.map(host => formatEndpoint(host, port));
    return {
      version: PAIRING_VERSION,
      hosts,
      host: hosts[0] || "",
      port,
      server: endpoints[0] || "",
      alternates: endpoints.slice(1),
      token: this.token,
      deviceName: this.deviceName,
    };
  },

  /**
   * The pairing information as the single string a QR code carries. Alternate
   * addresses ride along so a device that cannot reach the first one, which is
   * a guess made without knowing which network the phone is on, can try the
   * rest before asking anyone to type an address in.
   *
   * @param {object} info
   *   A value from pairingInfo().
   * @returns {string}
   */
  pairingURL(info) {
    let params = new URLSearchParams();
    params.set("v", String(info.version));
    params.set("server", info.server);
    params.set("token", info.token);
    if (info.deviceName) {
      params.set("name", info.deviceName);
    }
    if (info.alternates.length) {
      params.set("alt", info.alternates.join(","));
    }
    return `mizu://tabsync?${params}`;
  },
};

MizuTabSync.init();

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const GATHERING_TIMEOUT_MS = 1000;

var MizuTabSyncPairingLazy = {};
ChromeUtils.defineESModuleGetters(MizuTabSyncPairingLazy, {
  MizuTabSync: "resource:///modules/MizuTabSync.sys.mjs",
  QR: "moz-src:///toolkit/components/qrcode/encoder.mjs",
});

// Tab sync runs in the parent process, above any one window, but nothing loads
// it until something asks for it. A window opening with sync already switched
// on is that ask: the service has to be listening from startup rather than
// from whenever the pairing dialog is next opened.
if (Services.prefs.getBoolPref("mizu.tabsync.enabled", false)) {
  MizuTabSyncPairingLazy.MizuTabSync.init();
}

/**
 * The pairing side of same-network tab sync: it turns the listener's address
 * and token into a code a phone camera can read, and then waits for that phone
 * to make its first request so the person holding it can see that it worked.
 *
 * The typed details stay on screen underneath the code. A desktop can have an
 * address no phone on the network resolves, and that case has to remain
 * recoverable without a second device to read this from.
 */
var MizuTabSyncPairing = {
  HTML_NS: "http://www.w3.org/1999/xhtml",

  _dialog: null,
  _qr: null,
  _codeError: null,
  _address: null,
  _token: null,
  _status: null,
  _generation: 0,
  _url: "",

  observe(_subject, topic) {
    if (topic == MizuTabSyncPairingLazy.MizuTabSync.PEER_TOPIC) {
      this._renderStatus();
    }
  },

  handleEvent(event) {
    if (event.type == "unload") {
      this._stopWatching();
    }
  },

  _element(name, className = "") {
    let element = document.createElementNS(this.HTML_NS, name);
    if (className) {
      element.className = className;
    }
    return element;
  },

  _button(label, className, onClick) {
    let button = this._element("button", className);
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  },

  _detail(term, className) {
    let row = this._element("div", "mizu-tabsync-detail");
    let name = this._element("dt");
    name.textContent = term;
    let value = this._element("dd", className);
    row.append(name, value);
    return { row, value };
  },

  _build() {
    let dialog = this._element("dialog", "mizu-tabsync-pairing");
    dialog.id = "mizu-tabsync-pairing";
    dialog.setAttribute("aria-label", "Mizu tab sync pairing");

    let frame = this._element("div", "mizu-tabsync-frame");
    let title = this._element("h1", "mizu-tabsync-title");
    title.textContent = "Pair a device with tab sync";
    let subtitle = this._element("p", "mizu-tabsync-subtitle");
    subtitle.textContent =
      "In Mizu on your phone, open Settings → Tab sync → Scan code, " +
      "then point the camera at this code.";

    let code = this._element("div", "mizu-tabsync-code");
    let qr = this._element("img", "mizu-tabsync-qr");
    qr.alt = "Tab sync pairing code";
    let codeError = this._element("p", "mizu-tabsync-code-error");
    codeError.hidden = true;
    code.append(qr, codeError);

    let details = this._element("dl", "mizu-tabsync-details");
    let address = this._detail("Address", "mizu-tabsync-value");
    let token = this._detail("Token", "mizu-tabsync-value mizu-tabsync-token");
    details.append(address.row, token.row);

    let status = this._element("p", "mizu-tabsync-status");
    status.setAttribute("aria-live", "polite");

    let buttons = this._element("div", "mizu-tabsync-buttons");
    let copy = this._button("Copy pairing link", "mizu-tabsync-button", event =>
      this._copyURL(event.target)
    );
    let rotate = this._button("New token", "mizu-tabsync-button", () =>
      this._rotateToken()
    );
    let done = this._button(
      "Done",
      "mizu-tabsync-button mizu-tabsync-button-primary",
      () => this.close()
    );
    buttons.append(copy, rotate, done);

    frame.append(title, subtitle, code, details, status, buttons);
    dialog.append(frame);
    document.body.append(dialog);

    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      this.close();
    });
    dialog.addEventListener("click", event => {
      if (event.target == dialog) {
        this.close();
      }
    });
    dialog.addEventListener("close", () => this._stopWatching());

    this._dialog = dialog;
    this._qr = qr;
    this._codeError = codeError;
    this._address = address.value;
    this._token = token.value;
    this._status = status;
  },

  async open() {
    if (!this._dialog) {
      this._build();
    }
    if (!MizuTabSyncPairingLazy.MizuTabSync.enabled) {
      Services.prefs.setBoolPref("mizu.tabsync.enabled", true);
    }
    if (!this._dialog.open) {
      this._dialog.showModal();
      this._startWatching();
    }
    await this._render();
  },

  close() {
    if (this._dialog?.open) {
      this._dialog.close();
    }
  },

  _startWatching() {
    Services.obs.addObserver(
      this,
      MizuTabSyncPairingLazy.MizuTabSync.PEER_TOPIC
    );
    window.addEventListener("unload", this, { once: true });
  },

  _stopWatching() {
    try {
      Services.obs.removeObserver(
        this,
        MizuTabSyncPairingLazy.MizuTabSync.PEER_TOPIC
      );
    } catch (_) {
      // The dialog was never opened, or was already closed.
    }
    window.removeEventListener("unload", this);
  },

  /**
   * The addresses of this desktop's own network interfaces, read off the host
   * candidates a peer connection gathers.
   *
   * Resolving the desktop's host name is not enough on its own: a machine with
   * Docker or a virtual machine on it often resolves to that bridge instead of
   * the network the phone is on, or, when the name only has an IPv6 record, to
   * nothing usable at all. Gathering is local and contacts no server, and this
   * window is in the parent process, where Gecko leaves host candidates as
   * addresses rather than replacing them with mDNS names.
   *
   * @returns {Promise<string[]>}
   */
  _localAddresses() {
    let connection;
    try {
      connection = new window.RTCPeerConnection({ iceServers: [] });
    } catch (error) {
      console.error("Mizu tab sync could not enumerate local addresses", error);
      return Promise.resolve([]);
    }
    return new Promise(resolve => {
      let addresses = new Set();
      let finish = () => {
        try {
          connection.close();
        } catch (_) {}
        resolve([...addresses]);
      };
      connection.addEventListener("icecandidate", event => {
        let candidate = event.candidate;
        if (!candidate?.candidate) {
          finish();
          return;
        }
        let address = candidate.address || candidate.candidate.split(" ")[4];
        if (
          candidate.type == "host" &&
          address &&
          !address.endsWith(".local")
        ) {
          addresses.add(address);
        }
      });
      connection.createDataChannel("mizu-tabsync");
      connection
        .createOffer()
        .then(offer => connection.setLocalDescription(offer))
        .catch(finish);
      setTimeout(finish, GATHERING_TIMEOUT_MS);
    });
  },

  async _render() {
    // Addresses are resolved rather than assumed, so a slow or absent resolver
    // must not leave a stale code from a previous network on screen.
    let generation = ++this._generation;
    this._showCodeError("Working out this desktop's address…");
    let info = await MizuTabSyncPairingLazy.MizuTabSync.pairingInfo(
      await this._localAddresses()
    );
    if (generation != this._generation || !this._dialog.open) {
      return;
    }
    this._url = MizuTabSyncPairingLazy.MizuTabSync.pairingURL(info);
    // The alternates are printed too: when the first address is the wrong one
    // for the phone's network, the one to type in by hand is the next.
    this._address.textContent = info.alternates.length
      ? `${info.server} (also ${info.alternates.join(", ")})`
      : info.server || "Unknown";
    this._token.textContent = info.token;

    if (!info.server) {
      this._showCodeError(
        "Mizu could not work out an address for this desktop on this network. " +
          "Enter its private IP address and the token above on the phone instead."
      );
      this._renderStatus();
      return;
    }
    try {
      // "M" keeps the code readable at the size a phone is held at while
      // leaving room for the token, which is the bulk of what is encoded.
      let image = MizuTabSyncPairingLazy.QR.encodeToDataURI(this._url, "M");
      this._qr.src = image.src;
      this._qr.hidden = false;
      this._codeError.hidden = true;
    } catch (error) {
      console.error("Could not draw the Mizu tab sync pairing code", error);
      this._showCodeError(
        "Mizu could not draw a pairing code. Enter the address and token above " +
          "on the phone instead."
      );
    }
    this._renderStatus();
  },

  _showCodeError(message) {
    this._qr.hidden = true;
    this._qr.removeAttribute("src");
    this._codeError.textContent = message;
    this._codeError.hidden = false;
  },

  _renderStatus() {
    if (!this._dialog?.open) {
      return;
    }
    if (!MizuTabSyncPairingLazy.MizuTabSync.listening) {
      this._status.textContent = `Mizu could not listen on port ${MizuTabSyncPairingLazy.MizuTabSync.port}. Another program may be using it.`;
      return;
    }
    let peers = MizuTabSyncPairingLazy.MizuTabSync.peers;
    if (!peers.length) {
      this._status.textContent = "Waiting for a device to scan this code…";
      return;
    }
    let count = MizuTabSyncPairingLazy.MizuTabSync.sharedTabCount;
    this._status.textContent =
      `Sharing ${count} tab${count == 1 ? "" : "s"} with ` +
      peers.map(peer => peer.name).join(", ");
  },

  _copyURL(button) {
    if (!this._url) {
      return;
    }
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(this._url);
    let label = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = label), 1500);
  },

  async _rotateToken() {
    MizuTabSyncPairingLazy.MizuTabSync.rotateToken();
    await this._render();
  },
};

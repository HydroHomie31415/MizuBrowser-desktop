/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const PREF_BRANCH = "mizu.tabsync.";
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_TABS = 100;
const PEER_TTL_MS = 5 * 60 * 1000;
const PAIRING_VERSION = 1;
const ADDRESS_TIMEOUT_MS = 1500;

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

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

function isShareableURL(value) {
  try {
    let url = new URL(value);
    return url.protocol == "http:" || url.protocol == "https:";
  } catch (_) {
    return false;
  }
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

class Connection {
  constructor(owner, transport) {
    this.owner = owner;
    this.transport = transport;
    this.input = transport.openInputStream(0, 0, 0);
    this.output = transport.openOutputStream(0, 0, 0);
    this.data = "";
    this.responded = false;

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
    if (!this.responded) {
      this.reply(400, { error: "incomplete_request" });
    }
  }

  maybeHandle() {
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
      this.output.flush();
    } catch (error) {
      console.error("Mizu tab sync could not write a response", error);
    }
    try {
      this.transport.close(Cr.NS_OK);
    } catch (_) {}
  }
}

export const MizuTabSync = {
  PEER_TOPIC: "mizu-tabsync-peer",

  _initialized: false,
  _server: null,
  _peers: new Map(),

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
    Services.prefs.addObserver(PREF_BRANCH, this);
    this._updateServer();
  },

  observe(_subject, topic, data) {
    if (
      topic == "nsPref:changed" &&
      (data == `${PREF_BRANCH}enabled` || data == `${PREF_BRANCH}port`)
    ) {
      this._updateServer();
    }
  },

  _updateServer() {
    this._server?.close();
    this._server = null;
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
    if (request.path != "/v1/sync") {
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
      value?.version != 1 ||
      typeof value.deviceId != "string" ||
      !value.deviceId ||
      value.deviceId.length > 128 ||
      !Array.isArray(value.tabs)
    ) {
      connection.reply(400, { error: "invalid_payload" });
      return;
    }
    let tabs = value.tabs
      .slice(0, MAX_TABS)
      .filter(
        tab =>
          tab &&
          typeof tab.id == "string" &&
          typeof tab.url == "string" &&
          isShareableURL(tab.url)
      )
      .map(tab => ({
        id: tab.id.slice(0, 128),
        title: typeof tab.title == "string" ? tab.title.slice(0, 512) : tab.url,
        url: tab.url,
        active: Boolean(tab.active),
      }));
    this._peers.set(value.deviceId, {
      id: value.deviceId,
      name:
        typeof value.deviceName == "string"
          ? value.deviceName.slice(0, 80)
          : "Mobile device",
      updatedAt: Date.now(),
      tabs,
    });
    // The pairing dialog is waiting for exactly this: the first request a
    // scanned device makes is what proves the code was read and accepted.
    Services.obs.notifyObservers(null, this.PEER_TOPIC, value.deviceId);
    connection.reply(200, {
      version: 1,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      tabs: this.localTabs,
    });
  },

  get localTabs() {
    let tabs = [];
    for (let browserWindow of Services.wm.getEnumerator("navigator:browser")) {
      if (
        browserWindow.closed ||
        !browserWindow.gBrowser ||
        lazy.PrivateBrowsingUtils.isWindowPrivate(browserWindow)
      ) {
        continue;
      }
      for (let tab of browserWindow.gBrowser.tabs) {
        let url = tab.linkedBrowser.currentURI?.spec || "";
        if (!isShareableURL(url)) {
          continue;
        }
        tabs.push({
          id: `${tab.linkedPanel}:${tab._tPos}`,
          title: tab.label || url,
          url,
          active: tab == browserWindow.gBrowser.selectedTab,
        });
      }
    }
    return tabs.slice(0, MAX_TABS);
  },

  get remoteTabs() {
    let cutoff = Date.now() - PEER_TTL_MS;
    let tabs = [];
    for (let [id, peer] of this._peers) {
      if (peer.updatedAt < cutoff) {
        this._peers.delete(id);
        continue;
      }
      for (let tab of peer.tabs) {
        tabs.push({ ...tab, deviceName: peer.name, updatedAt: peer.updatedAt });
      }
    }
    return tabs;
  },

  get peers() {
    let cutoff = Date.now() - PEER_TTL_MS;
    let peers = [];
    for (let [id, peer] of this._peers) {
      if (peer.updatedAt < cutoff) {
        this._peers.delete(id);
        continue;
      }
      peers.push({
        id: peer.id,
        name: peer.name,
        updatedAt: peer.updatedAt,
        tabCount: peer.tabs.length,
      });
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

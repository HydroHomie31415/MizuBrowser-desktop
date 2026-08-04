/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Chrome-process half of Mizu link hints.
 *
 * The hint session itself lives in the browser window, in MizuLinkHints, since
 * it spans every frame in the tab. This actor is the relay between one frame
 * and that session, plus the one privileged action a content process cannot
 * take for itself: opening a link in a new tab.
 */
export class MizuHintsParent extends JSWindowActorParent {
  receiveMessage(message) {
    let browser = this.manager.rootFrameLoader?.ownerElement;
    let win = browser?.ownerGlobal;
    if (!win?.MizuLinkHints) {
      return undefined;
    }

    switch (message.name) {
      case "MizuHints:Dismiss":
        win.MizuLinkHints.onDismiss(browser);
        break;
      case "MizuHints:OpenLink":
        this.#openLink(win, message.data.url);
        break;
    }
    return undefined;
  }

  /**
   * Opens a hinted link in a background tab.
   *
   * Going through openLinkIn rather than synthesising a ctrl+click keeps the
   * tab's opener, container and private-browsing state correct, and keeps the
   * page from cancelling the click it never asked for.
   *
   * @param {Window} win The browser window the tab belongs to.
   * @param {string} url The link's resolved href.
   */
  #openLink(win, url) {
    let global = this.browsingContext.currentWindowGlobal;
    if (!global) {
      return;
    }

    // The child only ever sends navigable schemes, but it is content-adjacent
    // code, so the guard belongs on this side of the boundary too.
    let uri;
    try {
      uri = Services.io.newURI(url);
    } catch (_) {
      return;
    }
    if (["javascript", "data", "blob"].includes(uri.scheme)) {
      return;
    }

    win.openLinkIn(uri.spec, "tab", {
      relatedToCurrent: true,
      inBackground: true,
      triggeringPrincipal: global.documentPrincipal,
      csp: global.csp,
    });
  }
}

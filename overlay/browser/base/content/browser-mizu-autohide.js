/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Mizu's chrome column.
//
// The address bar sits at the top of the vertical tab sidebar rather than in a
// toolbar spanning the window. This is done by moving #nav-bar into
// #sidebar-container, so the two are genuinely one element rather than two
// elements positioned to look aligned -- the latter means competing with
// upstream's sidebar layout rules forever, and losing.
//
// Moving the whole toolbar rather than just the address bar keeps CustomizableUI
// intact: #nav-bar remains a registered customizable area that merely lives
// somewhere else, and its native overflow handling deals with the narrow width
// by pushing extra buttons into the overflow panel. The toolbar is moved back
// before customize mode, which needs the real layout.
//
// With the column in place the sidebar is the entire chrome, so hiding it is a
// single-element problem. browser-mizu-autohide.css slides it off-screen and
// this file slides it back while the pointer is near its window edge.
//
// Pointer tracking goes through MousePosTracker rather than :hover, because
// :hover never fires while the pointer is over remote web content -- which is
// exactly where it is whenever the column is hidden. MousePosTracker calls
// getMouseTargetRect on every mouse move, so nothing on that path may flush
// layout: window.innerWidth/innerHeight force a synchronous flush and must not
// be read there. All geometry below is cached and refreshed only on resize.

var MizuChrome = {
  PREF_BRANCH: "mizu.chrome.",

  _initialized: false,
  _columnInstalled: false,
  _active: false,
  _revealed: false,
  _pins: null,
  _hideTimer: null,
  _focusUpdateQueued: false,
  _moved: [],

  // Cached geometry. Never read layout from getMouseTargetRect.
  _windowHeight: 0,
  _windowWidth: 0,
  _columnWidth: 0,

  // Kept around the revealed column so that overshooting its edge by a few
  // pixels, or reaching diagonally for a button, does not dismiss it.
  GRACE_PX: 24,

  get _columnEnabled() {
    return (
      Services.prefs.getBoolPref(`${this.PREF_BRANCH}column`, false) &&
      Services.prefs.getBoolPref("sidebar.verticalTabs", false)
    );
  },

  get _autohideEnabled() {
    return Services.prefs.getBoolPref(`${this.PREF_BRANCH}autohide`, false);
  },

  get _triggerSize() {
    return Services.prefs.getIntPref(`${this.PREF_BRANCH}trigger-size`, 4);
  },

  get _hideDelay() {
    return Services.prefs.getIntPref(`${this.PREF_BRANCH}hide-delay-ms`, 120);
  },

  get _sidebar() {
    return document.getElementById("sidebar-container");
  },

  get _toolbox() {
    return document.getElementById("navigator-toolbox");
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this._pins = new Set();

    Services.prefs.addObserver(this.PREF_BRANCH, this);
    Services.prefs.addObserver("sidebar.verticalTabs", this);
    window.addEventListener("unload", this, { once: true });
    window.addEventListener("resize", this);
    window.addEventListener("fullscreen", this, true);
    window.addEventListener("popupshown", this, true);
    window.addEventListener("popuphidden", this, true);
    window.addEventListener("focusin", this);
    window.addEventListener("focusout", this);
    window.addEventListener("customizationstarting", this);
    window.addEventListener("aftercustomization", this);

    this.update();

    // Last, because it is a one-off repair of the toolbar's contents rather
    // than part of the column, and nothing above it should depend on it.
    this._ensureDownloadsButton();
  },

  uninit() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;

    Services.prefs.removeObserver(this.PREF_BRANCH, this);
    Services.prefs.removeObserver("sidebar.verticalTabs", this);
    window.removeEventListener("resize", this);
    window.removeEventListener("fullscreen", this, true);
    window.removeEventListener("popupshown", this, true);
    window.removeEventListener("popuphidden", this, true);
    window.removeEventListener("focusin", this);
    window.removeEventListener("focusout", this);
    window.removeEventListener("customizationstarting", this);
    window.removeEventListener("aftercustomization", this);

    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._deactivate();
    this._uninstallColumn();
  },

  // Upstream keeps a second, much shorter set of default #nav-bar placements
  // for vertical tabs, and the downloads button is not in it. Mizu turns
  // sidebar.verticalTabs on before a profile has ever been built, so that is
  // the list every new profile is created from: the button is never placed at
  // all, and since it is also what the downloads panel anchors to and what
  // carries the progress indicator, downloads have nowhere to appear.
  //
  // So place it once, and record that it has been done -- a profile that has
  // already been through this keeps whatever the user did afterwards, removing
  // the button included.
  _ensureDownloadsButton() {
    let pref = `${this.PREF_BRANCH}downloads-button-placed`;
    if (Services.prefs.getBoolPref(pref, false)) {
      return;
    }

    if (!CustomizableUI.getPlacementOfWidget("downloads-button")) {
      // Upstream orders the button just after the address bar. In the column
      // the bar wraps onto a row of its own, so this only decides where in the
      // icon row above it the button lands.
      let placements = CustomizableUI.getWidgetIdsInArea(
        CustomizableUI.AREA_NAVBAR
      );
      let urlbar = placements.indexOf("urlbar-container");
      CustomizableUI.addWidgetToArea(
        "downloads-button",
        CustomizableUI.AREA_NAVBAR,
        urlbar == -1 ? placements.length : urlbar + 1
      );
    }

    // Only once the placement has actually gone through, so that a window that
    // came up before CustomizableUI had restored the toolbar leaves the work
    // for the next one rather than marking it done.
    Services.prefs.setBoolPref(pref, true);
  },

  // Native fullscreen has its own autohide, and customize mode needs the real
  // toolbar layout, so Mizu stands down in both.
  get _suspended() {
    return (
      window.fullScreen || document.documentElement.hasAttribute("customizing")
    );
  },

  update() {
    if (this._columnEnabled && !this._suspended) {
      this._installColumn();
    } else {
      this._uninstallColumn();
    }

    document.documentElement.toggleAttribute(
      "mizu-urlbar-float",
      this._columnInstalled &&
        Services.prefs.getBoolPref(`${this.PREF_BRANCH}urlbar-float`, false)
    );

    if (this._columnInstalled && this._autohideEnabled) {
      this._activate();
    } else {
      this._deactivate();
    }
  },

  // Column layout

  _installColumn() {
    if (this._columnInstalled) {
      return;
    }
    let sidebar = this._sidebar;
    let toolbox = this._toolbox;
    let navBar = document.getElementById("nav-bar");
    let urlbar = document.getElementById("urlbar-container");
    if (!sidebar || !toolbox || !navBar || !urlbar) {
      return;
    }

    // The whole toolbox moves, rather than #nav-bar or #urlbar-container being
    // lifted out of it. Two things depend on the tree staying intact:
    //
    //   - navigator-toolbox.js delegates mousedown from #navigator-toolbox to
    //     drive the extensions, account, library, downloads, page-action,
    //     firefox-view and all-tabs buttons. Buttons moved out of the toolbox
    //     stop receiving it and silently do nothing.
    //   - The address bar only gets its breakout popover -- the large focused
    //     state -- when it can find an ancestor <toolbar>.
    //
    // The listener is on the toolbox itself, so it keeps working wherever the
    // toolbox lives.
    //
    // The address bar then moves up one level, out of #nav-bar-customization-
    // target and into #nav-bar. It has to leave the target to get a row of its
    // own -- the target is only as wide as the space the overflow and menu
    // buttons leave it -- but staying inside #nav-bar keeps both an ancestor
    // <toolbar> and the toolbox delegation, which #pageActionButton inside it
    // also depends on.
    this._moved = [];
    this._move(toolbox, sidebar, sidebar.firstChild);
    this._move(urlbar, navBar, null);

    this._columnInstalled = true;
    document.documentElement.style.setProperty(
      "--mizu-chrome-column-width",
      `${Services.prefs.getIntPref(`${this.PREF_BRANCH}column-width`, 320)}px`
    );
    document.documentElement.setAttribute("mizu-chrome-column", "true");
    this._measure();
    this._observeColumn();
  },

  _uninstallColumn() {
    if (!this._columnInstalled) {
      return;
    }
    this._columnInstalled = false;
    document.documentElement.removeAttribute("mizu-chrome-column");
    this._resizeObserver?.disconnect();

    // Reverse order, so each node's recorded next sibling is back in place
    // before it is reinserted.
    for (let { node, parent, next } of this._moved.reverse()) {
      parent.insertBefore(node, next);
    }
    this._moved = [];
  },

  _move(node, parent, before) {
    this._moved.push({
      node,
      parent: node.parentNode,
      next: node.nextSibling,
    });
    parent.insertBefore(node, before);
  },

  // Auto-hide

  _activate() {
    if (this._active) {
      return;
    }
    this._active = true;
    document.documentElement.setAttribute("mizu-chrome-autohide", "true");
    this._measure();
    MousePosTracker.addListener(this);
  },

  _deactivate() {
    if (!this._active) {
      return;
    }
    this._active = false;
    this._cancelHideTimer();
    this._pins.clear();
    MousePosTracker.removeListener(this);
    document.documentElement.removeAttribute("mizu-chrome-autohide");
    document.documentElement.removeAttribute("mizu-chrome-revealed");
    this._revealed = false;
  },

  observe(subject, topic) {
    if (topic == "nsPref:changed") {
      this.update();
    }
  },

  handleEvent(event) {
    switch (event.type) {
      case "unload":
        this.uninit();
        break;
      case "resize":
        this._measure();
        break;
      case "fullscreen":
        // window.fullScreen is not necessarily updated yet while the event is
        // being dispatched, and _suspended reads it.
        Services.tm.dispatchToMainThread(() => this.update());
        break;
      case "customizationstarting":
      case "aftercustomization":
        this.update();
        break;
      case "popupshown":
      case "popuphidden":
        this._onPopupChanged(event);
        break;
      case "focusin":
      case "focusout":
        this._onFocusChanged();
        break;
    }
  },

  contains(node) {
    let sidebar = this._sidebar;
    return !!(node && sidebar && sidebar.contains(node));
  },

  // A panel anchored inside the column has to bring it on screen and keep it
  // there, or the panel hangs off an anchor that is not where it appears to
  // be. Most of the time the column is already revealed, because the click
  // that opened the panel happened in it -- but a panel can also open on its
  // own, and the downloads panel opening as a download starts is the case that
  // matters: it is anchored to a button that is currently a column-width
  // off-screen. Arrow panels follow their anchor, so revealing the column
  // after the panel is shown slides the panel into place along with it.
  //
  // Tooltips and tab previews are transient and deliberately excluded,
  // matching FullScreen._setPopupOpen. Panels are often reparented to the
  // document root, so the anchor is checked rather than the panel itself.
  _onPopupChanged(event) {
    let popup = event.originalTarget;
    if (
      !this._active ||
      !popup ||
      popup.localName == "tooltip" ||
      popup.id == "tab-preview-panel"
    ) {
      return;
    }
    if (event.type == "popupshown") {
      if (this.contains(popup.anchorNode || popup.triggerNode)) {
        this._pin("popup");
        this._reveal();
      }
    } else {
      this._unpin("popup");
    }
  },

  // Focus is what makes Ctrl+L, F6 and tab-key navigation work: focusing the
  // address bar reveals the column and holds it open until focus leaves.
  //
  // activeElement has not settled while focusin/focusout are being dispatched,
  // so the decision is deferred to the next turn, by which point focus has
  // landed. Coalescing also collapses the focusout/focusin pair that every
  // focus move produces into a single update.
  _onFocusChanged() {
    if (this._focusUpdateQueued) {
      return;
    }
    this._focusUpdateQueued = true;
    Services.tm.dispatchToMainThread(() => {
      this._focusUpdateQueued = false;
      if (!this._active) {
        return;
      }
      if (this.contains(document.activeElement)) {
        this._pin("focus");
        this._reveal();
      } else {
        this._unpin("focus");
      }
    });
  },

  _pin(reason) {
    this._pins.add(reason);
    this._cancelHideTimer();
  },

  _unpin(reason) {
    if (this._pins.delete(reason) && !this._pins.size && !this._hover) {
      this._scheduleHide();
    }
  },

  _reveal() {
    this._cancelHideTimer();
    this._setRevealed(true);
  },

  _collapse() {
    if (this._pins.size) {
      return;
    }
    this._setRevealed(false);
  },

  _setRevealed(revealed) {
    if (revealed == this._revealed) {
      return;
    }
    this._revealed = revealed;
    document.documentElement.toggleAttribute("mizu-chrome-revealed", revealed);

    if (!revealed) {
      // MousePosTracker only re-evaluates on pointer events. A collapse driven
      // by a timer or by losing a pin can therefore leave a stale _hover, which
      // would swallow the next genuine enter. Re-registering resets it.
      MousePosTracker.removeListener(this);
      MousePosTracker.addListener(this);
    }
  },

  _scheduleHide() {
    this._cancelHideTimer();
    let delay = this._hideDelay;
    if (!delay) {
      this._collapse();
      return;
    }
    this._hideTimer = setTimeout(() => {
      this._hideTimer = null;
      this._collapse();
    }, delay);
  },

  _cancelHideTimer() {
    if (this._hideTimer) {
      clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }
  },

  // Reads geometry without forcing a synchronous flush. Runs on install,
  // resize and sidebar resize -- never per mouse move.
  _measure() {
    let utils = window.windowUtils;
    let root = utils.getBoundsWithoutFlushing(document.documentElement);
    this._windowWidth = root.width;
    this._windowHeight = root.height;

    let sidebar = this._sidebar;
    if (sidebar) {
      // Width is unaffected by the translate that hides the column, unlike
      // left/top, so it is safe to read while collapsed.
      let width = utils.getBoundsWithoutFlushing(sidebar).width;
      if (width) {
        this._columnWidth = width;
      }
    }
  },

  // The sidebar changes width when it is expanded, collapsed or dragged, and
  // the reveal target has to follow. Observing is far cheaper than polling
  // geometry, and never flushes layout.
  _observeColumn() {
    if (!this._resizeObserver) {
      this._resizeObserver = new ResizeObserver(() => this._measure());
    }
    this._resizeObserver.disconnect();
    let sidebar = this._sidebar;
    if (sidebar) {
      this._resizeObserver.observe(sidebar);
    }
  },

  // The column sits at the inline start, which is the right-hand screen edge
  // under RTL, and Firefox can also move the sidebar to the opposite side.
  get _atScreenStart() {
    let positionStart = Services.prefs.getBoolPref(
      "sidebar.position_start",
      true
    );
    let rtl = document.documentElement.matches(":dir(rtl)");
    return positionStart != rtl;
  },

  getMouseTargetRect() {
    // While revealed the target is the column itself, so the pointer leaving it
    // is what dismisses it; while collapsed it is a thin strip at the edge.
    let band = this._revealed
      ? this._columnWidth + this.GRACE_PX
      : this._triggerSize;

    return this._atScreenStart
      ? { top: 0, bottom: this._windowHeight, left: 0, right: band }
      : {
          top: 0,
          bottom: this._windowHeight,
          left: this._windowWidth - band,
          right: this._windowWidth,
        };
  },

  onMouseEnter() {
    this._reveal();
  },

  onMouseLeave() {
    if (this._pins.size) {
      return;
    }
    this._scheduleHide();
  },
};

// delayed-startup runs once per browser window, after gURLBar, SidebarController
// and the toolbox are all in place.
Services.obs.addObserver(function onDelayedStartup(subject) {
  if (subject !== window) {
    return;
  }
  Services.obs.removeObserver(
    onDelayedStartup,
    "browser-delayed-startup-finished"
  );
  MizuChrome.init();
}, "browser-delayed-startup-finished");

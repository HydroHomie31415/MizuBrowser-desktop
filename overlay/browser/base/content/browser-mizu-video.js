/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

var MizuVideoPlayer = {
  WIDGET_ID: "mizu-video-player-button",
  PREF_BRANCH: "mizu.video.",

  _initialized: false,
  _states: new WeakMap(),

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    // getWidget() answers for unknown ids too, by synthesising a wrapper for a
    // XUL node that does not exist, so it can never report that the widget is
    // missing. Asking who provides it is the question that has a real answer.
    if (
      CustomizableUI.getWidget(this.WIDGET_ID)?.provider !=
      CustomizableUI.PROVIDER_API
    ) {
      CustomizableUI.createWidget({
        id: this.WIDGET_ID,
        type: "button",
        defaultArea: CustomizableUI.AREA_NAVBAR,
        label: "Mizu Video Player",
        tooltiptext: "Open the playing video in Mizu Video Player",
        onCommand(event) {
          event.target.ownerGlobal.MizuVideoPlayer.open();
        },
      });
    }

    window.addEventListener("unload", this, { once: true });
    window.addEventListener("keydown", this, true);
    gBrowser.tabContainer.addEventListener("TabSelect", this);
    gBrowser.addTabsProgressListener(this);
    this._installContextMenu();
    this._updateButton();
  },

  uninit() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;
    window.removeEventListener("keydown", this, true);
    gBrowser.tabContainer.removeEventListener("TabSelect", this);
    gBrowser.removeTabsProgressListener(this);
  },

  handleEvent(event) {
    switch (event.type) {
      case "unload":
        this.uninit();
        break;
      case "TabSelect":
        this._updateButton();
        break;
      case "keydown":
        if (
          event.altKey &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          event.code == "KeyV"
        ) {
          event.preventDefault();
          this.open();
        }
        break;
    }
  },

  onLocationChange(browser) {
    this._states.delete(browser);
    if (browser == gBrowser.selectedBrowser) {
      this._updateButton();
    }
  },

  onActorState(browser, contextId, state) {
    if (!browser) {
      return;
    }
    let states = this._states.get(browser);
    if (!states) {
      states = new Map();
      this._states.set(browser, states);
    }
    states.set(contextId, state);
    if (browser == gBrowser.selectedBrowser) {
      this._updateButton();
    }
  },

  onActorDestroyed(browser, contextId) {
    this._states.get(browser)?.delete(contextId);
    if (browser == gBrowser.selectedBrowser) {
      this._updateButton();
    }
  },

  async open(target = null) {
    let settings = this._settings();
    let candidates = [];

    if (target) {
      candidates.push(target);
    } else {
      for (let context of this._contexts(
        gBrowser.selectedBrowser.browsingContext
      )) {
        try {
          let actor = context.currentWindowGlobal?.getActor("MizuVideo");
          if (!actor) {
            continue;
          }
          let status = await actor.sendQuery("MizuVideo:GetStatus");
          if (status.hasVideo) {
            candidates.push({ actor, status });
          }
        } catch (_) {}
      }
      candidates.sort(
        (a, b) =>
          Number(b.status.playing) - Number(a.status.playing) ||
          b.status.area - a.status.area
      );
    }

    if (!candidates.length) {
      Services.prompt.alert(
        window,
        "Mizu Video Player",
        "No video was found in this tab. Start a video and try again."
      );
      return;
    }

    try {
      await candidates[0].actor.sendQuery("MizuVideo:Open", {
        settings,
        targetIdentifier: candidates[0].targetIdentifier ?? null,
      });
    } catch (error) {
      console.error("Could not open Mizu Video Player", error);
      Services.prompt.alert(
        window,
        "Mizu Video Player",
        "The video changed while the player was opening. Please try again."
      );
    }
  },

  _contexts(root) {
    let contexts = [];
    let pending = [root];
    while (pending.length) {
      let context = pending.shift();
      contexts.push(context);
      pending.push(...context.children);
    }
    return contexts;
  },

  _settings() {
    let int = (name, fallback) =>
      Services.prefs.getIntPref(`${this.PREF_BRANCH}${name}`, fallback);
    let bool = (name, fallback) =>
      Services.prefs.getBoolPref(`${this.PREF_BRANCH}${name}`, fallback);
    let string = (name, fallback) =>
      Services.prefs.getStringPref(`${this.PREF_BRANCH}${name}`, fallback);

    return {
      seekBackward: int("seek-backward-seconds", 10),
      seekForward: int("seek-forward-seconds", 10),
      volumeStep: int("volume-step-percent", 5) / 100,
      controlsTimeout: int("controls-timeout-ms", 2500),
      arrowKeys: bool("arrow-keys", true),
      spaceKey: bool("space-key", true),
      mediaKeys: bool("media-keys", true),
      captureKeys: bool("capture-keys", true),
      preferredQuality: int("preferred-quality", 1080),
      subtitleScale: int("subtitle-scale-percent", 100) / 100,
      subtitleColour: string("subtitle-colour", "white"),
      subtitleBackground: string("subtitle-background", "soft"),
      subtitleEdge: string("subtitle-edge", "outline"),
      subtitleFont: string("subtitle-font", "sans"),
      subtitlePosition: int("subtitle-position-percent", 8),
      anime4k: bool("anime4k-enabled", false),
      anime4kMode: string("anime4k-mode", "a"),
      anime4kQuality: string("anime4k-quality", "M"),
      anime4kStrength: int("anime4k-strength-percent", 100) / 100,
      anime4kMaxSourceHeight: int("anime4k-max-source-height", 1080),
      anime4kMaxOutputScale: int("anime4k-max-output-scale", 4),
      anime4kFrameRateLimit: int("anime4k-frame-rate-limit", 0),
      anime4kAdaptive: bool("anime4k-adaptive", true),
      anime4kStats: bool("anime4k-stats", false),
      anime4kExtras: string("anime4k-extras", "")
        .split(",")
        .filter(entry => entry.length),
    };
  },

  _updateButton() {
    let button = CustomizableUI.getWidget(this.WIDGET_ID)?.forWindow(
      window
    )?.node;
    if (!button) {
      return;
    }
    let states = this._states.get(gBrowser.selectedBrowser);
    let hasVideo = [...(states?.values() ?? [])].some(state => state.hasVideo);
    let playing = [...(states?.values() ?? [])].some(state => state.playing);
    button.toggleAttribute("mizu-video-available", hasVideo);
    button.toggleAttribute("mizu-video-playing", playing);
    let tooltip = "No video detected in this tab";
    if (playing) {
      tooltip = "Open the playing video in Mizu Video Player";
    } else if (hasVideo) {
      tooltip = "Open this tab's video in Mizu Video Player";
    }
    button.setAttribute("tooltiptext", tooltip);
  },

  _installContextMenu() {
    let popup = document.getElementById("contentAreaContextMenu");
    let before = document.getElementById("context-media-play");
    if (!popup || !before || document.getElementById("context-mizu-video")) {
      return;
    }

    let item = document.createXULElement("menuitem");
    item.id = "context-mizu-video";
    item.setAttribute("label", "Open in Mizu Video Player");
    item.hidden = true;
    item.addEventListener("command", () => {
      let context = gContextMenu.frameBrowsingContext;
      let actor = context?.currentWindowGlobal?.getActor("MizuVideo");
      if (actor) {
        this.open({ actor, targetIdentifier: gContextMenu.targetIdentifier });
      }
    });
    popup.insertBefore(item, before);
    popup.addEventListener("popupshowing", () => {
      item.hidden = !gContextMenu?.onVideo;
    });
  },
};

// DOMContentLoaded is too early: gBrowser does not exist yet, so init() threw
// and the toolbar button, context menu item and shortcut were never installed.
Services.obs.addObserver(function onDelayedStartup(subject) {
  if (subject !== window) {
    return;
  }
  Services.obs.removeObserver(
    onDelayedStartup,
    "browser-delayed-startup-finished"
  );
  MizuVideoPlayer.init();
}, "browser-delayed-startup-finished");

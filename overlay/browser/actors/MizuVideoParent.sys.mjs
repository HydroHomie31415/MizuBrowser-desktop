/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const SETTINGS = new Map([
  ["seek-backward-seconds", { type: "int", min: 1, max: 120 }],
  ["seek-forward-seconds", { type: "int", min: 1, max: 120 }],
  ["volume-step-percent", { type: "int", min: 1, max: 50 }],
  ["controls-timeout-ms", { type: "int", min: 500, max: 10000 }],
  ["arrow-keys", { type: "bool" }],
  ["space-key", { type: "bool" }],
  ["media-keys", { type: "bool" }],
  ["capture-keys", { type: "bool" }],
  ["anime4k-enabled", { type: "bool" }],
  ["anime4k-mode", { type: "string", values: /^[a-z+]{1,4}$/ }],
  ["anime4k-quality", { type: "string", values: /^[SML]$/ }],
  ["anime4k-strength-percent", { type: "int", min: 0, max: 100 }],
  ["anime4k-max-source-height", { type: "int", min: 0, max: 4320 }],
  ["anime4k-max-output-scale", { type: "int", min: 0, max: 8 }],
  ["anime4k-frame-rate-limit", { type: "int", min: 0, max: 240 }],
  ["anime4k-adaptive", { type: "bool" }],
  ["anime4k-stats", { type: "bool" }],
  ["anime4k-extras", { type: "string", values: /^[a-z,]{0,64}$/ }],
  ["preferred-quality", { type: "int", min: 0, max: 4320 }],
  ["subtitle-scale-percent", { type: "int", min: 50, max: 250 }],
  [
    "subtitle-colour",
    { type: "string", values: /^(white|yellow|cyan|green)$/ },
  ],
  ["subtitle-background", { type: "string", values: /^(none|soft|solid)$/ }],
  ["subtitle-edge", { type: "string", values: /^(none|outline|shadow)$/ }],
  ["subtitle-font", { type: "string", values: /^(sans|serif|mono)$/ }],
  ["subtitle-position-percent", { type: "int", min: 0, max: 40 }],
  ["subtitles-auto", { type: "bool" }],
  ["subtitle-language", { type: "string", values: /^[a-z]{0,8}$/ }],
]);

const AUTO_STATES = new WeakMap();
const AUTO_OPENED = new WeakSet();
const AUTO_OPENING = new WeakSet();

/**
 * Chrome-process half of the Mizu video player: it owns the preferences and
 * brokers the frame-tree work the content process is not allowed to do itself.
 */
export class MizuVideoParent extends JSWindowActorParent {
  receiveMessage(message) {
    let browser =
      this.browsingContext.top.embedderElement ??
      this.manager.rootFrameLoader?.ownerElement;
    let win = browser?.ownerGlobal;

    switch (message.name) {
      case "MizuVideo:State":
        this.#autoOpen(browser, message.data);
        win?.MizuVideoPlayer?.onActorState(
          browser,
          this.browsingContext.id,
          message.data
        );
        break;
      case "MizuVideo:SetSetting":
        this.#setSetting(message.data);
        break;
      case "MizuVideo:FullscreenEmbedder":
        return promoteFrame(this.browsingContext);
      case "MizuVideo:ExitEmbedderFullscreen":
        return exitAncestorFullscreen(this.browsingContext);
      case "MizuVideo:GuardAncestors":
        return guardAncestors(this.browsingContext, message.data.guard);
    }
    return undefined;
  }

  didDestroy() {
    let browser =
      this.browsingContext.top.embedderElement ??
      this.manager.rootFrameLoader?.ownerElement;
    browser?.ownerGlobal?.MizuVideoPlayer?.onActorDestroyed(
      browser,
      this.browsingContext.id
    );
    let states = AUTO_STATES.get(browser);
    states?.delete(this.browsingContext.id);
    if (!states?.size) {
      AUTO_STATES.delete(browser);
      AUTO_OPENED.delete(browser);
      AUTO_OPENING.delete(browser);
    }
  }

  #autoOpen(browser, state) {
    if (!browser) {
      return;
    }
    let states = AUTO_STATES.get(browser);
    if (!states) {
      states = new Map();
      AUTO_STATES.set(browser, states);
    }
    states.set(this.browsingContext.id, state);
    let values = [...states.values()];
    if (values.some(value => value.playerOpen)) {
      AUTO_OPENED.add(browser);
      return;
    }
    if (!values.some(value => value.playing)) {
      AUTO_OPENED.delete(browser);
      return;
    }
    let win = browser.ownerGlobal;
    if (
      !state.playing ||
      browser != win?.gBrowser?.selectedBrowser ||
      AUTO_OPENED.has(browser) ||
      AUTO_OPENING.has(browser) ||
      !Services.prefs.getBoolPref("mizu.video.auto-open", true) ||
      autoOpenExcluded(browser.currentURI?.spec)
    ) {
      return;
    }
    AUTO_OPENING.add(browser);
    AUTO_OPENED.add(browser);
    this.sendQuery("MizuVideo:Open", {
      settings: videoSettings(),
      targetIdentifier: null,
    })
      .catch(() => AUTO_OPENED.delete(browser))
      .finally(() => AUTO_OPENING.delete(browser));
  }

  #setSetting({ name, value }) {
    let definition = SETTINGS.get(name);
    if (!definition) {
      return;
    }

    let pref = `mizu.video.${name}`;
    if (definition.type == "bool" && typeof value == "boolean") {
      Services.prefs.setBoolPref(pref, value);
    } else if (
      definition.type == "int" &&
      Number.isInteger(value) &&
      value >= definition.min &&
      value <= definition.max
    ) {
      Services.prefs.setIntPref(pref, value);
    } else if (
      definition.type == "string" &&
      typeof value == "string" &&
      definition.values.test(value)
    ) {
      Services.prefs.setStringPref(pref, value);
    }
  }
}

function videoSettings() {
  let int = (name, fallback) =>
    Services.prefs.getIntPref(`mizu.video.${name}`, fallback);
  let bool = (name, fallback) =>
    Services.prefs.getBoolPref(`mizu.video.${name}`, fallback);
  let string = (name, fallback) =>
    Services.prefs.getStringPref(`mizu.video.${name}`, fallback);
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
    subtitlesAuto: bool("subtitles-auto", true),
    subtitleLanguage: string("subtitle-language", "en"),
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
}

function autoOpenExcluded(spec) {
  let url;
  try {
    url = new URL(spec);
  } catch (_) {
    return true;
  }
  let host = url.hostname.toLowerCase();
  if (
    /(^|\.)youtube(?:-nocookie)?\.com$/.test(host) ||
    /(^|\.)netflix\.com$/.test(host) ||
    /(^|\.)primevideo\.com$/.test(host)
  ) {
    return true;
  }
  return (
    /(^|\.)amazon\.[a-z.]+$/.test(host) &&
    /^\/(?:gp\/video|prime-video|amazon-video|video)\b/i.test(url.pathname)
  );
}

/**
 * Fullscreens the nearest ancestor frame that is allowed to go fullscreen.
 *
 * A player inside a third-party embed cannot promote itself when the embedding
 * page left `allowfullscreen` off the iframe. Each embedder is asked in turn,
 * outwards, until one succeeds; the request is same-document there, so the
 * feature policy that blocked the inner frame does not apply.
 *
 * @param {BrowsingContext} context The frame that wants to be fullscreen.
 * @returns {Promise<boolean>} Whether any ancestor was promoted.
 */
async function promoteFrame(context) {
  let parent = context.parent;
  if (!parent) {
    return false;
  }
  let actor = parent.currentWindowGlobal?.getActor("MizuVideo");
  if (actor) {
    try {
      await actor.sendQuery("MizuVideo:FullscreenFrame", {
        childId: context.id,
      });
      return true;
    } catch (_) {}
  }
  return promoteFrame(parent);
}

/**
 * Undoes {@link promoteFrame}.
 *
 * @param {BrowsingContext} context The frame that asked to be fullscreen.
 * @returns {Promise<boolean>} Whether an ancestor left fullscreen.
 */
async function exitAncestorFullscreen(context) {
  for (let parent = context.parent; parent; parent = parent.parent) {
    let actor = parent.currentWindowGlobal?.getActor("MizuVideo");
    try {
      if (await actor?.sendQuery("MizuVideo:ExitFrameFullscreen")) {
        return true;
      }
    } catch (_) {}
  }
  return false;
}

/**
 * Installs or removes the fullscreen-event guard in every ancestor document of
 * a frame that is hosting the player.
 *
 * The player can only silence the document it lives in. When it lives in an
 * embed, the pages above it see the fullscreen change too and some of them act
 * on it, so they have to be asked directly.
 *
 * @param {BrowsingContext} context The frame hosting the player.
 * @param {boolean} guard Whether to install or remove the guard.
 * @returns {Promise<boolean>} True once every reachable ancestor has answered.
 */
async function guardAncestors(context, guard) {
  for (let parent = context.parent; parent; parent = parent.parent) {
    let actor = parent.currentWindowGlobal?.getActor("MizuVideo");
    try {
      await actor?.sendQuery("MizuVideo:GuardFullscreen", { guard });
    } catch (_) {}
  }
  return true;
}

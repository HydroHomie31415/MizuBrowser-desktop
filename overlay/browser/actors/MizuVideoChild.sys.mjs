/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ContentDOMReference } from "resource://gre/modules/ContentDOMReference.sys.mjs";
import { Anime4KRenderer } from "resource:///actors/Anime4KRenderer.sys.mjs";
import {
  MizuMediaBridge,
  preferredLevel,
} from "resource:///actors/MizuMediaBridge.sys.mjs";
import {
  EXTRAS,
  MODES,
  QUALITY_TIERS,
} from "resource:///actors/Anime4KLibrary.sys.mjs";

const PLAYER_ID = "mizu-video-player-host";

/** Every spelling of the fullscreen events a page might still be listening for. */
const FULLSCREEN_EVENTS = [
  "fullscreenchange",
  "fullscreenerror",
  "mozfullscreenchange",
  "mozfullscreenerror",
  "webkitfullscreenchange",
  "webkitfullscreenerror",
];

/**
 * Finds videos in a document and hosts the Mizu player over the one the user
 * picked.
 */
export class MizuVideoChild extends JSWindowActorChild {
  actorCreated() {
    this._player = null;
    this._stateTimer = null;
    this._destroyed = false;
    this._observer = new this.contentWindow.MutationObserver(() =>
      this._scheduleState()
    );
    this._shortsPrefObserver = () => this._applyYouTubePolicy(true);
    Services.prefs.addObserver(
      "mizu.youtube.remove-shorts",
      this._shortsPrefObserver
    );
    this._youtubeMiniPlayerKeyDown = event =>
      this._onYouTubeMiniPlayerKeyDown(event);
    this.contentWindow.addEventListener(
      "keydown",
      this._youtubeMiniPlayerKeyDown,
      true
    );
    this._observeDocument();
  }

  didDestroy() {
    this._destroyed = true;
    this._fullscreenGuard = null;
    Services.prefs.removeObserver(
      "mizu.youtube.remove-shorts",
      this._shortsPrefObserver
    );
    this.contentWindow?.removeEventListener(
      "keydown",
      this._youtubeMiniPlayerKeyDown,
      true
    );
    this._observer?.disconnect();
    this._player?.close();
    this._player = null;
  }

  handleEvent(event) {
    if (event.type == "pageshow" || event.type == "DOMContentLoaded") {
      this._observeDocument();
    }
    this._scheduleState();
  }

  receiveMessage(message) {
    switch (message.name) {
      case "MizuVideo:GetStatus":
        return this._status();
      case "MizuVideo:Open":
        return this._open(message.data);
      case "MizuVideo:FullscreenFrame":
        return this._fullscreenFrame(message.data);
      case "MizuVideo:ExitFrameFullscreen":
        return this._exitFrameFullscreen();
      case "MizuVideo:GuardFullscreen":
        return this._guardFullscreen(message.data.guard);
    }
    throw new Error(`Unexpected Mizu video message: ${message.name}`);
  }

  _observeDocument() {
    this._observer?.disconnect();
    let root = this.document.documentElement;
    if (root) {
      this._observer.observe(root, { childList: true, subtree: true });
    }
    this._applyYouTubePolicy();
    this._scheduleState();
  }

  /** Removes Shorts entry points and turns direct Shorts URLs into watch URLs. */
  _applyYouTubePolicy(prefChanged = false) {
    let window = this.contentWindow;
    let document = this.document;
    if (!window || !/(^|\.)youtube\.com$/.test(window.location.hostname)) {
      return;
    }
    let enabled = Services.prefs.getBoolPref(
      "mizu.youtube.remove-shorts",
      true
    );
    let style = document.getElementById("mizu-remove-youtube-shorts");
    if (!enabled) {
      style?.remove();
      return;
    }

    let match = /^\/shorts\/([A-Za-z0-9_-]{6,})/.exec(window.location.pathname);
    if (match && !this._shortsRedirecting) {
      this._shortsRedirecting = true;
      let url = new window.URL(window.location.href);
      url.pathname = "/watch";
      url.searchParams.set("v", match[1]);
      window.location.replace(url.href);
      return;
    }

    if (!style && document.documentElement) {
      style = document.createElement("style");
      style.id = "mizu-remove-youtube-shorts";
      style.textContent = YOUTUBE_SHORTS_STYLES;
      document.documentElement.appendChild(style);
    } else if (prefChanged && style) {
      // Re-appending also repairs a style element removed by a page refresh.
      document.documentElement?.appendChild(style);
    }
  }

  /** Lets bare left/right arrows seek YouTube's in-page miniplayer. */
  _onYouTubeMiniPlayerKeyDown(event) {
    if (
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      (event.code != "ArrowLeft" && event.code != "ArrowRight") ||
      this._player ||
      !/(^|\.)youtube\.com$/.test(this.contentWindow.location.hostname)
    ) {
      return;
    }
    let target = event.composedPath()[0] ?? event.target;
    if (
      target?.matches?.(
        "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]"
      )
    ) {
      return;
    }

    let player = this.document.querySelector(
      "#movie_player.ytp-player-minimized"
    );
    let miniplayer = this.document.querySelector(
      "ytd-miniplayer[active], ytd-miniplayer.ytdMiniplayerComponentVisible"
    );
    if (!player && !miniplayer) {
      return;
    }
    let video =
      player?.querySelector("video") ?? miniplayer?.querySelector("video");
    if (!video) {
      return;
    }

    let forward = event.code == "ArrowRight";
    let seconds = Math.min(
      120,
      Math.max(
        1,
        Services.prefs.getIntPref(
          `mizu.video.seek-${forward ? "forward" : "backward"}-seconds`,
          10
        )
      )
    );
    let minimum = 0;
    let maximum = video.duration;
    if (!Number.isFinite(maximum)) {
      if (!video.seekable.length) {
        return;
      }
      minimum = video.seekable.start(0);
      maximum = video.seekable.end(video.seekable.length - 1);
    }
    let destination = video.currentTime + (forward ? seconds : -seconds);
    video.currentTime = Math.max(minimum, Math.min(maximum, destination));
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  _videos() {
    return [...this.document.querySelectorAll("video")].filter(
      video => video.id != PLAYER_ID
    );
  }

  _bestVideo() {
    return this._videos().sort((a, b) => this._score(b) - this._score(a))[0];
  }

  _score(video) {
    let rect = video.getBoundingClientRect();
    let area = Math.max(0, rect.width) * Math.max(0, rect.height);
    return area + (!video.paused && !video.ended ? 1_000_000_000 : 0);
  }

  _status() {
    let video = this._bestVideo();
    if (!video) {
      return { hasVideo: false, playing: false, area: 0 };
    }
    let rect = video.getBoundingClientRect();
    return {
      hasVideo: true,
      playing: !video.paused && !video.ended && video.readyState >= 2,
      area: Math.round(Math.max(0, rect.width) * Math.max(0, rect.height)),
      duration: Number.isFinite(video.duration) ? video.duration : 0,
    };
  }

  _scheduleState() {
    if (this._stateTimer || this._destroyed || !this.contentWindow) {
      return;
    }
    this._stateTimer = this.contentWindow.setTimeout(() => {
      this._stateTimer = null;
      // JSWindowActorChild has no "is this still alive" accessor, so the flag
      // set by didDestroy stands in for one; without it every timer that
      // outlived its actor threw and the toolbar button stopped updating.
      if (!this._destroyed) {
        this._applyYouTubePolicy();
        this.sendAsyncMessage("MizuVideo:State", this._status());
      }
    }, 100);
  }

  _open({ settings, targetIdentifier }) {
    let video = targetIdentifier
      ? ContentDOMReference.resolve(targetIdentifier)
      : this._bestVideo();
    if (!this.contentWindow.HTMLVideoElement.isInstance(video)) {
      throw new Error("The selected video is no longer available");
    }

    this._player?.close();
    this._player = new Player(this, video, settings);
    this._player.open();
    return true;
  }

  /**
   * Fullscreens the `<iframe>` that embeds a descendant frame.
   *
   * A player running inside a third-party embed cannot fullscreen itself when
   * the embedding page left `allowfullscreen` off its iframe. The parent actor
   * walks up the frame tree and asks each embedder in turn to do it instead,
   * which is permitted because the request is then same-document.
   *
   * @param {object} data The request.
   * @param {number} data.childId Id of the descendant browsing context whose
   *   embedding element should be promoted.
   */
  async _fullscreenFrame({ childId }) {
    let child = this.browsingContext.children.find(
      context => context.id == childId
    );
    let frame = child?.embedderElement;
    if (!frame) {
      throw new Error("The embedding frame is no longer available");
    }
    // Feature policy is inherited from the embedder, so the flag has to be on
    // the element before the request rather than after it.
    frame.setAttribute("allowfullscreen", "");
    frame.allowFullscreen = true;
    await frame.requestFullscreen();
    return true;
  }

  /**
   * Hides fullscreen transitions from this document's own scripts.
   *
   * Gecko makes the embedding `<iframe>` the fullscreen element of every
   * ancestor document, which those documents' players notice. Streaming sites
   * built on the MegaPlay embed react by moving fullscreen onto a wrapper of
   * their own a moment later; the embed then stops being the fullscreen element
   * while the player inside it still believes it is, and the result is a black
   * screen. Swallowing the event before any page listener sees it leaves the
   * fullscreen where the user put it.
   *
   * @param {boolean} guard Whether to install or remove the guard.
   * @returns {boolean} Always true, so the caller can await the round trip.
   */
  _guardFullscreen(guard) {
    if (!guard) {
      for (let type of FULLSCREEN_EVENTS) {
        this.contentWindow?.removeEventListener(
          type,
          this._fullscreenGuard,
          true
        );
      }
      this._fullscreenGuard = null;
      return true;
    }
    if (this._fullscreenGuard || !this.contentWindow) {
      return true;
    }
    this._fullscreenGuard = event => event.stopImmediatePropagation();
    for (let type of FULLSCREEN_EVENTS) {
      this.contentWindow.addEventListener(type, this._fullscreenGuard, true);
    }
    return true;
  }

  /**
   * Leaves a fullscreen state this document entered on a descendant's behalf.
   *
   * @returns {Promise<boolean>} Whether anything was fullscreen to leave.
   */
  async _exitFrameFullscreen() {
    if (!this.document.fullscreenElement) {
      return false;
    }
    await this.document.exitFullscreen();
    return true;
  }
}

/**
 * The player itself: a closed shadow root hosting the page's own `<video>`.
 *
 * Everything here has to survive a hostile document. Sites re-parent their
 * video elements, restyle them, and run their own fullscreen bookkeeping on
 * events they expect only their player to fire, so the player reclaims the
 * video when it is taken and keeps its fullscreen changes to itself.
 */
class Player {
  constructor(actor, video, settings) {
    this.actor = actor;
    this.window = actor.contentWindow;
    this.document = actor.document;
    this.video = video;
    this.settings = settings;
    this.host = null;
    this.root = null;
    this.canvas = null;
    this.anime4k = null;
    this.hideTimer = null;
    this.original = null;
    this.closed = false;
    this.reclaiming = false;
    this.listeners = [];
    this.guard = null;
    this.bridge = null;
    this.textTrack = null;
    this.mediaTimer = null;
    this.qualityApplied = "";
    this.chapters = [];
    this.playlistState = { available: false, previous: false, next: false };
    this.pageCaptions = null;
    this._boundVideoUpdate = () => this._updateControls();
    this._boundCueUpdate = () => this._renderCues();
  }

  open() {
    let doc = this.document;
    this.original = {
      parent: this.video.parentNode,
      next: this.video.nextSibling,
      style: this.video.getAttribute("style"),
      slot: this.video.getAttribute("slot"),
      controls: this.video.hasAttribute("controls"),
    };

    this.host = doc.createElement("div");
    this.host.id = PLAYER_ID;
    this.host.tabIndex = -1;
    doc.documentElement.appendChild(this.host);
    this.host.appendChild(this.video);
    this.video.setAttribute("slot", "video");
    this.video.removeAttribute("controls");
    this.root = this.host.attachShadow({ mode: "closed" });
    // The markup is a static, product-owned string with no page data.
    // eslint-disable-next-line no-unsanitized/property
    this.root.innerHTML = this._markup();
    this.canvas = this.root.querySelector("canvas");
    this._configureSettings();
    this._listen();
    this._watchDocument();
    this.bridge = new MizuMediaBridge(this.video, this.window);
    this._updateControls();
    this._applySubtitleStyle();
    this._pollMedia();
    this.host.focus();
    this._showControls();
    this._guardAncestors(true);

    if (this.settings.anime4k) {
      this._setAnime4K(true);
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this._guardAncestors(false);
    this.window.clearTimeout(this.hideTimer);
    this.window.clearInterval(this.mediaTimer);
    this._watchTextTrack(null);
    this._releasePageCaptions();
    this._stopAnime4K();
    this.guard?.disconnect();
    for (let { target, type, handler, capture } of this.listeners) {
      target.removeEventListener(type, handler, capture);
    }
    this.listeners = [];

    if (this.document.fullscreenElement == this.host) {
      this.document.exitFullscreen().catch(() => {});
    }

    if (this.original.parent?.isConnected) {
      this.original.parent.insertBefore(this.video, this.original.next);
    } else {
      this.document.documentElement.appendChild(this.video);
    }
    this._restoreAttribute("style", this.original.style);
    this._restoreAttribute("slot", this.original.slot);
    this.video.toggleAttribute("controls", this.original.controls);
    this.host?.remove();
    this.actor._player = null;
    this.actor._scheduleState();
  }

  /**
   * Asks the pages above an embedded player to ignore fullscreen changes.
   *
   * This lasts as long as the player does rather than only while fullscreen:
   * the ancestor's handler runs within a frame of the request resolving, which
   * is far too soon to install the guard from here.
   */
  _guardAncestors(guard) {
    if (this.actor.browsingContext == this.actor.browsingContext.top) {
      return;
    }
    this.actor.sendQuery("MizuVideo:GuardAncestors", { guard }).catch(() => {});
  }

  _restoreAttribute(name, value) {
    if (value === null) {
      this.video.removeAttribute(name);
    } else {
      this.video.setAttribute(name, value);
    }
  }

  _markup() {
    return `
      <style>${PLAYER_STYLES}</style>
      <main class="player" aria-label="Mizu Video Player">
        <div class="stage">
          <slot name="video"></slot>
          <canvas aria-hidden="true"></canvas>
          <button class="center-play" data-action="play" aria-label="Play">▶</button>
          <div class="toast" role="status" aria-live="polite"></div>
          <div class="stats" hidden></div>
          <div class="subtitles" aria-live="polite"></div>
          <slot name="page-captions"></slot>
        </div>
        <header class="chrome controls-visible">
          <span class="brand">Mizu Video Player</span>
          <span class="quality"></span>
          <span class="chapter"></span>
          <button data-action="anime4k-panel" aria-label="Anime4K settings" title="Anime4K">A4K</button>
          <button data-action="settings" aria-label="Player settings" title="Settings">⚙</button>
          <button data-action="close" aria-label="Close player" title="Close">✕</button>
        </header>
        <footer class="controls controls-visible">
          <input class="timeline" type="range" min="0" max="100" step="0.05" value="0" aria-label="Video position">
          <div class="control-row">
            <button data-action="previous-video" class="youtube-control" aria-label="Previous playlist video" title="Previous video (Shift+P)">⏮</button>
            <button data-action="play" class="play" aria-label="Play or pause">▶</button>
            <button data-action="next-video" class="youtube-control" aria-label="Next playlist video" title="Next video (Shift+N)">⏭</button>
            <button data-action="back" class="seek" aria-label="Seek backward"></button>
            <button data-action="forward" class="seek" aria-label="Seek forward"></button>
            <button data-action="previous-chapter" class="youtube-control" aria-label="Previous chapter" title="Previous chapter (Ctrl+Left)">|‹</button>
            <button data-action="next-chapter" class="youtube-control" aria-label="Next chapter" title="Next chapter (Ctrl+Right)">›|</button>
            <button data-action="mute" aria-label="Mute or unmute">🔊</button>
            <input class="volume" type="range" min="0" max="1" step="0.01" aria-label="Volume">
            <span class="time">0:00 / 0:00</span>
            <span class="spacer"></span>
            <button data-action="captions" class="captions" aria-label="Subtitles" title="Subtitles" aria-haspopup="true">CC</button>
            <button data-action="quality" class="quality-button" aria-label="Video quality" title="Quality" aria-haspopup="true">Auto</button>
            <select class="speed" aria-label="Playback speed" title="Playback speed">
              <option value="0.5">0.5×</option><option value="0.75">0.75×</option>
              <option value="1">1×</option><option value="1.25">1.25×</option>
              <option value="1.5">1.5×</option><option value="1.75">1.75×</option>
              <option value="2">2×</option><option value="2.5">2.5×</option>
              <option value="3">3×</option><option value="4">4×</option>
              <option value="5">5×</option>
            </select>
            <button data-action="anime4k" class="anime4k" aria-label="Toggle Anime4K" title="Anime4K">A4K</button>
            <button data-action="pip" aria-label="Picture-in-Picture" title="Picture-in-Picture">▣</button>
            <button data-action="fullscreen" aria-label="Toggle fullscreen" title="Fullscreen">⛶</button>
          </div>
        </footer>
        ${this._settingsMarkup()}
        ${this._anime4kMarkup()}
        <div class="menu captions-menu" role="menu" hidden></div>
        <div class="menu quality-menu" role="menu" hidden></div>
      </main>`;
  }

  _settingsMarkup() {
    return `
      <aside class="panel settings" aria-label="Player settings" hidden>
        <div class="panel-title"><strong>Player settings</strong><button data-action="settings" aria-label="Close settings">✕</button></div>
        <label>Seek backward <span><input data-setting="seek-backward-seconds" type="number" min="1" max="120"> seconds</span></label>
        <label>Seek forward <span><input data-setting="seek-forward-seconds" type="number" min="1" max="120"> seconds</span></label>
        <label>Volume step <span><input data-setting="volume-step-percent" type="number" min="1" max="50">%</span></label>
        <label>Hide controls after <span><input data-setting="controls-timeout-ms" type="number" min="500" max="10000" step="100"> ms</span></label>
        <label><span>Left/right arrows seek</span><input data-setting="arrow-keys" type="checkbox"></label>
        <label><span>Space plays or pauses</span><input data-setting="space-key" type="checkbox"></label>
        <label><span>Handle media keys</span><input data-setting="media-keys" type="checkbox"></label>
        <label><span>Keep site shortcuts from firing</span><input data-setting="capture-keys" type="checkbox"></label>
        <label>Preferred quality <select data-setting="preferred-quality">
          <option value="0">Auto</option><option value="2160">2160p</option>
          <option value="1440">1440p</option><option value="1080">1080p</option>
          <option value="720">720p</option><option value="480">480p</option>
        </select></label>
        <fieldset class="extras"><legend>Subtitles</legend>
          <label>Size <span><input data-setting="subtitle-scale-percent" type="range" min="50" max="250" step="10"><output></output></span></label>
          <label>Colour <select data-setting="subtitle-colour">
            <option value="white">White</option><option value="yellow">Yellow</option>
            <option value="cyan">Cyan</option><option value="green">Green</option>
          </select></label>
          <label>Background <select data-setting="subtitle-background">
            <option value="none">None</option><option value="soft">Shaded</option>
            <option value="solid">Solid</option>
          </select></label>
          <label>Edge <select data-setting="subtitle-edge">
            <option value="outline">Outline</option><option value="shadow">Drop shadow</option>
            <option value="none">None</option>
          </select></label>
          <label>Typeface <select data-setting="subtitle-font">
            <option value="sans">Sans serif</option><option value="serif">Serif</option>
            <option value="mono">Monospace</option>
          </select></label>
          <label>Distance from edge <span><input data-setting="subtitle-position-percent" type="range" min="0" max="40" step="2"><output></output></span></label>
        </fieldset>
      </aside>`;
  }

  _anime4kMarkup() {
    let modes = MODES.map(
      mode =>
        `<option value="${mode.id}" title="${mode.note}">${mode.label}</option>`
    ).join("");
    let tiers = QUALITY_TIERS.map(
      tier =>
        `<option value="${tier.id}" title="${tier.note}">${tier.label} (${tier.id})</option>`
    ).join("");
    let extras = EXTRAS.map(
      extra => `
        <label title="${extra.note}"><span>${extra.label}</span>
          <input data-extra="${extra.id}" type="checkbox"></label>`
    ).join("");

    return `
      <aside class="panel anime4k-panel" aria-label="Anime4K settings" hidden>
        <div class="panel-title"><strong>Anime4K</strong><button data-action="anime4k-panel" aria-label="Close Anime4K settings">✕</button></div>
        <label><span>Enable Anime4K</span><input data-setting="anime4k-enabled" type="checkbox"></label>
        <label>Mode <select data-setting="anime4k-mode">${modes}</select></label>
        <label>Quality <select data-setting="anime4k-quality">${tiers}</select></label>
        <label>Strength <span><input data-setting="anime4k-strength-percent" type="range" min="0" max="100" step="5"><output></output></span></label>
        <label>Skip sources above <span><select data-setting="anime4k-max-source-height">
          <option value="480">480p</option><option value="720">720p</option>
          <option value="1080">1080p</option><option value="1440">1440p</option>
          <option value="2160">2160p</option><option value="0">no limit</option>
        </select></span></label>
        <label>Upscale at most <span><select data-setting="anime4k-max-output-scale">
          <option value="2">2×</option><option value="3">3×</option>
          <option value="4">4×</option><option value="0">display size</option>
        </select></span></label>
        <label>Process at most <span><select data-setting="anime4k-frame-rate-limit">
          <option value="0">every frame</option><option value="60">60 fps</option>
          <option value="30">30 fps</option><option value="24">24 fps</option>
        </select></span></label>
        <label><span>Lower quality automatically when slow</span><input data-setting="anime4k-adaptive" type="checkbox"></label>
        <label><span>Show performance overlay</span><input data-setting="anime4k-stats" type="checkbox"></label>
        <fieldset class="extras"><legend>Extra passes</legend>${extras}</fieldset>
        <p class="chain-summary"></p>
        <p>Anime4K by bloc97, run as WebGL2. Modes and quality tiers match the
        upstream presets; larger tiers need a discrete GPU. Protected or
        cross-origin video cannot be read back, and playback then falls back to
        the untouched frame automatically.</p>
      </aside>`;
  }

  _on(target, type, handler, capture = false) {
    target.addEventListener(type, handler, capture);
    this.listeners.push({ target, type, handler, capture });
  }

  _listen() {
    for (let type of [
      "timeupdate",
      "durationchange",
      "volumechange",
      "ratechange",
      "play",
      "pause",
      "resize",
    ]) {
      this._on(this.video, type, this._boundVideoUpdate);
    }
    this._on(this.root, "click", event => this._onClick(event));
    this._on(this.root.querySelector(".timeline"), "input", event => {
      if (Number.isFinite(this.video.duration)) {
        this.video.currentTime = Number(event.target.value);
      }
    });
    this._on(this.root.querySelector(".volume"), "input", event => {
      this.video.volume = Number(event.target.value);
      this.video.muted = false;
    });
    this._on(this.root.querySelector(".speed"), "change", event => {
      this.video.playbackRate = Number(event.target.value);
    });
    this._on(this.root, "click", event => {
      if (
        !event.target.closest?.(
          ".menu, [data-action=captions], [data-action=quality]"
        )
      ) {
        for (let menu of this.root.querySelectorAll(".menu")) {
          menu.hidden = true;
        }
      }
    });
    this._on(this.host, "mousemove", () => this._showControls());
    this._on(this.host, "pointerdown", () => this._showControls());
    this._on(this.host, "dblclick", () => this._toggleFullscreen());

    for (let input of this.root.querySelectorAll("[data-setting]")) {
      this._on(input, "change", () => this._saveSetting(input));
      if (input.type == "range") {
        this._on(input, "input", () => this._showSettingOutput(input));
      }
    }
    for (let input of this.root.querySelectorAll("[data-extra]")) {
      this._on(input, "change", () => this._saveExtras());
    }
  }

  /**
   * Keeps the page from noticing, or undoing, what the player does to it.
   *
   * Site players bind their own handlers to the document and to the video
   * element. Left alone they double-handle every keystroke, and they treat any
   * fullscreen change as their own: JW Player in particular resets its layout
   * and re-parents the video back into its container, which leaves the player
   * fullscreen over nothing at all.
   */
  _watchDocument() {
    let swallow = event => {
      if (event.target == this.host || this.host.contains(event.target)) {
        event.stopPropagation();
      }
    };
    for (let type of [
      "fullscreenchange",
      "fullscreenerror",
      "mozfullscreenchange",
      "webkitfullscreenchange",
      "webkitfullscreenerror",
    ]) {
      this._on(this.window, type, swallow, true);
    }
    this._on(this.window, "fullscreenchange", () => this._onFullscreen(), true);
    this._on(this.window, "resize", () => this.anime4k?.invalidateLayout());

    // Our own shortcuts run first and are then kept from reaching the site.
    this._on(
      this.window,
      "keydown",
      event => {
        if (event.target != this.host && !this.host.contains(event.target)) {
          return;
        }
        this._onKey(event);
        if (this.settings.captureKeys) {
          event.stopPropagation();
        }
      },
      true
    );

    // Watching the host and the video alone is enough to catch a page taking
    // the video back, and costs nothing on documents that mutate constantly.
    this.guard = new this.window.MutationObserver(() => this._reclaim());
    this.guard.observe(this.host, { childList: true });
    this.guard.observe(this.document.documentElement, { childList: true });
    this.guard.observe(this.video, {
      attributes: true,
      attributeFilter: ["style", "slot", "controls", "hidden"],
    });
  }

  /**
   * Puts the video back where the player expects it after the page moves or
   * restyles it.
   */
  _reclaim() {
    if (this.closed || this.reclaiming) {
      return;
    }
    if (!this.host.isConnected) {
      // The page emptied the element the host lives in.
      this.document.documentElement.appendChild(this.host);
    }
    this.reclaiming = true;
    try {
      if (this.video.parentNode != this.host) {
        this.host.appendChild(this.video);
        if (!this.reclaimed) {
          this.reclaimed = true;
          this._toast("Reclaimed the video from the page");
        }
      }
      if (
        this.pageCaptions?.isConnected &&
        this.pageCaptions.parentNode != this.host
      ) {
        this.host.appendChild(this.pageCaptions);
      }
      if (this.video.getAttribute("slot") != "video") {
        this.video.setAttribute("slot", "video");
      }
      if (this.video.hasAttribute("controls")) {
        this.video.removeAttribute("controls");
      }
      if (this.video.hidden) {
        this.video.hidden = false;
      }
      // An inline `display: none !important` outranks anything the shadow
      // stylesheet can say, so a page that hides its video has to be undone.
      if (
        /display|visibility|opacity|transform/.test(this.video.style.cssText)
      ) {
        this.video.removeAttribute("style");
      }
    } finally {
      // The observer is already queued for the writes above; clearing the flag
      // asynchronously stops those from being read back as page interference.
      this.window.setTimeout(() => {
        this.reclaiming = false;
      }, 0);
    }
  }

  _configureSettings() {
    this.root.querySelector('[data-action="back"]').textContent =
      `↶ ${this.settings.seekBackward}`;
    this.root.querySelector('[data-action="forward"]').textContent =
      `${this.settings.seekForward} ↷`;
    this._setInput("seek-backward-seconds", this.settings.seekBackward);
    this._setInput("seek-forward-seconds", this.settings.seekForward);
    this._setInput(
      "volume-step-percent",
      Math.round(this.settings.volumeStep * 100)
    );
    this._setInput("controls-timeout-ms", this.settings.controlsTimeout);
    this._setInput("arrow-keys", this.settings.arrowKeys);
    this._setInput("space-key", this.settings.spaceKey);
    this._setInput("media-keys", this.settings.mediaKeys);
    this._setInput("capture-keys", this.settings.captureKeys);
    this._setInput("preferred-quality", this.settings.preferredQuality);
    this._setInput(
      "subtitle-scale-percent",
      Math.round(this.settings.subtitleScale * 100)
    );
    this._setInput("subtitle-colour", this.settings.subtitleColour);
    this._setInput("subtitle-background", this.settings.subtitleBackground);
    this._setInput("subtitle-edge", this.settings.subtitleEdge);
    this._setInput("subtitle-font", this.settings.subtitleFont);
    this._setInput("subtitle-position-percent", this.settings.subtitlePosition);
    this._setInput("anime4k-enabled", this.settings.anime4k);
    this._setInput("anime4k-mode", this.settings.anime4kMode);
    this._setInput("anime4k-quality", this.settings.anime4kQuality);
    this._setInput(
      "anime4k-strength-percent",
      Math.round(this.settings.anime4kStrength * 100)
    );
    this._setInput(
      "anime4k-max-source-height",
      this.settings.anime4kMaxSourceHeight
    );
    this._setInput(
      "anime4k-max-output-scale",
      this.settings.anime4kMaxOutputScale
    );
    this._setInput(
      "anime4k-frame-rate-limit",
      this.settings.anime4kFrameRateLimit
    );
    this._setInput("anime4k-adaptive", this.settings.anime4kAdaptive);
    this._setInput("anime4k-stats", this.settings.anime4kStats);
    for (let input of this.root.querySelectorAll("[data-extra]")) {
      input.checked = this.settings.anime4kExtras.includes(input.dataset.extra);
    }
    this._updateChainSummary();
  }

  _setInput(name, value) {
    let input = this.root.querySelector(`[data-setting="${name}"]`);
    if (input.type == "checkbox") {
      input.checked = value;
    } else {
      input.value = value;
    }
    this._showSettingOutput(input);
  }

  _showSettingOutput(input) {
    input.parentElement
      .querySelector("output")
      ?.replaceChildren(`${input.value}%`);
  }

  _saveSetting(input) {
    let name = input.dataset.setting;
    let value;
    if (input.type == "checkbox") {
      value = input.checked;
    } else if (input.tagName == "SELECT" && !/^-?[0-9.]+$/.test(input.value)) {
      value = input.value;
    } else {
      value = Number(input.value);
      if (input.type == "number") {
        value = Math.round(
          Math.min(Number(input.max), Math.max(Number(input.min), value))
        );
        input.value = value;
      }
    }
    this.actor.sendAsyncMessage("MizuVideo:SetSetting", { name, value });

    if (
      name == "volume-step-percent" ||
      name == "anime4k-strength-percent" ||
      name == "subtitle-scale-percent"
    ) {
      value /= 100;
    }
    this.settings[SETTING_NAMES[name]] = value;
    this._configureSettings();
    this._applyAnime4KSettings(name);
    if (name.startsWith("subtitle-")) {
      this._applySubtitleStyle();
    }
    if (name == "preferred-quality") {
      // Re-arm so the new preference is applied to the stream already playing.
      this.qualityApplied = "";
      this._refreshMedia();
    }
  }

  _saveExtras() {
    let extras = [...this.root.querySelectorAll("[data-extra]")]
      .filter(input => input.checked)
      .map(input => input.dataset.extra);
    this.settings.anime4kExtras = extras;
    this.actor.sendAsyncMessage("MizuVideo:SetSetting", {
      name: "anime4k-extras",
      value: extras.join(","),
    });
    this._updateChainSummary();
    this.anime4k?.configure({ extras });
  }

  _applyAnime4KSettings(changed) {
    if (changed == "anime4k-enabled") {
      this._setAnime4K(this.settings.anime4k);
      return;
    }
    this.anime4k?.configure(this._anime4kSettings());
    if (changed == "anime4k-stats") {
      this.root.querySelector(".stats").hidden = !this.settings.anime4kStats;
    }
  }

  _anime4kSettings() {
    return {
      mode: this.settings.anime4kMode,
      quality: this.settings.anime4kQuality,
      extras: this.settings.anime4kExtras,
      strength: this.settings.anime4kStrength,
      frameRateLimit: this.settings.anime4kFrameRateLimit,
      maxSourceHeight: this.settings.anime4kMaxSourceHeight,
      maxOutputScale: this.settings.anime4kMaxOutputScale,
      adaptive: this.settings.anime4kAdaptive,
    };
  }

  _updateChainSummary() {
    let mode = MODES.find(entry => entry.id == this.settings.anime4kMode);
    this.root.querySelector(".chain-summary").textContent = mode
      ? mode.note
      : "";
  }

  _onClick(event) {
    let picked = event.target.closest?.(".menu-item");
    if (picked) {
      this._pickMenuItem(picked);
      return;
    }
    let action = event.target.closest("button")?.dataset.action;
    switch (action) {
      case "play":
        this._togglePlay();
        break;
      case "previous-video":
        this._selectPlaylistVideo(-1);
        break;
      case "next-video":
        this._selectPlaylistVideo(1);
        break;
      case "back":
        this._seek(-this.settings.seekBackward);
        break;
      case "forward":
        this._seek(this.settings.seekForward);
        break;
      case "previous-chapter":
        this._seekChapter(-1);
        break;
      case "next-chapter":
        this._seekChapter(1);
        break;
      case "mute":
        this.video.muted = !this.video.muted;
        break;
      case "captions":
        this._openMenu("captions");
        break;
      case "quality":
        this._openMenu("quality");
        break;
      case "anime4k":
        this._setAnime4K(!this.anime4k, true);
        break;
      case "pip":
        this._pictureInPicture();
        break;
      case "fullscreen":
        this._toggleFullscreen();
        break;
      case "settings":
        this._togglePanel(".settings");
        break;
      case "anime4k-panel":
        this._togglePanel(".anime4k-panel");
        break;
      case "close":
        this.close();
        break;
    }
  }

  _togglePanel(selector) {
    let panel = this.root.querySelector(selector);
    let showing = panel.hasAttribute("hidden");
    for (let other of this.root.querySelectorAll(".panel")) {
      other.hidden = true;
    }
    panel.hidden = !showing;
    this._showControls(showing);
  }

  _onKey(event) {
    // Listening on the window retargets the event to the host, so the real
    // focused control has to come from the composed path or every keystroke
    // typed into the settings panel would be read as a shortcut.
    let source = event.composedPath()[0] ?? event.target;
    if (source.matches?.("input, select, button, textarea")) {
      return;
    }
    let handled = this._onCoreKey(event);
    if (handled !== null) {
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
        this._showControls();
      }
      return;
    }
    handled = true;
    switch (event.code) {
      case "ArrowLeft":
        if (this.settings.arrowKeys) {
          this._seek(-this.settings.seekBackward);
        } else {
          handled = false;
        }
        break;
      case "ArrowRight":
        if (this.settings.arrowKeys) {
          this._seek(this.settings.seekForward);
        } else {
          handled = false;
        }
        break;
      case "ArrowUp":
        this.video.volume = Math.min(
          1,
          this.video.volume + this.settings.volumeStep
        );
        break;
      case "ArrowDown":
        this.video.volume = Math.max(
          0,
          this.video.volume - this.settings.volumeStep
        );
        break;
      case "Space":
        if (this.settings.spaceKey) {
          this._togglePlay();
        } else {
          handled = false;
        }
        break;
      case "KeyM":
        this.video.muted = !this.video.muted;
        break;
      case "KeyC":
        this._toggleCaptions();
        break;
      case "KeyF":
        this._toggleFullscreen();
        break;
      case "KeyA":
        this._setAnime4K(!this.anime4k, true);
        break;
      case "Escape":
        if (
          this.document.fullscreenElement ||
          this.host.hasAttribute("embedded-fullscreen")
        ) {
          handled = false;
        } else {
          this.close();
        }
        break;
      case "MediaPlayPause":
        if (this.settings.mediaKeys) {
          this._togglePlay();
        } else {
          handled = false;
        }
        break;
      case "MediaTrackNext":
        if (this.settings.mediaKeys) {
          if (this.playlistState.next) {
            this._selectPlaylistVideo(1);
          } else {
            this._seek(this.settings.seekForward);
          }
        } else {
          handled = false;
        }
        break;
      case "MediaTrackPrevious":
        if (this.settings.mediaKeys) {
          if (this.playlistState.previous) {
            this._selectPlaylistVideo(-1);
          } else {
            this._seek(-this.settings.seekBackward);
          }
        } else {
          handled = false;
        }
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
      this._showControls();
    }
  }

  /** YouTube-compatible shortcuts kept separate from the generic key handler. */
  _onCoreKey(event) {
    if (
      (event.ctrlKey || event.metaKey || event.altKey) &&
      (event.code == "ArrowLeft" || event.code == "ArrowRight")
    ) {
      this._seekChapter(event.code == "ArrowRight" ? 1 : -1);
      return true;
    }
    if (
      /^Digit[0-9]$/.test(event.code) &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      if (!Number.isFinite(this.video.duration)) {
        return false;
      }
      let fraction = Number(event.code.slice(-1)) / 10;
      this.video.currentTime = this.video.duration * fraction;
      this._toast(`${Math.round(fraction * 100)}%`);
      return true;
    }
    switch (event.code) {
      case "KeyJ":
        this._seek(-10);
        return true;
      case "KeyK":
        this._togglePlay();
        return true;
      case "KeyL":
        this._seek(10);
        return true;
      case "KeyI":
        this._pictureInPicture();
        return true;
      case "KeyN":
        if (event.shiftKey && this.playlistState.next) {
          this._selectPlaylistVideo(1);
          return true;
        }
        return null;
      case "KeyP":
        if (event.shiftKey && this.playlistState.previous) {
          this._selectPlaylistVideo(-1);
          return true;
        }
        return null;
      case "Comma":
      case "Period":
        if (event.shiftKey) {
          this._changeSpeed(event.code == "Period" ? 0.25 : -0.25);
          return true;
        }
        if (this.video.paused) {
          this._stepFrame(event.code == "Period" ? 1 : -1);
          return true;
        }
        return false;
      case "Home":
        this.video.currentTime = 0;
        return true;
      case "End":
        if (Number.isFinite(this.video.duration)) {
          this.video.currentTime = this.video.duration;
          return true;
        }
        return false;
      default:
        return null;
    }
  }

  _togglePlay() {
    if (this.video.paused) {
      this.video
        .play()
        .catch(() => this._toast("Playback was blocked by this site"));
    } else {
      this.video.pause();
    }
  }

  _seek(delta) {
    let end = Number.isFinite(this.video.duration)
      ? this.video.duration
      : Infinity;
    this.video.currentTime = Math.max(
      0,
      Math.min(end, this.video.currentTime + delta)
    );
    this._toast(`${delta > 0 ? "+" : "−"}${Math.abs(delta)} seconds`);
  }

  _stepFrame(direction) {
    this.video.currentTime = Math.max(
      0,
      this.video.currentTime + direction / 30
    );
    this._toast(direction > 0 ? "Next frame" : "Previous frame");
  }

  _changeSpeed(delta) {
    let rate = Math.min(5, Math.max(0.25, this.video.playbackRate + delta));
    this.video.playbackRate = Math.round(rate * 4) / 4;
    this._toast(`${this.video.playbackRate}× speed`);
  }

  _seekChapter(direction) {
    if (!this.chapters.length) {
      this._toast("No chapters in this video");
      return;
    }
    let time = this.video.currentTime;
    let current = this.chapters.findLastIndex(chapter => chapter.start <= time);
    let target = direction > 0 ? current + 1 : current;
    if (
      direction < 0 &&
      current >= 0 &&
      time - this.chapters[current].start < 3
    ) {
      target = current - 1;
    }
    target = Math.min(this.chapters.length - 1, Math.max(0, target));
    let chapter = this.chapters[target];
    this.video.currentTime = chapter.start;
    this._toast(chapter.title);
  }

  _selectPlaylistVideo(direction) {
    if (!this.bridge.selectPlaylistVideo(direction)) {
      this._toast("No playlist video in that direction");
      return;
    }
    this._toast(direction < 0 ? "Previous video" : "Next video");
  }

  _toggleCaptions() {
    let tracks = this.subtitleTracks ?? [];
    let active = tracks.find(track => track.active);
    if (active) {
      this.bridge.selectSubtitle("off");
      this._watchTextTrack(null);
      this._toast("Subtitles off");
    } else if (tracks.length) {
      this.bridge.selectSubtitle(tracks[0].id);
      this._toast(`Subtitles: ${tracks[0].label}`);
    } else {
      this._toast("No subtitles available");
    }
    this._refreshMedia();
  }

  _updateControls() {
    if (this.closed) {
      return;
    }
    let duration = Number.isFinite(this.video.duration)
      ? this.video.duration
      : 0;
    let timeline = this.root.querySelector(".timeline");
    timeline.max = duration || 100;
    timeline.value = this.video.currentTime || 0;
    timeline.style.setProperty(
      "--progress",
      `${duration ? (this.video.currentTime / duration) * 100 : 0}%`
    );
    this.root.querySelector(".time").textContent =
      `${formatTime(this.video.currentTime)} / ${formatTime(duration)}`;
    this.root.querySelector(".volume").value = this.video.muted
      ? 0
      : this.video.volume;
    this.root.querySelector(".play").textContent = this.video.paused
      ? "▶"
      : "❚❚";
    this.root.querySelector(".center-play").hidden = !this.video.paused;
    this.root.querySelector(".speed").value = String(this.video.playbackRate);
    this.root.querySelector(".quality").textContent = this.video.videoWidth
      ? `${this.video.videoWidth} × ${this.video.videoHeight}`
      : "";
    let chapter = this.chapters.findLast(
      entry => entry.start <= this.video.currentTime
    );
    this.root.querySelector(".chapter").textContent = chapter?.title ?? "";
  }

  _showControls(pinned = false) {
    this.host.setAttribute("controls-visible", "");
    this.window.clearTimeout(this.hideTimer);
    if (!pinned && !this.video.paused) {
      this.hideTimer = this.window.setTimeout(() => {
        if (!this.root.querySelector(".panel:not([hidden])")) {
          this.host.removeAttribute("controls-visible");
        }
      }, this.settings.controlsTimeout);
    }
  }

  _toast(message) {
    let toast = this.root.querySelector(".toast");
    toast.textContent = message;
    toast.setAttribute("show", "");
    this.window.setTimeout(() => toast.removeAttribute("show"), 1400);
  }

  /**
   * Keeps the subtitle and quality menus in step with the site's player.
   *
   * Both lists arrive late and can change mid-playback: an adaptive stream
   * publishes its renditions once the manifest is parsed, and a site player may
   * add subtitle tracks only when the user first asks for them. Polling is used
   * rather than the players' own events because subscribing would mean handing
   * a privileged callback to page script.
   */
  _pollMedia() {
    this._refreshMedia();
    this.mediaTimer = this.window.setInterval(() => {
      if (this.closed) {
        this.window.clearInterval(this.mediaTimer);
        return;
      }
      this._refreshMedia();
    }, 1000);
  }

  _refreshMedia() {
    let subtitles = this.bridge.subtitleTracks();
    let levels = this.bridge.qualityLevels();
    this.chapters = this.bridge.chapters();
    this.playlistState = this.bridge.playlistState();

    this.root.querySelector(".captions").disabled =
      !subtitles.length && !this.pageCaptions;
    let active = levels.find(level => level.active);
    this.root.querySelector(".quality-button").textContent = active
      ? active.label
      : "Auto";
    this.root.querySelector(".quality-button").disabled = !levels.length;
    for (let action of ["previous-chapter", "next-chapter"]) {
      this.root.querySelector(`[data-action="${action}"]`).hidden =
        !this.chapters.length;
    }
    let previousVideo = this.root.querySelector(
      '[data-action="previous-video"]'
    );
    let nextVideo = this.root.querySelector('[data-action="next-video"]');
    previousVideo.hidden = !this.playlistState.available;
    nextVideo.hidden = !this.playlistState.available;
    previousVideo.disabled = !this.playlistState.previous;
    nextVideo.disabled = !this.playlistState.next;

    this._applyPreferredQuality(levels);
    this._watchTextTrack(this.bridge.activeTextTrack());
    this._adoptPageCaptions();
    this.subtitleTracks = subtitles;
    this.qualityLevels = levels;
    this._updateControls();
  }

  /**
   * Puts playback on the quality the user asked for, once per source.
   *
   * Adaptive players start at a low rendition and climb, which on a fast
   * connection still means the first seconds look soft. Applying the preference
   * as soon as the levels appear skips that.
   */
  _applyPreferredQuality(levels) {
    let source = this.video.currentSrc || this.video.src || "";
    if (!levels.length) {
      return;
    }
    if (this.qualityApplied == source) {
      return;
    }
    if (!this.settings.preferredQuality) {
      this.qualityApplied = source;
      this.bridge.selectQuality("auto");
      return;
    }
    let wanted = preferredLevel(levels, this.settings.preferredQuality);
    if (!wanted) {
      return;
    }
    this.qualityApplied = source;
    if (!this.bridge.selectQuality(wanted.id)) {
      return;
    }
    if (!wanted.active) {
      this._toast(`Quality set to ${wanted.label}`);
    }
  }

  /**
   * Follows one text track, drawing its cues into the player's own overlay.
   *
   * The cues have to be drawn here rather than left to the video element: the
   * player owns the element now, and the site's caption container was left
   * behind in the page where nothing can see it.
   */
  _watchTextTrack(track) {
    if (track == this.textTrack) {
      return;
    }
    this.textTrack?.removeEventListener("cuechange", this._boundCueUpdate);
    this.textTrack = track;
    this.textTrack?.addEventListener("cuechange", this._boundCueUpdate);
    this._renderCues();
  }

  _renderCues() {
    let overlay = this.root.querySelector(".subtitles");
    overlay.replaceChildren();
    let cues = this.textTrack?.activeCues;
    if (!cues?.length) {
      return;
    }
    for (let index = 0; index < cues.length; index++) {
      let cue = cues[index];
      let line = this.document.createElement("div");
      line.className = "subtitle-line";
      // getCueAsHTML renders the cue's own markup without going through a
      // string, so italics and the rest survive with nothing to inject.
      if (typeof cue.getCueAsHTML == "function") {
        line.appendChild(cue.getCueAsHTML());
      } else {
        line.textContent = String(cue.text ?? "");
      }
      overlay.appendChild(line);
    }
  }

  /**
   * Adopts the site player's own caption layer when it has one.
   *
   * Some players never create a text track at all: they parse the subtitle file
   * themselves and write into a div next to the video. Moving that div into the
   * player keeps those subtitles working, even though the player's own styling
   * cannot reach inside it.
   */
  _adoptPageCaptions() {
    // A text track that actually carries cues is rendered by the player, and
    // the site's own layer is left alone. A track with no cues means the site
    // parsed the subtitle file itself, so its layer is the only thing that
    // knows what the current line is.
    if (this.textTrack?.cues?.length) {
      this._releasePageCaptions();
      return;
    }
    if (this.pageCaptions?.isConnected) {
      return;
    }

    let found = this._findCaptionLayer();
    if (!found) {
      return;
    }
    this.pageCaptions = found;
    this.pageCapturesHome = {
      parent: found.parentNode,
      next: found.nextSibling,
    };
    found.setAttribute("slot", "page-captions");
    this.host.appendChild(found);
    this._toast("Using this site's own subtitles");
  }

  /**
   * Finds the element a site player draws its subtitles into.
   *
   * Players put this layer beside the video's container rather than inside it,
   * so the search covers the whole document. The named selectors are tried
   * first; the loose one after them only accepts overlays, because "caption"
   * appears in the class names of plenty of menus and buttons too.
   *
   * @returns {Element|null}
   */
  _findCaptionLayer() {
    let candidates = [
      ...this.document.querySelectorAll(CAPTION_SELECTORS),
    ].filter(element => !this.host.contains(element));
    if (!candidates.length) {
      candidates = [
        ...this.document.querySelectorAll(LOOSE_CAPTION_SELECTORS),
      ].filter(element => {
        if (this.host.contains(element) || element.closest("button, select")) {
          return false;
        }
        let style = this.window.getComputedStyle(element);
        return style.position == "absolute" || style.position == "fixed";
      });
    }
    if (!candidates.length) {
      return null;
    }
    // The one closest to where the video came from is the one that belongs to
    // it, which matters on pages carrying more than one player.
    let home = this.original.parent;
    return (
      candidates.find(element => home?.contains?.(element)) ??
      candidates.find(element => element.contains?.(home)) ??
      candidates[0]
    );
  }

  _releasePageCaptions() {
    let home = this.pageCapturesHome;
    if (!this.pageCaptions || !home?.parent?.isConnected) {
      this.pageCaptions = null;
      return;
    }
    this.pageCaptions.removeAttribute("slot");
    home.parent.insertBefore(this.pageCaptions, home.next);
    this.pageCaptions = null;
  }

  _openMenu(kind) {
    let menu = this.root.querySelector(
      kind == "captions" ? ".captions-menu" : ".quality-menu"
    );
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    for (let other of this.root.querySelectorAll(".menu, .panel")) {
      other.hidden = true;
    }

    let items =
      kind == "captions"
        ? [
            {
              id: "off",
              label: "Off",
              active:
                !this.textTrack &&
                !(this.subtitleTracks ?? []).some(track => track.active),
            },
            ...(this.subtitleTracks ?? []),
          ]
        : [
            {
              id: "auto",
              label: "Auto",
              active: !(this.qualityLevels ?? []).some(level => level.active),
            },
            ...(this.qualityLevels ?? []),
          ];

    menu.replaceChildren();
    for (let item of items) {
      let button = this.document.createElement("button");
      button.className = "menu-item";
      button.dataset.pick = item.id;
      button.dataset.kind = kind;
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", String(!!item.active));
      button.textContent =
        (item.active ? "\u2713 " : "\u2007 ") + (item.label ?? item.id);
      menu.appendChild(button);
    }
    menu.hidden = false;
    this._showControls(true);
  }

  _pickMenuItem(button) {
    let kind = button.dataset.kind;
    let id = button.dataset.pick;
    if (kind == "captions") {
      this.bridge.selectSubtitle(id);
      if (id == "off") {
        this._watchTextTrack(null);
      }
      this._toast(
        id == "off"
          ? "Subtitles off"
          : `Subtitles: ${button.textContent.trim()}`
      );
    } else {
      this.qualityApplied = this.video.currentSrc || this.video.src || "";
      this.bridge.selectQuality(id);
      this._toast(`Quality: ${button.textContent.trim()}`);
    }
    button.closest(".menu").hidden = true;
    this._refreshMedia();
  }

  /** Turns the subtitle style settings into the overlay's custom properties. */
  _applySubtitleStyle() {
    let style = this.host.style;
    style.setProperty("--subtitle-scale", this.settings.subtitleScale);
    style.setProperty(
      "--subtitle-bottom",
      `${this.settings.subtitlePosition}%`
    );
    style.setProperty(
      "--subtitle-colour",
      SUBTITLE_COLOURS[this.settings.subtitleColour] ?? "#fff"
    );
    style.setProperty(
      "--subtitle-font",
      SUBTITLE_FONTS[this.settings.subtitleFont] ?? "sans-serif"
    );
    this.host.setAttribute(
      "subtitle-background",
      this.settings.subtitleBackground
    );
    this.host.setAttribute("subtitle-edge", this.settings.subtitleEdge);
  }

  async _pictureInPicture() {
    try {
      if (this.document.pictureInPictureElement) {
        await this.document.exitPictureInPicture();
      } else {
        await this.video.requestPictureInPicture();
      }
    } catch (_) {
      this._toast("Picture-in-Picture is unavailable for this video");
    }
  }

  /**
   * Enters or leaves fullscreen.
   *
   * The check is against the player's own host rather than "is anything
   * fullscreen", because sites routinely leave their own container fullscreen;
   * treating that as ours used to exit the site's fullscreen and leave the
   * player windowed.
   */
  async _toggleFullscreen() {
    if (this.host.hasAttribute("embedded-fullscreen")) {
      this.host.removeAttribute("embedded-fullscreen");
      await this.actor
        .sendQuery("MizuVideo:ExitEmbedderFullscreen")
        .catch(() => {});
      this.anime4k?.invalidateLayout();
      return;
    }

    let current = this.document.fullscreenElement;
    if (current == this.host) {
      await this.document.exitFullscreen().catch(() => {});
      return;
    }
    if (current) {
      // The site left its own container fullscreen. Take it over rather than
      // reading it as ours and just dropping out of fullscreen entirely.
      await this.document.exitFullscreen().catch(() => {});
    }
    try {
      await this.host.requestFullscreen();
    } catch (_) {
      await this._fullscreenThroughEmbedder();
    }
  }

  /**
   * Fallback for a player running inside a third-party embed.
   *
   * `requestFullscreen` is refused outright when the embedding page did not
   * mark its iframe as allowing fullscreen, which is the common case for the
   * players these sites drop into an iframe. Asking the chrome process to
   * promote the frame chain instead gives the same result, and the host still
   * covers that frame's viewport.
   */
  async _fullscreenThroughEmbedder() {
    let promoted = await this.actor
      .sendQuery("MizuVideo:FullscreenEmbedder")
      .catch(() => false);
    if (!promoted) {
      this._toast("This page does not allow fullscreen video");
      return;
    }
    // The frame is now fullscreen and the host already fills that frame, so
    // there is nothing left to promote inside this document.
    this.host.setAttribute("embedded-fullscreen", "");
    this.anime4k?.invalidateLayout();
    this._showControls();
  }

  _onFullscreen() {
    if (this.closed) {
      return;
    }
    // The display size just changed, which is what Anime4K scales against.
    this.anime4k?.invalidateLayout();
    this.host.focus();
    this._showControls();
  }

  _setAnime4K(enabled, persist = false) {
    this.settings.anime4k = !!enabled;
    this._setInput("anime4k-enabled", this.settings.anime4k);
    if (persist) {
      this.actor.sendAsyncMessage("MizuVideo:SetSetting", {
        name: "anime4k-enabled",
        value: this.settings.anime4k,
      });
    }
    if (!enabled) {
      this._stopAnime4K();
      return;
    }

    try {
      this.anime4k = new Anime4KRenderer(
        this.canvas,
        this.video,
        this.window,
        this._anime4kSettings()
      );
      this.anime4k.onstats = stats => this._onAnime4KStats(stats);
      this.anime4k.onsuspend = reason => this._toast(reason);
      this.anime4k.onerror = error => {
        this._stopAnime4K();
        this._toast(`Anime4K stopped: ${error.message}`);
      };
      this.anime4k.start();
      this.host.setAttribute("anime4k", "");
      this.root.querySelector(".anime4k").setAttribute("active", "");
      this._toast("Anime4K enabled");
    } catch (error) {
      this._stopAnime4K();
      this._toast(`Anime4K unavailable: ${error.message}`);
    }
  }

  _stopAnime4K() {
    this.anime4k?.stop();
    this.anime4k = null;
    this.host.removeAttribute("anime4k");
    this.host.removeAttribute("anime4k-painting");
    this.root.querySelector(".anime4k")?.removeAttribute("active");
    this.root.querySelector(".stats").hidden = true;
  }

  _onAnime4KStats(stats) {
    // The canvas only covers the video once it holds a processed frame; until
    // then, and after any failure, the untouched video stays on screen.
    this.host.toggleAttribute("anime4k-painting", this.anime4k?.painting);
    let overlay = this.root.querySelector(".stats");
    overlay.hidden = !this.settings.anime4kStats;
    if (overlay.hidden) {
      return;
    }
    let fps = stats.frameIntervalMs ? 1000 / stats.frameIntervalMs : 0;
    overlay.textContent = [
      `state ${stats.state}${stats.reason ? `: ${stats.reason}` : ""}`,
      `${stats.sourceWidth}×${stats.sourceHeight} → ${stats.width}×${stats.height}`,
      `display target ${stats.outputWidth}×${stats.outputHeight}`,
      `${stats.passes} passes, ${stats.renderMs.toFixed(1)} ms to submit`,
      `${fps.toFixed(1)} frames/s in, ${stats.frames} done, ${stats.skipped} skipped`,
      stats.shaders.join(" + "),
    ].join("\n");
  }
}

const SETTING_NAMES = {
  "seek-backward-seconds": "seekBackward",
  "seek-forward-seconds": "seekForward",
  "volume-step-percent": "volumeStep",
  "controls-timeout-ms": "controlsTimeout",
  "arrow-keys": "arrowKeys",
  "space-key": "spaceKey",
  "media-keys": "mediaKeys",
  "capture-keys": "captureKeys",
  "anime4k-enabled": "anime4k",
  "anime4k-mode": "anime4kMode",
  "anime4k-quality": "anime4kQuality",
  "anime4k-strength-percent": "anime4kStrength",
  "anime4k-max-source-height": "anime4kMaxSourceHeight",
  "anime4k-max-output-scale": "anime4kMaxOutputScale",
  "anime4k-frame-rate-limit": "anime4kFrameRateLimit",
  "anime4k-adaptive": "anime4kAdaptive",
  "anime4k-stats": "anime4kStats",
  "preferred-quality": "preferredQuality",
  "subtitle-scale-percent": "subtitleScale",
  "subtitle-colour": "subtitleColour",
  "subtitle-background": "subtitleBackground",
  "subtitle-edge": "subtitleEdge",
  "subtitle-font": "subtitleFont",
  "subtitle-position-percent": "subtitlePosition",
};

/** Caption layers of the players these sites actually embed. */
const CAPTION_SELECTORS = [
  ".ytp-caption-window-container",
  ".jw-captions",
  ".jw-text-track-container",
  ".plyr__captions",
  ".vjs-text-track-display",
  ".art-subtitle",
  ".dplayer-subtitle",
  ".shaka-text-container",
  ".video-js .vjs-text-track-display",
].join(",");

const LOOSE_CAPTION_SELECTORS = [
  "[class*=caption i]",
  "[class*=subtitle i]",
  "[class*=text-track i]",
].join(",");

const SUBTITLE_COLOURS = {
  white: "#ffffff",
  yellow: "#ffe14d",
  cyan: "#8ff0ff",
  green: "#9dff8f",
};

const SUBTITLE_FONTS = {
  sans: "system-ui, sans-serif",
  serif: "Georgia, serif",
  mono: "monospace",
};

const YOUTUBE_SHORTS_STYLES = `
  ytd-reel-shelf-renderer,
  ytd-reel-item-renderer,
  ytd-rich-shelf-renderer[is-shorts],
  ytm-shorts-lockup-view-model,
  ytm-shorts-lockup-view-model-v2,
  ytd-rich-item-renderer:has(a#thumbnail[href*="/shorts/"]),
  ytd-grid-video-renderer:has(a#thumbnail[href*="/shorts/"]),
  ytd-video-renderer:has(a#thumbnail[href*="/shorts/"]),
  yt-lockup-view-model:has(a[href*="/shorts/"]),
  ytd-guide-entry-renderer:has(a[href*="/shorts"]),
  ytd-mini-guide-entry-renderer:has(a[href*="/shorts"]),
  tp-yt-paper-tab:has(a[href$="/shorts"]),
  yt-tab-shape:has(a[href$="/shorts"]) {
    display: none !important;
  }
`;

function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "0:00";
  }
  let seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, "0");
  let minutes = Math.floor(value / 60) % 60;
  let hours = Math.floor(value / 3600);
  return hours
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

const PLAYER_STYLES = `
  :host { position:fixed!important; inset:0!important; z-index:2147483647!important; display:block!important; background:#000!important; color:#fbfbfe!important; font:menu!important; color-scheme:dark!important; }
  :host(:fullscreen) { width:100%!important; height:100%!important; }
  * { box-sizing:border-box; }
  button,select,input { font:inherit; }
  .player { position:absolute; inset:0; overflow:hidden; background:#000; }
  /* A size container, so subtitles scale with the player rather than the
     screen: 4cqh is the same proportion windowed and fullscreen. */
  .stage { position:absolute; inset:0; overflow:hidden; background:#000; container-type:size; }
  ::slotted(video),canvas { width:100%!important; height:100%!important; object-fit:contain!important; position:absolute!important; inset:0!important; margin:0!important; padding:0!important; max-width:none!important; max-height:none!important; min-width:0!important; min-height:0!important; transform:none!important; background:#000; }
  /* Overriding the page has to stop short of "display", or the rule would also
     outrank the one below that keeps the idle canvas off the video. */
  ::slotted(video) { display:block!important; visibility:visible!important; opacity:1!important; }
  canvas { display:none; }
  :host([anime4k][anime4k-painting]) canvas { display:block; }
  header,footer { position:absolute; z-index:3; left:0; right:0; display:flex; align-items:center; transition:opacity .18s ease,transform .18s ease; background:linear-gradient(rgba(0,0,0,.78),transparent); padding:18px 22px; }
  header { top:0; gap:10px; }
  footer { bottom:0; flex-direction:column; align-items:stretch; gap:10px; padding-top:48px; background:linear-gradient(transparent,rgba(0,0,0,.88)); }
  :host(:not([controls-visible])) header { opacity:0; transform:translateY(-12px); pointer-events:none; }
  :host(:not([controls-visible])) footer { opacity:0; transform:translateY(12px); pointer-events:none; }
  .brand { font-weight:600; font-size:15px; }
  .quality { color:#b1b1b3; font-size:12px; }
  .chapter { color:#d7d7db; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  header [data-action=anime4k-panel] { margin-left:auto; }
  button,select { min-width:34px; min-height:34px; border:0; border-radius:6px; color:#fbfbfe; background:transparent; padding:6px 9px; }
  button:hover,select:hover,button[active] { background:rgba(255,255,255,.18); }
  button:focus-visible,select:focus-visible,input:focus-visible { outline:2px solid #00ddff; outline-offset:2px; }
  button:disabled { opacity:.35; }
  button[hidden] { display:none; }
  .anime4k[active] { background:#00ddff; color:#15141a; font-weight:600; }
  .control-row { display:flex; align-items:center; gap:4px; }
  .spacer { flex:1; }
  .time { margin-left:8px; font-variant-numeric:tabular-nums; font-size:12px; }
  .seek { min-width:52px; font-size:12px; }
  input[type=range] { accent-color:#00ddff; }
  .timeline { width:100%; margin:0; --progress:0%; }
  .volume { width:90px; }
  .center-play { position:absolute; z-index:2; inset:50% auto auto 50%; transform:translate(-50%,-50%); border-radius:50%; width:68px; height:68px; font-size:28px; padding-left:13px; background:rgba(20,20,24,.78); }
  .center-play[hidden] { display:none; }
  .toast { position:absolute; z-index:5; left:50%; top:18%; transform:translate(-50%,-8px); padding:9px 14px; border-radius:7px; background:rgba(20,20,24,.92); opacity:0; transition:.16s; pointer-events:none; }
  .toast[show] { opacity:1; transform:translate(-50%,0); }
  .stats { position:absolute; z-index:4; left:18px; top:70px; padding:10px 12px; border-radius:7px; background:rgba(20,20,24,.82); font-family:monospace; font-size:11px; line-height:1.5; white-space:pre; pointer-events:none; max-width:60%; overflow:hidden; }
  .stats[hidden] { display:none; }
  .subtitles { position:absolute; z-index:4; left:5%; right:5%; bottom:var(--subtitle-bottom,8%); display:flex; flex-direction:column; align-items:center; gap:.25em; pointer-events:none; text-align:center; font-family:var(--subtitle-font,system-ui,sans-serif); font-size:calc(var(--subtitle-scale,1) * 4cqh); line-height:1.3; color:var(--subtitle-colour,#fff); }
  .subtitles:empty { display:none; }
  .subtitle-line { display:inline-block; padding:.1em .4em; border-radius:4px; max-width:100%; }
  :host([subtitle-background=soft]) .subtitle-line { background:rgba(0,0,0,.55); }
  :host([subtitle-background=solid]) .subtitle-line { background:#000; }
  :host([subtitle-edge=outline]) .subtitles { paint-order:stroke fill; -webkit-text-stroke:.09em #000; }
  :host([subtitle-edge=shadow]) .subtitles { text-shadow:0 .06em .12em #000, 0 0 .3em rgba(0,0,0,.8); }
  ::slotted([slot=page-captions]) { position:absolute!important; inset:0!important; z-index:4!important; pointer-events:none!important; }
  .menu { position:absolute; z-index:7; right:16px; bottom:96px; min-width:190px; max-height:56%; overflow:auto; padding:6px; border-radius:8px; background:#2b2a33; box-shadow:0 8px 30px rgba(0,0,0,.5); }
  .menu[hidden] { display:none; }
  .menu-item { display:block; width:100%; text-align:left; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .quality-button { min-width:56px; font-size:12px; }
  .panel { position:absolute; z-index:6; inset:0 0 0 auto; width:min(420px,94vw); overflow:auto; padding:22px; background:#2b2a33; box-shadow:-8px 0 30px rgba(0,0,0,.4); }
  .panel[hidden] { display:none; }
  .panel-title { display:flex; align-items:center; justify-content:space-between; font-size:18px; margin-bottom:18px; }
  .panel label { display:flex; align-items:center; justify-content:space-between; gap:18px; min-height:46px; border-bottom:1px solid rgba(255,255,255,.12); }
  .panel label > span { display:flex; align-items:center; gap:8px; }
  .panel input[type=number] { width:78px; padding:6px; color:#fbfbfe; background:#1c1b22; border:1px solid #8f8f9d; border-radius:4px; }
  .panel select { background:#1c1b22; border:1px solid #8f8f9d; }
  .panel input[type=range] { width:110px; vertical-align:middle; }
  .panel output { display:inline-block; width:44px; font-size:12px; }
  .panel p { color:#b1b1b3; line-height:1.45; font-size:12px; }
  .extras { border:0; padding:0; margin:14px 0 0; }
  .extras legend { color:#b1b1b3; font-size:12px; padding:0; }
  @media (max-width:900px) { .youtube-control,.chapter { display:none; } }
  @media (max-width:700px) { .volume,.quality,.control-row [data-action=pip] { display:none; } footer { padding-inline:10px; } header { padding-inline:10px; } }
`;

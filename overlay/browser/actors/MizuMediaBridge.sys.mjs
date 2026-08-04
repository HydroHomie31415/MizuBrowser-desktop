/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reads subtitle tracks and quality levels out of whatever is driving the
 * page's `<video>`.
 *
 * A plain `<video>` has no notion of quality at all, and streaming sites rarely
 * leave their subtitles in it either: an adaptive stream carries both inside
 * the manifest, and the site's player decides what reaches the element. So the
 * player asks, in order, YouTube's player, JW Player's public API, an hls.js
 * instance, and finally the element's own text tracks.
 *
 * Everything here crosses into page script, which is untrusted. Values shown
 * in Mizu are flattened to primitives and every call is wrapped. The sole
 * object passed to a page is a YouTube caption descriptor that the same player
 * returned; Mizu never adds privileged properties or callbacks to it.
 */
export class MizuMediaBridge {
  /**
   * @param {HTMLVideoElement} video The page's video element.
   * @param {Window} window The content window it belongs to.
   */
  constructor(video, window) {
    this.video = video;
    this.window = window;
    this.document = video.ownerDocument;
    // Xray wrappers show only the standard shape of a window or an element, so
    // the site's own player object and the instance it hangs off the video are
    // both invisible without waiving them. Everything read back through these
    // is treated as hostile input.
    this.page = window.wrappedJSObject;
    this.pageVideo = video.wrappedJSObject ?? video;
    this.generatedTracks = new Map();
    this.failedTracks = new Map();
    this.pendingTrack = "";
  }

  /**
   * Subtitle tracks the user could pick.
   *
   * @returns {object[]} `{ id, label, language, active }`, most useful first.
   */
  subtitleTracks() {
    let tracks = [
      ...this.#youtubeCaptions(),
      ...this.#jwCaptions(),
      ...this.#hlsSubtitles(),
    ];
    // Native tracks are listed last because an adaptive player usually mirrors
    // its own list into them, and its labels are the better ones.
    let native = this.#nativeTracks();
    if (!tracks.length) {
      tracks = native;
    }
    return tracks;
  }

  /**
   * Selects a subtitle track, or turns subtitles off.
   *
   * @param {string} id An id from {@link subtitleTracks}, or "off".
   * @returns {boolean} Whether anything accepted the change.
   */
  selectSubtitle(id) {
    let [source, index] = splitId(id);
    let done = false;

    if (source == "youtube") {
      done = this.#selectYouTubeCaption(index);
    } else if (source == "jw") {
      done = this.#call(this.#jw(), "setCurrentCaptions", index + 1);
    } else if (source == "hls") {
      done = this.#set(this.#hls(), "subtitleTrack", index);
    } else if (source == "off") {
      done =
        this.#disableYouTubeCaptions() ||
        this.#call(this.#jw(), "setCurrentCaptions", 0) ||
        this.#set(this.#hls(), "subtitleTrack", -1);
    }

    // The site's player is asked first because only it can fetch a subtitle
    // rendition that has not been loaded yet. Its answer is not trusted to
    // arrive though: the text tracks are what the overlay draws from, so the
    // same choice is mapped onto them directly whenever a match exists.
    this.#applyNativeModes(
      source == "off" ? -1 : this.#nativeIndexFor(source, index),
      source == "off"
    );
    return done || source == "native" || source == "off";
  }

  /**
   * Finds the text track that corresponds to a choice made from another list.
   *
   * @param {string} source Which list the choice came from.
   * @param {number} index Its position in that list.
   * @returns {number} An index into `video.textTracks`, or -1.
   */
  #nativeIndexFor(source, index) {
    let native = this.#nativeTracks();
    if (source == "native") {
      return index;
    }
    let external = this.#hlsSubtitles();
    if (source == "youtube") {
      external = this.#youtubeCaptions();
    } else if (source == "jw") {
      external = this.#jwCaptions();
    }
    let chosen = external[index];
    if (!native.length || !chosen) {
      return -1;
    }
    // Language is the only field the two lists reliably agree on; position is
    // the fallback, and only when both lists describe the same set.
    let byLanguage =
      chosen.language &&
      native.find(track => track.language && track.language == chosen.language);
    if (byLanguage) {
      return Number(byLanguage.id.split(":")[1]);
    }
    let sameShape = native.length == external.length;
    return sameShape ? Number(native[index]?.id.split(":")[1] ?? -1) : -1;
  }

  /**
   * The text track whose cues should be drawn, already switched to "hidden" so
   * that Gecko does not also draw them behind the player's own overlay.
   *
   * @returns {TextTrack|null}
   */
  activeTextTrack() {
    let tracks = this.video.textTracks;
    for (let index = 0; index < tracks.length; index++) {
      let track = tracks[index];
      if (!isSubtitle(track) || track.mode == "disabled") {
        continue;
      }
      if (track.mode == "showing") {
        track.mode = "hidden";
      }
      return track;
    }
    return null;
  }

  /**
   * Gives JW Player captions a real TextTrack for Mizu to render.
   *
   * JW renders WebVTT into its own DOM without attaching it to the video. That
   * renderer stops advancing once the video leaves JW's container, so Mizu
   * fetches the selected VTT file, gives it a same-origin blob URL, and lets
   * Gecko parse and time the cues instead.
   */
  prepareActiveTextTrack() {
    let player = this.#jw();
    let current = Number(this.#call(player, "getCurrentCaptions")) || 0;
    if (!player || current < 1) {
      return;
    }
    let config = this.#call(player, "getConfig");
    let descriptor;
    try {
      descriptor = config?.tracks?.[current - 1];
    } catch (_) {
      return;
    }
    let file = subtitleFile(descriptor?.file);
    if (!file) {
      return;
    }
    let existing = this.generatedTracks.get(file);
    if (existing) {
      this.#activateGeneratedTrack(file);
      return;
    }
    if (this.pendingTrack == file) {
      return;
    }
    let failedAt = this.failedTracks.get(file) || 0;
    if (Date.now() - failedAt < SUBTITLE_RETRY_MS) {
      return;
    }
    this.pendingTrack = file;
    this.#loadTextTrack(file, descriptor).finally(() => {
      if (this.pendingTrack == file) {
        this.pendingTrack = "";
      }
    });
  }

  /** Removes blob-backed tracks created by {@link prepareActiveTextTrack}. */
  destroy() {
    for (let { element, url } of this.generatedTracks.values()) {
      element.remove();
      this.window.URL.revokeObjectURL(url);
    }
    this.generatedTracks.clear();
    this.failedTracks.clear();
    this.pendingTrack = "";
  }

  /**
   * Quality levels the user could pick.
   *
   * @returns {object[]} `{ id, label, height, active }`, highest first.
   */
  qualityLevels() {
    let levels = this.#youtubeQualities();
    if (!levels.length) {
      levels = this.#jwQualities();
    }
    if (!levels.length) {
      levels = this.#hlsLevels();
    }
    return levels;
  }

  /**
   * Selects a quality level.
   *
   * @param {string} id An id from {@link qualityLevels}, or "auto".
   * @returns {boolean} Whether anything accepted the change.
   */
  selectQuality(id) {
    let [source, index] = splitId(id);
    if (source == "auto") {
      // JW keeps "Auto" at index 0 of its own list; hls.js spells it -1.
      return (
        this.#setYouTubeQuality("auto") ||
        this.#call(this.#jw(), "setCurrentQuality", 0) ||
        this.#set(this.#hls(), "currentLevel", -1)
      );
    }
    if (source == "youtube") {
      return this.#setYouTubeQuality(String(id).slice("youtube:".length));
    }
    if (source == "jw") {
      return this.#call(this.#jw(), "setCurrentQuality", index);
    }
    if (source == "hls") {
      return this.#set(this.#hls(), "currentLevel", index);
    }
    return false;
  }

  /** True when some media stack was found that can answer at all. */
  get available() {
    return !!(this.#youtube() || this.#jw() || this.#hls());
  }

  /** Chapters published by YouTube for the current video. */
  chapters() {
    let response = this.#call(this.#youtube(), "getPlayerResponse");
    try {
      let maps =
        response?.playerOverlays?.playerOverlayRenderer
          ?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer?.playerBar
          ?.multiMarkersPlayerBarRenderer?.markersMap;
      if (!maps?.length) {
        return [];
      }
      let map = [...maps].find(entry =>
        /CHAPTERS/.test(text(entry?.key).toUpperCase())
      );
      let chapters = map?.value?.chapters;
      if (!chapters?.length) {
        return [];
      }
      return [...chapters]
        .map(entry => entry?.chapterRenderer)
        .filter(Boolean)
        .map(chapter => ({
          start: Math.max(0, Number(chapter.timeRangeStartMillis) / 1000 || 0),
          title: richText(chapter.title) || "Chapter",
        }))
        .filter((chapter, index, list) =>
          index == 0
            ? chapter.start == 0
            : chapter.start > list[index - 1].start
        );
    } catch (_) {
      return [];
    }
  }

  /** Playlist state used by the player's previous/next controls. */
  playlistState() {
    let player = this.#youtube();
    let list = this.#call(player, "getPlaylist");
    let index = Number(this.#call(player, "getPlaylistIndex"));
    if (!list?.length || list.length < 2 || !Number.isInteger(index)) {
      return { available: false, previous: false, next: false };
    }
    return {
      available: true,
      previous: index > 0,
      next: index < list.length - 1,
    };
  }

  selectPlaylistVideo(direction) {
    let player = this.#youtube();
    return direction < 0
      ? this.#called(player, "previousVideo")
      : this.#called(player, "nextVideo");
  }

  // -- page objects ---------------------------------------------------------

  #youtube() {
    try {
      if (
        !/(^|\.)youtube(?:-nocookie)?\.com$/.test(this.window.location.hostname)
      ) {
        return null;
      }
      let player = this.document?.getElementById?.("movie_player");
      if (!player) {
        player = this.video.closest?.("#movie_player");
      }
      player = player?.wrappedJSObject ?? player;
      return typeof player?.getAvailableQualityLevels == "function"
        ? player
        : null;
    } catch (_) {
      return null;
    }
  }

  #jw() {
    try {
      let factory = this.page?.jwplayer;
      if (typeof factory != "function") {
        return null;
      }
      let player = factory();
      return player && typeof player.getQualityLevels == "function"
        ? player
        : null;
    } catch (_) {
      return null;
    }
  }

  #hls() {
    // hls.js does not publish itself anywhere standard, so the handful of names
    // that players actually use are tried rather than the whole global scope.
    for (let holder of [this.pageVideo, this.page, this.page?.player]) {
      for (let name of ["hls", "hlsjs", "_hls"]) {
        try {
          let candidate = holder?.[name];
          if (candidate?.levels && "currentLevel" in candidate) {
            return candidate;
          }
        } catch (_) {}
      }
    }
    return null;
  }

  // -- readers --------------------------------------------------------------

  #youtubeCaptions() {
    let player = this.#youtube();
    let list = this.#call(player, "getOption", "captions", "tracklist");
    let current = this.#call(player, "getOption", "captions", "track");
    if (!list?.length) {
      return [];
    }
    try {
      let currentId = youtubeCaptionId(current);
      return [...list].slice(0, 100).map((track, index) => ({
        id: `youtube:${index}`,
        label:
          richText(track?.displayName) ||
          richText(track?.languageName) ||
          text(track?.languageCode) ||
          `Track ${index + 1}`,
        language: text(track?.languageCode),
        active: !!currentId && youtubeCaptionId(track) == currentId,
      }));
    } catch (_) {
      return [];
    }
  }

  #youtubeQualities() {
    let player = this.#youtube();
    let list = this.#call(player, "getAvailableQualityLevels");
    let current = text(this.#call(player, "getPlaybackQuality"));
    if (!list?.length) {
      return [];
    }
    try {
      return [...list]
        .map(value => text(value))
        .filter(value => value && value != "auto")
        .map(value => ({
          id: `youtube:${value}`,
          label: youtubeQualityLabel(value),
          height: YOUTUBE_QUALITY_HEIGHTS[value] || heightFromLabel(value),
          active: value == current,
        }))
        .sort((a, b) => b.height - a.height);
    } catch (_) {
      return [];
    }
  }

  #nativeTracks() {
    let out = [];
    let tracks = this.video.textTracks;
    for (let index = 0; index < tracks.length; index++) {
      let track = tracks[index];
      if (!isSubtitle(track)) {
        continue;
      }
      out.push({
        id: `native:${index}`,
        label:
          text(track.label) || text(track.language) || `Track ${index + 1}`,
        language: text(track.language),
        active: track.mode != "disabled",
      });
    }
    return out;
  }

  #jwCaptions() {
    let player = this.#jw();
    if (!player) {
      return [];
    }
    let list = this.#call(player, "getCaptionsList") || [];
    let current = Number(this.#call(player, "getCurrentCaptions")) || 0;
    let out = [];
    // Index 0 is JW's own "Off" entry; the player supplies its own.
    for (let index = 1; index < list.length; index++) {
      out.push({
        id: `jw:${index - 1}`,
        label: text(list[index]?.label) || `Track ${index}`,
        language: text(list[index]?.language),
        active: current == index,
      });
    }
    return out;
  }

  #hlsSubtitles() {
    let hls = this.#hls();
    let list = hls?.subtitleTracks;
    if (!list?.length) {
      return [];
    }
    let current = Number(hls.subtitleTrack);
    let out = [];
    for (let index = 0; index < list.length; index++) {
      out.push({
        id: `hls:${index}`,
        label:
          text(list[index]?.name) ||
          text(list[index]?.lang) ||
          `Track ${index + 1}`,
        language: text(list[index]?.lang),
        active: current == index,
      });
    }
    return out;
  }

  #jwQualities() {
    let player = this.#jw();
    if (!player) {
      return [];
    }
    let list = this.#call(player, "getQualityLevels") || [];
    let current = Number(this.#call(player, "getCurrentQuality"));
    let out = [];
    for (let index = 0; index < list.length; index++) {
      let level = list[index];
      let label = text(level?.label);
      // JW's first entry is "Auto"; the player offers that separately.
      if (index == 0 && /auto/i.test(label)) {
        continue;
      }
      let height = Number(level?.height) || heightFromLabel(label);
      out.push({
        id: `jw:${index}`,
        label: label || (height ? `${height}p` : `Level ${index}`),
        height,
        active: current == index,
      });
    }
    return out.sort((a, b) => b.height - a.height);
  }

  #hlsLevels() {
    let hls = this.#hls();
    let list = hls?.levels;
    if (!list?.length) {
      return [];
    }
    let current = Number(hls.currentLevel);
    let out = [];
    for (let index = 0; index < list.length; index++) {
      let height = Number(list[index]?.height) || 0;
      out.push({
        id: `hls:${index}`,
        label: height
          ? `${height}p`
          : text(list[index]?.name) || `Level ${index + 1}`,
        height,
        active: current == index,
      });
    }
    return out.sort((a, b) => b.height - a.height);
  }

  // -- writers --------------------------------------------------------------

  async #loadTextTrack(file, descriptor) {
    let objectURL = "";
    let element = null;
    try {
      let url = new this.window.URL(file, this.window.location.href);
      if (url.protocol != "https:" && url.protocol != "http:") {
        return;
      }
      let response = await this.window.fetch(url.href, {
        credentials: "omit",
      });
      if (!response.ok) {
        throw new Error(`Subtitle request failed: ${response.status}`);
      }
      let body = await this.#limitedText(response);
      if (!/^\uFEFF?WEBVTT(?:[ \t]|\r?$)/m.test(body.slice(0, 80))) {
        throw new Error("Subtitle response is not WebVTT");
      }
      objectURL = this.window.URL.createObjectURL(
        new this.window.Blob([body], { type: "text/vtt" })
      );
      element = this.document.createElement("track");
      element.kind = "subtitles";
      element.label = text(descriptor?.label) || "Subtitles";
      element.srclang = text(descriptor?.language);
      element.src = objectURL;
      this.video.appendChild(element);
      // Hidden tracks are parsed and fire cuechange without Gecko drawing a
      // second copy behind Mizu's subtitle overlay.
      this.generatedTracks.set(file, { element, url: objectURL });
      this.failedTracks.delete(file);
      if (this.#activeJwSubtitleFile() == file) {
        this.#activateGeneratedTrack(file);
      } else {
        element.track.mode = "disabled";
      }
    } catch (_) {
      element?.remove();
      if (objectURL) {
        this.window.URL.revokeObjectURL(objectURL);
      }
      this.failedTracks.set(file, Date.now());
    }
  }

  async #limitedText(response) {
    let declared = Number(response.headers.get("content-length")) || 0;
    if (declared > MAX_SUBTITLE_BYTES) {
      throw new Error("Subtitle response is too large");
    }
    let reader = response.body?.getReader();
    if (!reader) {
      let textBody = await response.text();
      if (textBody.length > MAX_SUBTITLE_BYTES) {
        throw new Error("Subtitle response is too large");
      }
      return textBody;
    }
    let decoder = new this.window.TextDecoder();
    let body = "";
    let size = 0;
    while (true) {
      let { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_SUBTITLE_BYTES) {
        await reader.cancel();
        throw new Error("Subtitle response is too large");
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  }

  #activateGeneratedTrack(file) {
    for (let [candidate, { element }] of this.generatedTracks) {
      element.track.mode = candidate == file ? "hidden" : "disabled";
    }
  }

  #activeJwSubtitleFile() {
    let player = this.#jw();
    let current = Number(this.#call(player, "getCurrentCaptions")) || 0;
    if (current < 1) {
      return "";
    }
    let config = this.#call(player, "getConfig");
    try {
      return subtitleFile(config?.tracks?.[current - 1]?.file);
    } catch (_) {
      return "";
    }
  }

  #selectYouTubeCaption(index) {
    let player = this.#youtube();
    let list = this.#call(player, "getOption", "captions", "tracklist");
    let track;
    try {
      track = list?.[index];
    } catch (_) {
      return false;
    }
    if (!track) {
      return false;
    }
    this.#called(player, "loadModule", "captions");
    return this.#called(player, "setOption", "captions", "track", track);
  }

  #disableYouTubeCaptions() {
    let player = this.#youtube();
    return this.#called(player, "unloadModule", "captions");
  }

  #setYouTubeQuality(quality) {
    let player = this.#youtube();
    if (!player) {
      return false;
    }
    // Current YouTube uses the range setter to pin a rendition. Calling the
    // older setter too keeps this working with embeds and older player builds.
    let ranged = this.#called(
      player,
      "setPlaybackQualityRange",
      quality,
      quality
    );
    let selected = this.#called(player, "setPlaybackQuality", quality);
    return ranged || selected;
  }

  #applyNativeModes(chosen, off) {
    let tracks = this.video.textTracks;
    for (let index = 0; index < tracks.length; index++) {
      let track = tracks[index];
      if (!isSubtitle(track)) {
        continue;
      }
      if (off) {
        track.mode = "disabled";
      } else if (chosen >= 0) {
        // "hidden" still fires cuechange, which is what the overlay draws from.
        track.mode = index == chosen ? "hidden" : "disabled";
      }
    }
  }

  #call(object, method, ...args) {
    try {
      if (typeof object?.[method] != "function") {
        return null;
      }
      return object[method](...args);
    } catch (_) {
      return null;
    }
  }

  #called(object, method, ...args) {
    try {
      if (typeof object?.[method] != "function") {
        return false;
      }
      object[method](...args);
      return true;
    } catch (_) {
      return false;
    }
  }

  #set(object, property, value) {
    try {
      if (!object || !(property in object)) {
        return false;
      }
      object[property] = value;
      return true;
    } catch (_) {
      return false;
    }
  }
}

/**
 * Picks the level closest to what the user asked for without going over, and
 * the smallest available one when every level is bigger.
 *
 * @param {object[]} levels Output of {@link MizuMediaBridge#qualityLevels}.
 * @param {number} preferred Target height in pixels; 0 means leave it on auto.
 * @returns {object|null} The level to select.
 */
export function preferredLevel(levels, preferred) {
  if (!preferred || !levels.length) {
    return null;
  }
  let withHeights = levels.filter(level => level.height > 0);
  if (!withHeights.length) {
    return null;
  }
  let atOrBelow = withHeights.filter(level => level.height <= preferred);
  return atOrBelow.length ? atOrBelow[0] : withHeights[withHeights.length - 1];
}

function splitId(id) {
  let [source, index] = String(id ?? "").split(":");
  return [source, Number(index)];
}

function isSubtitle(track) {
  return track.kind == "subtitles" || track.kind == "captions";
}

/** Page values are untrusted, so they are flattened to short plain strings. */
function text(value) {
  if (typeof value != "string" && typeof value != "number") {
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim().slice(0, 60);
}

function subtitleFile(value) {
  return typeof value == "string" ? value.trim().slice(0, 4096) : "";
}

const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
const SUBTITLE_RETRY_MS = 30_000;

function heightFromLabel(label) {
  let match = /(\d{3,4})p?\b/.exec(label || "");
  return match ? Number(match[1]) : 0;
}

function richText(value) {
  try {
    let direct = text(value?.simpleText);
    if (direct) {
      return direct;
    }
    if (value?.runs?.length) {
      return text([...value.runs].map(run => text(run?.text)).join(""));
    }
    return text(value);
  } catch (_) {
    return "";
  }
}

function youtubeCaptionId(track) {
  try {
    return [track?.vssId, track?.languageCode, track?.kind].map(text).join("|");
  } catch (_) {
    return "";
  }
}

function youtubeQualityLabel(quality) {
  let height = YOUTUBE_QUALITY_HEIGHTS[quality];
  if (!height) {
    return quality;
  }
  return `${height}p${height >= 720 ? " HD" : ""}`;
}

const YOUTUBE_QUALITY_HEIGHTS = {
  highres: 4320,
  hd4320: 4320,
  hd2880: 2880,
  hd2160: 2160,
  hd1440: 1440,
  hd1080: 1080,
  hd720: 720,
  large: 480,
  medium: 360,
  small: 240,
  tiny: 144,
};

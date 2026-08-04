/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";

const STORAGE_PREF = "mizu.continue-watching.entries";
const ENABLED_PREF = "mizu.continue-watching.enabled";
const MAX_ITEMS_PREF = "mizu.continue-watching.max-items";
const MINIMUM_POSITION = 15;
const MINIMUM_DURATION = 60;
const COMPLETE_RATIO = 0.95;
const COMPLETE_REMAINING = 30;

/**
 * A deliberately small, local-only watch history for Mizu's start page.
 *
 * Entries live in the profile rather than Places: a page visit is not the
 * same thing as watching a video, and clearing ordinary history should not
 * require Activity Stream to reconstruct playback progress. Private windows
 * never read or write the list.
 */
export const MizuContinueWatching = {
  entriesForBrowser(browser) {
    if (
      !browser ||
      PrivateBrowsingUtils.isBrowserPrivate(browser) ||
      !Services.prefs.getBoolPref(ENABLED_PREF, true)
    ) {
      return [];
    }
    return readEntries().map(entry => ({
      ...entry,
      resumeURL: resumeURL(entry),
      progress: Math.max(
        0,
        Math.min(1, entry.position / Math.max(1, entry.duration))
      ),
    }));
  },

  record(browser, update) {
    if (
      !browser ||
      PrivateBrowsingUtils.isBrowserPrivate(browser) ||
      !Services.prefs.getBoolPref(ENABLED_PREF, true)
    ) {
      return;
    }

    let url = safeHTTPURL(browser.currentURI?.spec);
    let duration = finiteNumber(update?.duration);
    let position = finiteNumber(update?.position);
    if (!url || duration < MINIMUM_DURATION || position < 0) {
      return;
    }

    let entries = readEntries();
    let index = entries.findIndex(entry => entry.url == url);
    let complete =
      update?.ended ||
      position / duration >= COMPLETE_RATIO ||
      duration - position <= COMPLETE_REMAINING;
    if (complete) {
      if (index >= 0) {
        entries.splice(index, 1);
        writeEntries(entries);
      }
      return;
    }
    if (position < MINIMUM_POSITION && index < 0) {
      return;
    }

    let title = cleanText(browser.contentTitle || update?.title, 240);
    if (!title) {
      try {
        title = new URL(url).hostname.replace(/^www\./, "");
      } catch (_) {
        title = "Video";
      }
    }
    let thumbnail = youtubeThumbnail(url) || safeHTTPURL(update?.thumbnail);
    let next = {
      url,
      title,
      thumbnail,
      position: Math.min(position, duration),
      duration,
      lastPlayed: Date.now(),
    };

    if (index >= 0) {
      entries.splice(index, 1);
    }
    entries.unshift(next);
    let maximum = Math.max(
      1,
      Math.min(24, Services.prefs.getIntPref(MAX_ITEMS_PREF, 8))
    );
    writeEntries(entries.slice(0, maximum));
  },
};

function readEntries() {
  let parsed;
  try {
    parsed = JSON.parse(Services.prefs.getStringPref(STORAGE_PREF, "[]"));
  } catch (_) {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .slice(0, 24)
    .map(entry => sanitizeEntry(entry))
    .filter(Boolean)
    .sort((a, b) => b.lastPlayed - a.lastPlayed);
}

function writeEntries(entries) {
  Services.prefs.setStringPref(STORAGE_PREF, JSON.stringify(entries));
}

function sanitizeEntry(entry) {
  let url = safeHTTPURL(entry?.url);
  let title = cleanText(entry?.title, 240);
  let duration = finiteNumber(entry?.duration);
  let position = finiteNumber(entry?.position);
  let lastPlayed = finiteNumber(entry?.lastPlayed);
  if (!url || !title || duration < MINIMUM_DURATION || position < 0) {
    return null;
  }
  return {
    url,
    title,
    thumbnail: safeHTTPURL(entry?.thumbnail),
    duration,
    position: Math.min(position, duration),
    lastPlayed,
  };
}

function safeHTTPURL(value) {
  if (typeof value != "string" || value.length > 4096) {
    return "";
  }
  try {
    let url = new URL(value);
    return url.protocol == "http:" || url.protocol == "https:" ? url.href : "";
  } catch (_) {
    return "";
  }
}

function cleanText(value, maximum) {
  return typeof value == "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maximum)
    : "";
}

function finiteNumber(value) {
  value = Number(value);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function youtubeThumbnail(spec) {
  try {
    let url = new URL(spec);
    if (!/(^|\.)youtube(?:-nocookie)?\.com$/.test(url.hostname)) {
      return "";
    }
    let id =
      url.searchParams.get("v") ||
      /^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,})/.exec(url.pathname)?.[1];
    return id && /^[A-Za-z0-9_-]{6,}$/.test(id)
      ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
      : "";
  } catch (_) {
    return "";
  }
}

function resumeURL(entry) {
  try {
    let url = new URL(entry.url);
    if (
      /(^|\.)youtube(?:-nocookie)?\.com$/.test(url.hostname) &&
      url.pathname == "/watch"
    ) {
      url.searchParams.set("t", `${Math.max(0, Math.floor(entry.position))}s`);
    }
    return url.href;
  } catch (_) {
    return entry.url;
  }
}

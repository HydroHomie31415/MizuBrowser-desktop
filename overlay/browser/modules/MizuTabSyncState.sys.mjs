/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tab set two paired Mizu devices share.
 *
 * Both devices hold the whole set and merge every exchange into it, so the
 * rules here are written to reach the same answer on either side no matter
 * which order the two ends see a change in. Nothing in this file touches
 * Gecko: the merge is the part worth reasoning about on its own, and it is the
 * part the phone reimplements, so it stays separable from the service that
 * drives windows and sockets around it.
 *
 * A tab is a record, not a position in a list. Each carries a revision counter
 * rather than a timestamp, because the two devices have unrelated clocks and a
 * phone whose clock is a minute fast must not win every conflict for a minute.
 * A device that changes a tab sets the revision one past the highest it has
 * seen for that tab, which is a Lamport clock: concurrent edits collide at the
 * same number and are broken by a rule both ends apply identically.
 */

export const PROTOCOL_VERSION = 2;

// A closed tab has to be remembered rather than forgotten: the other device is
// still advertising it as open, and a set that only carries open tabs would
// take that as an instruction to reopen it. The record therefore survives its
// tab, and is dropped only once no device can still be carrying the open
// version of it.
export const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_LIVE_RECORDS = 100;
export const MAX_TOMBSTONES = 200;
export const MAX_URL_LENGTH = 2000;
export const MAX_TITLE_LENGTH = 512;
export const MAX_ID_LENGTH = 128;

/**
 * Pages that mean something on both devices. Everything else — `about:` pages,
 * `file:` paths, extension URLs — either does not exist on the other device or
 * refers to a place only this one can reach.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isShareableURL(value) {
  if (typeof value != "string" || value.length > MAX_URL_LENGTH) {
    return false;
  }
  try {
    let url = new URL(value);
    return url.protocol == "http:" || url.protocol == "https:";
  } catch (_) {
    return false;
  }
}

/**
 * Which of two versions of the same tab both devices keep.
 *
 * @param {object} a
 * @param {object} b
 * @returns {object} Whichever of the two wins; `a` when they are equivalent.
 */
export function winner(a, b) {
  if (a.rev != b.rev) {
    return a.rev > b.rev ? a : b;
  }
  // Closing is the one change that cannot be undone by a later edit to the
  // same record — reopening a tab produces a new record — so a close that
  // collides with an edit takes it. The alternative loses the close, and a tab
  // that will not stay closed is far worse than an edit that does not land.
  if (!!a.closed != !!b.closed) {
    return a.closed ? a : b;
  }
  // Two devices editing the same tab at the same revision. The winner has to
  // be picked from the records themselves, since neither device can see which
  // edit came first, and both have to pick the same one.
  if (a.by != b.by) {
    return a.by > b.by ? a : b;
  }
  return a;
}

/**
 * A record from another device, reduced to what this one is willing to hold.
 * Anything malformed is dropped rather than repaired: it came off a socket.
 *
 * @param {object} value
 * @returns {object|null}
 */
export function sanitizeRecord(value) {
  if (
    !value ||
    typeof value.id != "string" ||
    !value.id ||
    value.id.length > MAX_ID_LENGTH ||
    !Number.isSafeInteger(value.rev) ||
    value.rev < 1
  ) {
    return null;
  }
  let record = {
    id: value.id,
    rev: value.rev,
    by: typeof value.by == "string" ? value.by.slice(0, MAX_ID_LENGTH) : "",
    ts: Number.isSafeInteger(value.ts) ? value.ts : 0,
    closed: !!value.closed,
    url: "",
    title: "",
  };
  if (record.closed) {
    return record;
  }
  if (!isShareableURL(value.url)) {
    return null;
  }
  record.url = value.url;
  record.title =
    typeof value.title == "string" && value.title
      ? value.title.slice(0, MAX_TITLE_LENGTH)
      : value.url;
  return record;
}

export class TabSyncState {
  /**
   * @param {string} deviceId
   *   This device's identifier. It breaks ties between edits made at the same
   *   revision, so it has to be the same value for the life of the pairing.
   */
  constructor(deviceId) {
    this.deviceId = deviceId;
    this.records = new Map();
    // Bumped by every change, from either side. The service hands it to
    // clients so a device that is already current can be left waiting instead
    // of being answered with a copy of what it just sent.
    this.version = 0;
  }

  get live() {
    return [...this.records.values()].filter(record => !record.closed);
  }

  get(id) {
    return this.records.get(id);
  }

  /**
   * Record what a local tab now looks like.
   *
   * Callers hand over what they observe rather than what they changed, so this
   * is also the guard against echoes: a tab that navigated because the other
   * device asked it to reports the URL the record already holds, and nothing
   * happens.
   *
   * @param {string} id
   * @param {object} tab
   * @param {string} tab.url
   * @param {string} [tab.title]
   * @param {number} now
   * @returns {object|null} The new record, or null if nothing changed.
   */
  writeLocal(id, { url, title }, now = Date.now()) {
    if (!isShareableURL(url)) {
      return null;
    }
    let existing = this.records.get(id);
    // A closed record is final. A tab that outlives it is on its way out and
    // must not talk it back into existence on the other device.
    if (existing?.closed) {
      return null;
    }
    let label = (title || url).slice(0, MAX_TITLE_LENGTH);
    if (existing && existing.url == url && existing.title == label) {
      return null;
    }
    if (!existing && this.live.length >= MAX_LIVE_RECORDS) {
      return null;
    }
    return this.#write({
      id,
      url,
      title: label,
      rev: (existing?.rev || 0) + 1,
      by: this.deviceId,
      ts: now,
      closed: false,
    });
  }

  /**
   * Record that a local tab was closed.
   *
   * @param {string} id
   * @param {number} now
   * @returns {object|null} The tombstone, or null if the tab was already gone.
   */
  closeLocal(id, now = Date.now()) {
    let existing = this.records.get(id);
    if (!existing || existing.closed) {
      return null;
    }
    return this.#write({
      id,
      url: "",
      title: "",
      rev: existing.rev + 1,
      by: this.deviceId,
      ts: now,
      closed: true,
    });
  }

  /**
   * Fold another device's copy of the set into this one.
   *
   * @param {object[]} incoming
   * @param {number} now
   * @returns {boolean} Whether anything in the set changed.
   */
  merge(incoming, now = Date.now()) {
    let changed = false;
    for (let value of incoming) {
      let record = sanitizeRecord(value);
      if (!record) {
        continue;
      }
      let existing = this.records.get(record.id);
      if (existing) {
        if (winner(existing, record) === existing) {
          continue;
        }
      } else if (record.closed) {
        // A tombstone for a tab this device never saw. Keeping it is what
        // stops the tab arriving later, over a link that was down while it was
        // both opened and closed.
        if (now - record.ts > TOMBSTONE_TTL_MS) {
          continue;
        }
      } else if (this.live.length >= MAX_LIVE_RECORDS) {
        continue;
      }
      this.#write(record);
      changed = true;
    }
    return changed;
  }

  /**
   * Drop tombstones no device can still need, oldest first.
   *
   * @param {number} now
   * @returns {boolean} Whether anything was dropped.
   */
  prune(now = Date.now()) {
    let kept = [];
    let dropped = [];
    for (let record of this.records.values()) {
      if (!record.closed) {
        continue;
      }
      if (now - record.ts > TOMBSTONE_TTL_MS) {
        dropped.push(record);
      } else {
        kept.push(record);
      }
    }
    kept.sort((a, b) => a.ts - b.ts);
    dropped.push(...kept.slice(0, Math.max(0, kept.length - MAX_TOMBSTONES)));
    for (let record of dropped) {
      this.records.delete(record.id);
    }
    if (dropped.length) {
      this.version++;
    }
    return !!dropped.length;
  }

  /**
   * The set as it goes onto the wire and into the profile.
   *
   * @returns {object[]}
   */
  toJSON() {
    return [...this.records.values()];
  }

  /**
   * Replace the set with one read back from the profile.
   *
   * @param {object[]} records
   */
  load(records) {
    this.records.clear();
    for (let value of Array.isArray(records) ? records : []) {
      let record = sanitizeRecord(value);
      if (record) {
        this.records.set(record.id, record);
      }
    }
    this.version++;
  }

  #write(record) {
    this.records.set(record.id, record);
    this.version++;
    return record;
  }
}

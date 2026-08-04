/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import React from "react";

function formatTime(value) {
  let seconds = Math.max(0, Math.floor(Number(value) || 0));
  let hours = Math.floor(seconds / 3600);
  let minutes = Math.floor((seconds % 3600) / 60);
  let remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function MizuContinueWatching() {
  const entries = globalThis.__MIZU_CONTINUE_WATCHING__ || [];
  if (!entries.length) {
    return null;
  }

  return (
    <section
      className="mizu-continue-watching"
      aria-labelledby="mizu-continue-watching-title"
    >
      <h2 id="mizu-continue-watching-title">Continue watching</h2>
      <div className="mizu-continue-watching-list">
        {entries.map(entry => (
          <a
            className="mizu-continue-watching-card"
            href={entry.resumeURL || entry.url}
            key={entry.url}
            title={entry.title}
          >
            <span className="mizu-continue-watching-thumbnail">
              {entry.thumbnail ? (
                <img src={entry.thumbnail} alt="" loading="lazy" />
              ) : (
                <span
                  className="mizu-continue-watching-placeholder"
                  aria-hidden="true"
                >
                  ▶
                </span>
              )}
              <span className="mizu-continue-watching-time">
                {formatTime(entry.position)} / {formatTime(entry.duration)}
              </span>
              <span
                className="mizu-continue-watching-progress"
                aria-hidden="true"
              >
                <span
                  style={{ width: `${Math.round(entry.progress * 100)}%` }}
                />
              </span>
            </span>
            <span className="mizu-continue-watching-name">{entry.title}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

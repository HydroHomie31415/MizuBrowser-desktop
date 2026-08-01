#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_command git
[[ $FIREFOX_REVISION =~ ^[0-9a-f]{40}$ ]] || die "FIREFOX_REVISION must be a full 40-character Git commit"

if [[ ! -d "$FIREFOX_DIR/.git" ]]; then
  if [[ -e "$FIREFOX_DIR" ]] && [[ -n $(find "$FIREFOX_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null) ]]; then
    die "$FIREFOX_DIR exists and is not an empty Git checkout"
  fi

  note "Initializing Firefox checkout"
  mkdir -p "$FIREFOX_DIR"
  git -C "$FIREFOX_DIR" init
  git -C "$FIREFOX_DIR" remote add origin "$FIREFOX_REPOSITORY"
fi

origin=$(git -C "$FIREFOX_DIR" remote get-url origin 2>/dev/null || true)
[[ $origin == "$FIREFOX_REPOSITORY" ]] || die "Firefox origin is '$origin', expected '$FIREFOX_REPOSITORY'"

current=$(git -C "$FIREFOX_DIR" rev-parse HEAD 2>/dev/null || true)
if [[ $current == "$FIREFOX_REVISION" ]]; then
  note "Firefox is already at ${FIREFOX_REVISION:0:12}"
  exit 0
fi

tracked_changes=$(git -C "$FIREFOX_DIR" status --porcelain --untracked-files=no 2>/dev/null || true)
[[ -z $tracked_changes ]] || die "tracked Firefox files have local changes; save them as patches before switching revisions"

note "Fetching Firefox ${FIREFOX_REVISION:0:12} (the first checkout is large)"
git -C "$FIREFOX_DIR" fetch --depth=1 --filter=blob:none origin "$FIREFOX_REVISION"
git -C "$FIREFOX_DIR" checkout --detach FETCH_HEAD

note "Firefox source is ready"


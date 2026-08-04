#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

printf 'mode:        %s\n' "$(build_mode)"
printf 'mozconfig:   %s\n' "$(mozconfig_path)"
printf 'repository:  %s\n' "$FIREFOX_REPOSITORY"
printf 'revision:    %s\n' "$FIREFOX_REVISION"
printf 'checkout:    %s\n' "$FIREFOX_DIR"

printf 'branch:      %s\n' "$FIREFOX_BRANCH"

auto_update_state="$PROJECT_ROOT/.cache/auto-update/state.env"
if [[ -f $auto_update_state ]]; then
  # shellcheck disable=SC1090
  (
    source "$auto_update_state"
    printf 'auto-update: %s at %s\n' "${LAST_RESULT:-unknown}" "${LAST_RUN:-unknown}"
    [[ -n ${STAGED_PACKAGE:-} ]] && printf 'staged:      %s\n' "$STAGED_PACKAGE"
  )
else
  printf 'auto-update: never run\n'
fi

if [[ -d "$FIREFOX_DIR/.git" ]]; then
  printf 'source HEAD: %s\n' "$(git -C "$FIREFOX_DIR" rev-parse HEAD 2>/dev/null || printf unknown)"
  git -C "$FIREFOX_DIR" status --short
else
  printf 'source HEAD: not fetched\n'
fi


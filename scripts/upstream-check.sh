#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_command git
latest=$(git ls-remote "$FIREFOX_REPOSITORY" "refs/heads/$FIREFOX_BRANCH" | awk 'NR == 1 { print $1 }')
[[ $latest =~ ^[0-9a-f]{40}$ ]] || die "could not resolve upstream $FIREFOX_BRANCH"

printf 'pinned: %s\n' "$FIREFOX_REVISION"
printf 'latest: %s\n' "$latest"
if [[ $latest == "$FIREFOX_REVISION" ]]; then
  note "Mizu is pinned to the current upstream $FIREFOX_BRANCH commit"
else
  note "An upstream update is available"
  printf 'After review, set FIREFOX_REVISION=%s in config/upstream.env.\n' "$latest"
fi


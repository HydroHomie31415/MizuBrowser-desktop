#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

"$SCRIPT_DIR/fetch.sh"

choice=browser_artifact_mode
if [[ $(build_mode) == full ]]; then
  choice=browser
fi

note "Bootstrapping Mozilla build dependencies for $(build_mode) mode"
"$FIREFOX_DIR/mach" bootstrap --application-choice "$choice"
"$SCRIPT_DIR/sync.sh"

note "Bootstrap complete; run './mizu build'"


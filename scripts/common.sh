#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
FIREFOX_DIR="$PROJECT_ROOT/firefox"

# shellcheck source=../config/upstream.env
source "$PROJECT_ROOT/config/upstream.env"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '==> %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

build_mode() {
  local mode=${MIZU_BUILD_MODE:-artifact}
  case "$mode" in
    artifact|full) printf '%s\n' "$mode" ;;
    *) die "MIZU_BUILD_MODE must be 'artifact' or 'full' (got '$mode')" ;;
  esac
}

mozconfig_path() {
  printf '%s/config/mozconfig.%s\n' "$PROJECT_ROOT" "$(build_mode)"
}

require_checkout() {
  [[ -x "$FIREFOX_DIR/mach" ]] || die "Firefox is not fetched; run './mizu fetch' first"
}

run_mach() {
  require_checkout
  MOZCONFIG="$(mozconfig_path)" "$FIREFOX_DIR/mach" "$@"
}

# Validate once when tooling starts so failures inside command substitutions
# cannot be hidden by a successful surrounding printf or env command.
build_mode >/dev/null

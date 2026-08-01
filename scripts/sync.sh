#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_checkout

base_branding="$FIREFOX_DIR/browser/branding/unofficial"
mizu_branding="$FIREFOX_DIR/browser/branding/mizu"
[[ -d $base_branding ]] || die "upstream unofficial branding directory is missing"

note "Installing Mizu branding and product files"
mkdir -p "$mizu_branding"
cp -R "$base_branding/." "$mizu_branding/"
cp -R "$PROJECT_ROOT/overlay/." "$FIREFOX_DIR/"

shopt -s nullglob
patches=("$PROJECT_ROOT"/patches/*.patch)
for patch_file in "${patches[@]}"; do
  patch_name=${patch_file#"$PROJECT_ROOT/"}
  if git -C "$FIREFOX_DIR" apply --check "$patch_file" >/dev/null 2>&1; then
    note "Applying $patch_name"
    git -C "$FIREFOX_DIR" apply "$patch_file"
  elif git -C "$FIREFOX_DIR" apply --reverse --check "$patch_file" >/dev/null 2>&1; then
    note "Already applied: $patch_name"
  else
    die "$patch_name conflicts with Firefox ${FIREFOX_REVISION:0:12}"
  fi
done

note "Mizu overlay is synchronized"


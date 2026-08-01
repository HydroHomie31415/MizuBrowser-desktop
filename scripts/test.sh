#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

note "Checking shell syntax"
while IFS= read -r -d '' shell_file; do
  bash -n "$shell_file"
done < <(find "$PROJECT_ROOT/scripts" -type f -name '*.sh' -print0)
bash -n "$PROJECT_ROOT/mizu"

note "Checking required product files"
required_files=(
  config/upstream.env
  config/mozconfig.artifact
  config/mozconfig.full
  overlay/browser/branding/mizu/configure.sh
  overlay/browser/branding/mizu/locales/en-US/brand.ftl
  overlay/browser/branding/mizu/locales/en-US/brand.properties
  overlay/browser/branding/mizu/pref/firefox-branding.js
)
for relative_path in "${required_files[@]}"; do
  [[ -s "$PROJECT_ROOT/$relative_path" ]] || die "missing or empty: $relative_path"
done

[[ $FIREFOX_REVISION =~ ^[0-9a-f]{40}$ ]] || die "invalid FIREFOX_REVISION"
grep -q -- '--with-branding=browser/branding/mizu' "$PROJECT_ROOT/config/mozconfig.artifact"
grep -q -- '--with-branding=browser/branding/mizu' "$PROJECT_ROOT/config/mozconfig.full"
grep -q 'brandShortName=Mizu' "$PROJECT_ROOT/overlay/browser/branding/mizu/locales/en-US/brand.properties"
grep -q 'MOZ_APP_ID={b2914fe1-5963-4b36-b806-653d1317a7e6}' "$PROJECT_ROOT/config/mozconfig.artifact"
grep -q 'MOZ_APP_ID={b2914fe1-5963-4b36-b806-653d1317a7e6}' "$PROJECT_ROOT/config/mozconfig.full"

if MIZU_BUILD_MODE=invalid "$PROJECT_ROOT/mizu" status >/dev/null 2>&1; then
  die "invalid build mode was accepted"
fi

note "Repository checks passed"

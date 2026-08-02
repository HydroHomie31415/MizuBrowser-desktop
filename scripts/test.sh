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
  config/extensions.env
  scripts/extensions.sh
  config/mozconfig.artifact
  config/mozconfig.full
  overlay/browser/branding/mizu/configure.sh
  overlay/browser/branding/mizu/locales/en-US/brand.ftl
  overlay/browser/branding/mizu/locales/en-US/brand.properties
  overlay/browser/branding/mizu/pref/firefox-branding.js
  overlay/browser/base/content/browser-mizu-autohide.js
  overlay/browser/themes/shared/browser-mizu-autohide.css
  patches/0001-set-mizu-application-identity.patch
  patches/0002-add-mizu-autohide-chrome.patch
)
for relative_path in "${required_files[@]}"; do
  [[ -s "$PROJECT_ROOT/$relative_path" ]] || die "missing or empty: $relative_path"
done

[[ $FIREFOX_REVISION =~ ^[0-9a-f]{40}$ ]] || die "invalid FIREFOX_REVISION"
grep -q -- '--with-branding=browser/branding/mizu' "$PROJECT_ROOT/config/mozconfig.artifact"
grep -q -- '--with-branding=browser/branding/mizu' "$PROJECT_ROOT/config/mozconfig.full"
if grep -q -- '--with-app-basename=Mizu' "$PROJECT_ROOT/config/mozconfig.artifact"; then
  die "artifact mozconfig cannot rename Firefox's precompiled launcher"
fi
grep -q -- '--with-app-basename=Mizu' "$PROJECT_ROOT/config/mozconfig.full"
grep -Fq 'cd "$FIREFOX_DIR"' "$PROJECT_ROOT/scripts/bootstrap.sh"
grep -q 'brandShortName=Mizu' "$PROJECT_ROOT/overlay/browser/branding/mizu/locales/en-US/brand.properties"
grep -q 'imply_option("MOZ_APP_ID", "{b2914fe1-5963-4b36-b806-653d1317a7e6}")' \
  "$PROJECT_ROOT/patches/0001-set-mizu-application-identity.patch"
grep -q 'imply_option("MOZ_APP_PROFILE", "mizu")' \
  "$PROJECT_ROOT/patches/0001-set-mizu-application-identity.patch"
grep -q 'imply_option("MOZ_APP_VENDOR", "MizuBrowser")' \
  "$PROJECT_ROOT/patches/0001-set-mizu-application-identity.patch"

# The auto-hiding chrome is inert unless its script and stylesheet are both
# packaged and loaded, and none of that is visible until a full build runs.
grep -q 'content/browser/browser-mizu-autohide.js' \
  "$PROJECT_ROOT/patches/0002-add-mizu-autohide-chrome.patch"
grep -q 'skin/classic/browser/browser-mizu-autohide.css' \
  "$PROJECT_ROOT/patches/0002-add-mizu-autohide-chrome.patch"
grep -q 'loadSubScript("chrome://browser/content/browser-mizu-autohide.js"' \
  "$PROJECT_ROOT/patches/0002-add-mizu-autohide-chrome.patch"
grep -q 'chrome://browser/skin/browser-mizu-autohide.css' \
  "$PROJECT_ROOT/patches/0002-add-mizu-autohide-chrome.patch"
for autohide_pref in sidebar.verticalTabs mizu.chrome.column \
  mizu.chrome.autohide; do
  grep -q "pref(\"$autohide_pref\"" \
    "$PROJECT_ROOT/overlay/browser/branding/mizu/pref/firefox-branding.js" ||
    die "missing default for $autohide_pref"
done

# Bundled extensions are pinned by checksum, and are fetched rather than
# committed, so a malformed pin would only surface during a build.
[[ -n ${MIZU_EXTENSIONS:-} ]] || die "MIZU_EXTENSIONS is empty"
for extension_prefix in $MIZU_EXTENSIONS; do
  for field in ID VERSION SHA256 URL; do
    name="${extension_prefix}_${field}"
    [[ -n ${!name:-} ]] || die "config/extensions.env is missing $name"
  done
  sha_name="${extension_prefix}_SHA256"
  [[ ${!sha_name} =~ ^[0-9a-f]{64}$ ]] || die "$sha_name is not a SHA-256 digest"
  url_name="${extension_prefix}_URL"
  [[ ${!url_name} == https://* ]] || die "$url_name must be an https URL"
  [[ ${!url_name} == *%VERSION%* ]] ||
    die "$url_name must use %VERSION% so the pin and the download cannot diverge"
done
grep -Fq 'extensions.sh' "$PROJECT_ROOT/scripts/build.sh" ||
  die "build.sh no longer installs bundled extensions"

if grep -Eq 'ac_add_options (MOZ_APP_ID|MOZ_APP_PROFILE|MOZ_APP_VENDOR)=' \
  "$PROJECT_ROOT/config/mozconfig.artifact" "$PROJECT_ROOT/config/mozconfig.full"; then
  die "project-only application identity option found in mozconfig"
fi

if MIZU_BUILD_MODE=invalid "$PROJECT_ROOT/mizu" status >/dev/null 2>&1; then
  die "invalid build mode was accepted"
fi

note "Repository checks passed"

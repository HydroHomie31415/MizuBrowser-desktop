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

note "Checking mach working directory"
mach_probe_dir=$(mktemp -d)
trap 'rm -rf -- "$mach_probe_dir"' EXIT
printf '#!/usr/bin/env bash\npwd\n' > "$mach_probe_dir/mach"
chmod +x "$mach_probe_dir/mach"
printf '{}\n' > "$mach_probe_dir/mozinfo.json"
mach_working_dir=$(FIREFOX_DIR="$mach_probe_dir" run_mach | tail -n 1)
[[ $mach_working_dir == "$mach_probe_dir" ]] ||
  die "run_mach did not start in the Firefox checkout"
[[ ! -e $mach_probe_dir/mozinfo.json ]] ||
  die "run_mach did not remove invalid in-source build metadata"
printf '{}\n' > "$mach_probe_dir/mozinfo.json"
mach_working_dir=$(FIREFOX_DIR="$mach_probe_dir" exec_mach | tail -n 1)
[[ $mach_working_dir == "$mach_probe_dir" ]] ||
  die "exec_mach did not start in the Firefox checkout"
[[ ! -e $mach_probe_dir/mozinfo.json ]] ||
  die "exec_mach did not remove invalid in-source build metadata"
rm -rf -- "$mach_probe_dir"
trap - EXIT

note "Checking required product files"
required_files=(
  .github/workflows/release-linux.yml
  config/upstream.env
  config/extensions.env
  config/policies.json
  scripts/extensions.sh
  scripts/vendor-anime4k.sh
  config/mozconfig.artifact
  config/mozconfig.full
  overlay/browser/branding/mizu/configure.sh
  overlay/browser/branding/mizu/default128.png
  overlay/browser/branding/mizu/default16.png
  overlay/browser/branding/mizu/default256.png
  overlay/browser/branding/mizu/default32.png
  overlay/browser/branding/mizu/default48.png
  overlay/browser/branding/mizu/default64.png
  overlay/browser/branding/mizu/content/about-logo.svg
  overlay/browser/branding/mizu/content/about-logo.png
  overlay/browser/branding/mizu/content/about-logo@2x.png
  overlay/browser/branding/mizu/content/about-wordmark.svg
  overlay/browser/branding/mizu/content/firefox-wordmark.svg
  overlay/browser/branding/mizu/locales/en-US/brand.ftl
  overlay/browser/branding/mizu/locales/en-US/brand.properties
  overlay/browser/branding/mizu/pref/firefox-branding.js
  overlay/browser/base/content/browser-mizu-autohide.js
  overlay/browser/base/content/browser-mizu-command-palette.js
  overlay/browser/base/content/browser-mizu-hints.js
  overlay/browser/base/content/browser-mizu-video.js
  overlay/browser/actors/Anime4KLibrary.sys.mjs
  overlay/browser/actors/Anime4KProgram.sys.mjs
  overlay/browser/actors/Anime4KRenderer.sys.mjs
  overlay/browser/actors/MizuHintsChild.sys.mjs
  overlay/browser/actors/MizuHintsParent.sys.mjs
  overlay/browser/actors/test/browser/browser_mizu_hints.js
  overlay/browser/actors/test/browser/file_mizu_hints.html
  overlay/browser/actors/MizuMediaBridge.sys.mjs
  overlay/browser/actors/MizuVideoChild.sys.mjs
  overlay/browser/actors/MizuVideoParent.sys.mjs
  overlay/browser/themes/shared/browser-mizu-autohide.css
  overlay/browser/themes/shared/browser-mizu-command-palette.css
  overlay/browser/themes/shared/browser-mizu-video.css
  overlay/browser/themes/shared/mizu-video-player.svg
  patches/0001-set-mizu-application-identity.patch
  patches/0002-add-mizu-autohide-chrome.patch
  patches/0003-add-mizu-video-player.patch
  patches/0004-add-mizu-command-palette.patch
  patches/0006-add-mizu-link-hints.patch
  packaging/arch/mizu.desktop
  packaging/arch/mizu.svg
  packaging/arch/package.sh
  scripts/arch-package.sh
)
for relative_path in "${required_files[@]}"; do
  [[ -s "$PROJECT_ROOT/$relative_path" ]] || die "missing or empty: $relative_path"
done

for palette_path in browser-mizu-command-palette.js \
  browser-mizu-command-palette.css; do
  grep -q "$palette_path" \
    "$PROJECT_ROOT/patches/0004-add-mizu-command-palette.patch" ||
    die "command palette is not packaged: $palette_path"
done
for palette_pref in enabled max-results open-on-new-tab; do
  grep -q "pref(\"mizu.palette.$palette_pref\"" \
    "$PROJECT_ROOT/overlay/browser/branding/mizu/pref/firefox-branding.js" ||
    die "missing command palette default: $palette_pref"
done

# Link hints label every frame in a tab at once, so the actor pair, the chrome
# session that hands out the labels, and the defaults all have to stay wired up.
for hints_path in MizuHintsChild.sys.mjs MizuHintsParent.sys.mjs \
  browser-mizu-hints.js browser_mizu_hints.js; do
  grep -q "$hints_path" "$PROJECT_ROOT/patches/0006-add-mizu-link-hints.patch" ||
    die "link hints are not packaged: $hints_path"
done
for hints_pref in enabled characters key-code detect-listeners; do
  grep -q "pref(\"mizu.hints.$hints_pref\"" \
    "$PROJECT_ROOT/overlay/browser/branding/mizu/pref/firefox-branding.js" ||
    die "missing link hints default: $hints_pref"
done
# Labels are handed out in the chrome process precisely so that two frames can
# never offer the same one; generating them in the child would reintroduce that.
grep -q '_labels(' "$PROJECT_ROOT/overlay/browser/base/content/browser-mizu-hints.js" ||
  die "link hint labels are not assigned in the chrome process"
grep -q 'openOrClosedShadowRoot' \
  "$PROJECT_ROOT/overlay/browser/actors/MizuHintsChild.sys.mjs" ||
  die "link hints do not descend into shadow roots"

# The video player spans chrome and content processes, so verify that the actor,
# controller, stylesheet and defaults all remain connected to the build.
for video_path in Anime4KLibrary.sys.mjs Anime4KProgram.sys.mjs \
  Anime4KRenderer.sys.mjs MizuMediaBridge.sys.mjs \
  MizuVideoChild.sys.mjs MizuVideoParent.sys.mjs \
  browser-mizu-video.js browser-mizu-video.css mizu-video-player.svg; do
  grep -q "$video_path" "$PROJECT_ROOT/patches/0003-add-mizu-video-player.patch" ||
    die "video player is not packaged: $video_path"
done
for video_pref in auto-open seek-backward-seconds seek-forward-seconds arrow-keys \
  capture-keys preferred-quality subtitles-auto subtitle-language \
  subtitle-scale-percent subtitle-colour \
  subtitle-background subtitle-edge subtitle-font subtitle-position-percent \
  anime4k-enabled anime4k-mode anime4k-quality \
  anime4k-strength-percent anime4k-max-source-height anime4k-adaptive; do
  grep -q "pref(\"mizu.video.$video_pref\"" \
    "$PROJECT_ROOT/overlay/browser/branding/mizu/pref/firefox-branding.js" ||
    die "missing video player default: $video_pref"
done
grep -q 'pref("mizu.youtube.remove-shorts", true)' \
  "$PROJECT_ROOT/overlay/browser/branding/mizu/pref/firefox-branding.js" ||
  die "missing YouTube Shorts removal default"
for youtube_core in youtubeQualities youtubeCaptions chapters playlistState; do
  grep -q "$youtube_core" \
    "$PROJECT_ROOT/overlay/browser/actors/MizuMediaBridge.sys.mjs" ||
    die "missing YouTube media bridge feature: $youtube_core"
done
grep -q 'mizu-remove-youtube-shorts' \
  "$PROJECT_ROOT/overlay/browser/actors/MizuVideoChild.sys.mjs" ||
  die "YouTube Shorts removal is not installed"
grep -q '_onYouTubeMiniPlayerKeyDown' \
  "$PROJECT_ROOT/overlay/browser/actors/MizuVideoChild.sys.mjs" ||
  die "YouTube miniplayer seeking is not installed"
grep -q 'media.videocontrols.picture-in-picture.keyboard-controls.enabled' \
  "$PROJECT_ROOT/overlay/browser/branding/mizu/pref/firefox-branding.js" ||
  die "Picture-in-Picture keyboard seeking is not enabled"

# The shader chain is assembled from vendored upstream models. Every model a
# preset can name has to exist, be packaged, and still carry its own licence.
anime4k_dir="$PROJECT_ROOT/overlay/browser/actors/anime4k"
anime4k_revision=$(sed -n 's/^ANIME4K_REVISION=//p' \
  "$PROJECT_ROOT/scripts/vendor-anime4k.sh")
[[ $anime4k_revision =~ ^[0-9a-f]{40}$ ]] || die "invalid Anime4K revision pin"
for shader_family in Restore_CNN Restore_CNN_Soft Upscale_CNN_x2 \
  Upscale_Denoise_CNN_x2; do
  for shader_tier in S M L; do
    shader_file="$anime4k_dir/Anime4K_${shader_family}_${shader_tier}.sys.mjs"
    [[ -s $shader_file ]] || die "missing Anime4K model: $shader_file"
  done
done
for shader_extra in Clamp_Highlights Deblur_DoG Thin_Fast Darken_Fast \
  AutoDownscalePre_x2 AutoDownscalePre_x4 Upscale_DoG_x2; do
  [[ -s "$anime4k_dir/Anime4K_$shader_extra.sys.mjs" ]] ||
    die "missing Anime4K shader: Anime4K_$shader_extra"
done
while IFS= read -r -d '' shader_file; do
  shader_name=$(basename "$shader_file" .sys.mjs)
  grep -q "^//!HOOK " "$shader_file" ||
    die "$shader_name is not an mpv hook shader"
  grep -qE 'Copyright \(c\) (2019-2021 bloc97|bloc97)|This is free and unencumbered software' \
    "$shader_file" || die "$shader_name is missing its upstream licence notice"
  grep -q "$anime4k_revision" "$shader_file" ||
    die "$shader_name is missing its pinned upstream source revision"
  grep -q "anime4k/$shader_name.sys.mjs" \
    "$PROJECT_ROOT/patches/0003-add-mizu-video-player.patch" ||
    die "$shader_name is not packaged"
done < <(find "$anime4k_dir" -type f -name '*.sys.mjs' -print0)

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
[[ " $MIZU_EXTENSIONS " == *" BITWARDEN "* ]] ||
  die "Bitwarden is not included in MIZU_EXTENSIONS"
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
grep -Fq 'config/policies.json' "$PROJECT_ROOT/scripts/extensions.sh" ||
  die "bundled browser policies are not installed"
python3 - "$PROJECT_ROOT/config/policies.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as policies_file:
    policies = json.load(policies_file)["policies"]

if policies.get("PasswordManagerEnabled") is not False:
    raise SystemExit("Firefox password manager is not disabled by policy")

popup = policies.get("Preferences", {}).get(
    "browser.translations.automaticallyPopup", {}
)
if popup.get("Value") is not False or popup.get("Status") != "locked":
    raise SystemExit("Firefox translation popup is not disabled by policy")
PY
grep -Fq 'arch-package)' "$PROJECT_ROOT/mizu" ||
  die "arch-package command is not routed by ./mizu"
grep -Fq 'Exec=mizu %u' "$PROJECT_ROOT/packaging/arch/mizu.desktop" ||
  die "Arch desktop launcher does not start Mizu"

if grep -Eq 'ac_add_options (MOZ_APP_ID|MOZ_APP_PROFILE|MOZ_APP_VENDOR)=' \
  "$PROJECT_ROOT/config/mozconfig.artifact" "$PROJECT_ROOT/config/mozconfig.full"; then
  die "project-only application identity option found in mozconfig"
fi

if MIZU_BUILD_MODE=invalid "$PROJECT_ROOT/mizu" status >/dev/null 2>&1; then
  die "invalid build mode was accepted"
fi

note "Repository checks passed"

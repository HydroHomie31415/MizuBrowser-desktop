#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Rebuild Mizu against the newest upstream commit on FIREFOX_BRANCH and stage an
# installable package. Mizu is a source fork, so there is no binary update to
# apply: staying current means re-pinning, re-applying the Mizu patches, and
# rebuilding. Mozilla's signed MAR updates carry stock Firefox binaries and
# would overwrite every Mizu patch, so the in-tree updater stays disabled.
#
# Nothing here touches the installed browser. A run either stages a verified
# package in dist/ or fails without side effects.

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

WORKSPACE="$PROJECT_ROOT/.cache/auto-update"
WORK_CHECKOUT="$WORKSPACE/firefox"
STATE_FILE="$WORKSPACE/state.env"
LOG_DIR="$WORKSPACE/logs"
LOCK_FILE="$WORKSPACE/lock"
STAGE_DIR="$PROJECT_ROOT/dist"

update_pin=1
force=0
for argument in "$@"; do
  case "$argument" in
    --no-pin) update_pin=0 ;;
    --force) force=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: ./mizu auto-update [--no-pin] [--force]

  --no-pin  Do not rewrite FIREFOX_REVISION in config/upstream.env on success
  --force   Rebuild even when the pin already matches upstream
EOF
      exit 0
      ;;
    *) die "unknown argument: $argument" ;;
  esac
done

require_command git
require_command flock

mkdir -p "$WORKSPACE" "$LOG_DIR" "$STAGE_DIR"

# A slow full build can outlast the timer interval; never stack two runs.
exec {lock_fd}>"$LOCK_FILE"
flock -n "$lock_fd" || die "another auto-update run is in progress"

LOG_FILE="$LOG_DIR/$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

notify() {
  local urgency=$1 title=$2 body=$3
  printf '==> %s: %s\n' "$title" "$body"
  command -v notify-send >/dev/null 2>&1 || return 0
  notify-send --app-name=Mizu --urgency="$urgency" "$title" "$body" 2>/dev/null || true
}

write_state() {
  cat >"$STATE_FILE" <<EOF
LAST_RUN=$(date -Is)
LAST_RESULT=$1
LAST_CANDIDATE=${candidate:-unknown}
STAGED_PACKAGE=${staged_package:-}
LOG=$LOG_FILE
EOF
}

fail() {
  write_state "$1"
  notify critical "Mizu update failed" "$2 See $LOG_FILE"
  exit 1
}

note "Resolving upstream $FIREFOX_BRANCH"
candidate=$(git ls-remote "$FIREFOX_REPOSITORY" "refs/heads/$FIREFOX_BRANCH" |
  awk 'NR == 1 { print $1 }')
[[ $candidate =~ ^[0-9a-f]{40}$ ]] ||
  fail resolve-failed "Could not resolve upstream $FIREFOX_BRANCH."

printf 'pinned:    %s\n' "$FIREFOX_REVISION"
printf 'candidate: %s\n' "$candidate"

if [[ $candidate == "$FIREFOX_REVISION" && $force -eq 0 ]]; then
  note "Already current with upstream $FIREFOX_BRANCH"
  write_state already-current
  exit 0
fi

# Build the candidate in a disposable checkout. The interactive tree under
# firefox/ keeps hand-applied work, and fetch.sh refuses to move a dirty tree,
# so an unattended run must never reach for it.
export MIZU_FIREFOX_DIR="$WORK_CHECKOUT"
export MIZU_FIREFOX_REVISION="$candidate"

note "Fetching candidate into $WORK_CHECKOUT"
if [[ -d "$WORK_CHECKOUT/.git" ]]; then
  # Discard the previous candidate's overlay and patches; fetch.sh requires a
  # clean tree before switching revisions.
  git -C "$WORK_CHECKOUT" reset --hard >/dev/null 2>&1 || true
  git -C "$WORK_CHECKOUT" clean -fdx --exclude=obj-mizu-\* >/dev/null 2>&1 || true
fi
"$SCRIPT_DIR/fetch.sh" || fail fetch-failed "Could not fetch ${candidate:0:12}."

# Gate: prove every Mizu patch still applies before spending a build on it.
# sync.sh dies on conflict, and a conflict here is the expected failure mode as
# upstream drifts, so it is reported as work to do rather than as a crash.
note "Verifying Mizu patches against ${candidate:0:12}"
if ! "$SCRIPT_DIR/sync.sh"; then
  fail patch-conflict \
    "Mizu patches no longer apply to ${candidate:0:12}; they need rebasing."
fi

note "Building Mizu ($(build_mode) mode) against ${candidate:0:12}"
"$SCRIPT_DIR/build.sh" || fail build-failed "Build failed for ${candidate:0:12}."

object_dir="$WORK_CHECKOUT/obj-mizu-$(build_mode)"
binary="$object_dir/dist/bin/firefox"
[[ -x $binary ]] || binary="$object_dir/dist/bin/mizu"
[[ -x $binary ]] || fail build-failed "No Mizu binary in $object_dir/dist/bin."

# Smoke test: a package that cannot start is worse than no update at all.
note "Smoke testing the new build"
smoke_profile=$(mktemp -d)
smoke_shot="$smoke_profile/startup.png"
trap 'rm -rf -- "$smoke_profile"' EXIT

"$binary" --version || fail smoke-failed "New build cannot report its version."

# A headless screenshot exercises real startup: XPCOM, the chrome registry, and
# the Mizu overlay all have to load before a frame can be painted.
if ! timeout 180 "$binary" --profile "$smoke_profile" --no-remote --headless \
  --screenshot "$smoke_shot" about:blank; then
  fail smoke-failed "New build did not start headless."
fi
[[ -s $smoke_shot ]] || fail smoke-failed "New build started but painted nothing."

version=$(<"$WORK_CHECKOUT/browser/config/version.txt")
version=${version//[^0-9A-Za-z._]/}
package_version="${version}+${candidate:0:8}"

note "Packaging Mizu $package_version"
mapfile -t archives < <(find "$object_dir/dist" -maxdepth 1 -type f \
  -name 'mizu-*.linux-x86_64.tar.*' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
[[ ${#archives[@]} -gt 0 ]] ||
  fail package-failed "mach package produced no Mizu Linux archive."

"$PROJECT_ROOT/packaging/arch/package.sh" "${archives[0]}" "$package_version" \
  "$STAGE_DIR" || fail package-failed "Could not build an Arch package."

staged_package=$(find "$STAGE_DIR" -maxdepth 1 -type f \
  -name "mizu-browser-$package_version-*.pkg.tar.zst" -print -quit)
[[ -n $staged_package ]] || fail package-failed "Staged package is missing."

# Keep the two newest packages so the previous build stays available to roll
# back to after a bad update.
mapfile -t stale < <(find "$STAGE_DIR" -maxdepth 1 -type f \
  -name 'mizu-browser-*.pkg.tar.zst' -printf '%T@ %p\n' |
  sort -nr | cut -d' ' -f2- | tail -n +3)
for old_package in "${stale[@]}"; do
  note "Removing superseded package $(basename "$old_package")"
  rm -f -- "$old_package"
done

if ((update_pin)); then
  note "Recording the new pin in config/upstream.env"
  # Rewrite in place so the repository records exactly what was built.
  tmp_env=$(mktemp)
  sed "s/^FIREFOX_REVISION=.*/FIREFOX_REVISION=$candidate/" \
    "$PROJECT_ROOT/config/upstream.env" >"$tmp_env"
  mv -- "$tmp_env" "$PROJECT_ROOT/config/upstream.env"
fi

write_state success
note "Staged $staged_package"
notify normal "Mizu update ready" \
  "Mizu $package_version built and verified. Install with: sudo pacman -U $staged_package"

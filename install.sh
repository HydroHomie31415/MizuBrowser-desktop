#!/usr/bin/env bash
# Install Mizu's native package on an x86-64 Arch Linux system.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
RELEASE_BASE=https://github.com/HydroHomie31415/MizuBrowser-desktop/releases/latest/download
PACKAGE_NAME=mizu-browser-x86_64.pkg.tar.zst

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./install.sh [PACKAGE]

Install Mizu Browser on x86-64 Arch Linux. If PACKAGE is omitted, the newest
package in dist/ is used; when none exists, the latest GitHub release and its
SHA-256 checksum are downloaded automatically.
EOF
}

case ${1:-} in
  -h|--help)
    usage
    exit 0
    ;;
esac
(($# <= 1)) || die "usage: ./install.sh [PACKAGE]"

[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] ||
  die "Mizu's Arch package currently supports only x86-64 Linux"
command -v pacman >/dev/null 2>&1 ||
  die "pacman was not found; this installer is for Arch Linux"

temporary_dir=
cleanup() {
  if [[ -n $temporary_dir ]]; then
    rm -rf -- "$temporary_dir"
  fi
}
trap cleanup EXIT

package=${1:-}
if [[ -z $package ]]; then
  for candidate in "$SCRIPT_DIR"/dist/mizu-browser-[0-9]*-x86_64.pkg.tar.zst; do
    [[ -f $candidate ]] || continue
    if [[ -z $package || $candidate -nt $package ]]; then
      package=$candidate
    fi
  done
fi

if [[ -z $package ]]; then
  temporary_dir=$(mktemp -d)
  package="$temporary_dir/$PACKAGE_NAME"
  checksums="$temporary_dir/SHA256SUMS"

  printf '==> Downloading the latest Mizu Browser release\n'
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$package" "$RELEASE_BASE/$PACKAGE_NAME"
    curl -fL --retry 3 -o "$checksums" "$RELEASE_BASE/SHA256SUMS"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$package" "$RELEASE_BASE/$PACKAGE_NAME"
    wget -O "$checksums" "$RELEASE_BASE/SHA256SUMS"
  else
    die "curl or wget is required to download a release"
  fi

  command -v sha256sum >/dev/null 2>&1 ||
    die "sha256sum is required to verify the downloaded release"
  expected_hash=$(awk -v name="$PACKAGE_NAME" '$2 == name { print $1 }' "$checksums")
  [[ $expected_hash =~ ^[0-9a-fA-F]{64}$ ]] ||
    die "the release checksum file has no valid entry for $PACKAGE_NAME"
  printf '%s  %s\n' "$expected_hash" "$package" | sha256sum --check --status - ||
    die "the downloaded package failed SHA-256 verification"
  printf '==> Download verified\n'
else
  [[ -f $package ]] || die "package not found: $package"
fi

package_identity=$(LC_ALL=C pacman -Qp -- "$package") ||
  die "pacman could not read the package: $package"
installed_name=${package_identity%% *}
[[ $installed_name == mizu-browser ]] ||
  die "expected a mizu-browser package, got: $installed_name"

printf '==> Installing %s\n' "$package_identity"
if ((EUID == 0)); then
  pacman -U --needed -- "$package"
elif command -v sudo >/dev/null 2>&1; then
  sudo pacman -U --needed -- "$package"
elif command -v pkexec >/dev/null 2>&1; then
  pkexec pacman -U --needed -- "$package"
else
  die "run this installer as root or install sudo/pkexec"
fi

printf '==> Mizu Browser is installed; launch it from the app menu or run: mizu\n'

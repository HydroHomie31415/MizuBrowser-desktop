#!/usr/bin/env bash
# Build and install the current Mizu checkout on an x86-64 Arch Linux system.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./install.sh

Build the latest state of this checkout, create a fresh native Arch package,
and install it. The generated package gets a unique local version so uncommitted
changes are never skipped as an already-installed build.

Environment:
  MIZU_BUILD_MODE=artifact|full  Select the build mode (default: artifact)
  MIZU_INSTALL_VERSION_BASE=X   Set the local package's base version (default: 0.1.0)
EOF
}

case ${1:-} in
  -h|--help)
    usage
    exit 0
    ;;
esac
(($# == 0)) || die "usage: ./install.sh"

[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] ||
  die "Mizu's Arch package currently supports only x86-64 Linux"
command -v pacman >/dev/null 2>&1 ||
  die "pacman was not found; this installer is for Arch Linux"
command -v git >/dev/null 2>&1 || die "git is required to version the local build"

if [[ ! -x $SCRIPT_DIR/firefox/mach ]]; then
  printf '==> Firefox checkout not found; bootstrapping the build environment\n'
  "$SCRIPT_DIR/mizu" bootstrap
fi

printf '==> Building the latest Mizu source and bundled extensions\n'
"$SCRIPT_DIR/mizu" build

version_base=${MIZU_INSTALL_VERSION_BASE:-0.1.0}
[[ $version_base =~ ^[0-9][0-9A-Za-z._+]*$ ]] ||
  die "MIZU_INSTALL_VERSION_BASE is not a valid Arch package version"
revision_count=$(git -C "$SCRIPT_DIR" rev-list --count HEAD)
revision=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD)
build_time=$(date -u +%Y%m%d%H%M%S)
package_version="$version_base.r$revision_count.g$revision.$build_time"

printf '==> Packaging the current checkout as Mizu %s\n' "$package_version"
"$SCRIPT_DIR/mizu" arch-package "$package_version"
package="$SCRIPT_DIR/dist/mizu-browser-$package_version-1-x86_64.pkg.tar.zst"
[[ -f $package ]] || die "package was not created: $package"

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

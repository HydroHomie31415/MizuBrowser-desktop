#!/usr/bin/env bash
# Build a pacman-installable package from a Mizu Firefox-style tar archive.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)

archive=${1:-}
version=${2:-}
output_dir=${3:-"$PROJECT_ROOT/dist"}

[[ -f $archive ]] || {
  printf 'usage: %s /path/to/mizu.tar.xz VERSION [OUTPUT_DIR]\n' "$0" >&2
  exit 2
}
[[ $version =~ ^[0-9][0-9A-Za-z._+]*$ ]] || {
  printf 'error: VERSION must be a valid Arch pkgver (got %q)\n' "$version" >&2
  exit 2
}
command -v zstd >/dev/null 2>&1 || {
  printf 'error: zstd is required to create an Arch package\n' >&2
  exit 1
}

work_dir=$(mktemp -d)
trap 'rm -rf -- "$work_dir"' EXIT
source_dir="$work_dir/source"
package_dir="$work_dir/package"
mkdir -p "$source_dir" "$package_dir/opt/mizu" "$package_dir/usr/bin"

tar -xf "$archive" -C "$source_dir"
mapfile -t roots < <(find "$source_dir" -mindepth 1 -maxdepth 1 -type d -print)
[[ ${#roots[@]} -eq 1 ]] || {
  printf 'error: browser archive must contain exactly one top-level directory\n' >&2
  exit 1
}
cp -a "${roots[0]}/." "$package_dir/opt/mizu/"

if [[ ! -x $package_dir/opt/mizu/mizu && \
      ! -x $package_dir/opt/mizu/firefox ]]; then
  printf 'error: browser archive contains neither a mizu nor firefox launcher\n' >&2
  exit 1
fi

install -Dm755 "$SCRIPT_DIR/mizu-launcher" "$package_dir/usr/bin/mizu"
install -Dm644 "$SCRIPT_DIR/mizu.desktop" \
  "$package_dir/usr/share/applications/mizu.desktop"
install -Dm644 "$SCRIPT_DIR/mizu.svg" \
  "$package_dir/usr/share/icons/hicolor/scalable/apps/mizu.svg"
install -Dm644 "$PROJECT_ROOT/LICENSE" \
  "$package_dir/usr/share/licenses/mizu-browser/LICENSE"

installed_size=$(du -sk "$package_dir" | cut -f1)
cat >"$package_dir/.PKGINFO" <<EOF
pkgname = mizu-browser
pkgbase = mizu-browser
pkgver = $version-1
pkgdesc = Mizu desktop web browser
url = https://github.com/HydroHomie31415/MizuBrowser-desktop
builddate = ${SOURCE_DATE_EPOCH:-$(date +%s)}
packager = Mizu Browser release workflow
size = $((installed_size * 1024))
arch = x86_64
license = MPL-2.0
depend = alsa-lib
depend = at-spi2-core
depend = bash
depend = cairo
depend = dbus
depend = ffmpeg
depend = fontconfig
depend = freetype2
depend = gdk-pixbuf2
depend = glib2
depend = glibc
depend = gtk3
depend = hicolor-icon-theme
depend = libgcc
depend = libpulse
depend = libstdc++
depend = libx11
depend = libxcb
depend = libxcomposite
depend = libxdamage
depend = libxext
depend = libxfixes
depend = libxrandr
depend = libxss
depend = libxt
depend = mime-types
depend = nspr
depend = nss
depend = pango
depend = ttf-font
EOF

mkdir -p "$output_dir"
package_path="$output_dir/mizu-browser-$version-1-x86_64.pkg.tar.zst"
tar --zstd --sort=name --mtime="@${SOURCE_DATE_EPOCH:-0}" \
  --owner=0 --group=0 --numeric-owner -cf "$package_path" \
  -C "$package_dir" .PKGINFO opt usr
printf '%s\n' "$package_path"

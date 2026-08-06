#!/usr/bin/env bash

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

version=${1:-}
[[ -n $version ]] || die "usage: ./mizu arch-package VERSION"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] ||
  die "Arch packages are currently supported only for Linux x86_64"

"$SCRIPT_DIR/sync.sh"
# A developer may package an existing build without running ./mizu build in the
# same shell. Refresh the distribution payload so bundled extensions and their
# policies can never be omitted from that package.
"$SCRIPT_DIR/extensions.sh"
run_mach package

object_dir="$FIREFOX_DIR/obj-mizu-$(build_mode)"
mapfile -t archives < <(find "$object_dir/dist" -maxdepth 1 -type f \
  -name 'mizu-*.linux-x86_64.tar.*' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
[[ ${#archives[@]} -gt 0 ]] || die "mach package did not create a Mizu Linux archive"

note "Creating Arch Linux package for Mizu $version"
"$PROJECT_ROOT/packaging/arch/package.sh" "${archives[0]}" "$version"

#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Installs the extensions pinned in config/extensions.env into the build's
# distribution directory. Firefox copies add-ons found there into each new
# profile on first run, so they ship enabled but stay ordinary add-ons the user
# can disable or remove.

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_command curl
require_command sha256sum
require_command unzip

cache_dir="$PROJECT_ROOT/.cache/extensions"
mkdir -p "$cache_dir"

# Prints the value of "<prefix>_<field>", e.g. UBLOCK_ORIGIN_VERSION.
field() {
  local name="$1_$2"
  printf '%s\n' "${!name-}"
}

# Downloads into the cache if missing, then verifies the checksum. A file that
# fails verification is removed so a retry cannot keep reusing it.
fetch_extension() {
  local prefix="$1" version="$2" sha="$3" url="$4" target="$5"

  if [[ ! -f $target ]]; then
    note "Downloading $prefix $version"
    curl -fsSL --retry 3 --max-time 300 -o "$target.part" "$url" ||
      die "failed to download $prefix from $url"
    mv "$target.part" "$target"
  fi

  local actual
  actual=$(sha256sum "$target" | cut -d' ' -f1)
  if [[ $actual != "$sha" ]]; then
    rm -f "$target"
    die "$prefix checksum mismatch
  expected $sha
  actual   $actual
If the upstream release was intentionally updated, run
'./mizu extensions --update-checksum' and commit the new value."
  fi
}

# The add-on ID in config must match the XPI's own manifest, because Firefox
# identifies distribution add-ons by filename. A mismatch installs a second
# copy under the wrong ID instead of failing loudly, so check it here.
verify_id() {
  local prefix="$1" expected="$2" xpi="$3" actual
  actual=$(unzip -p "$xpi" manifest.json |
    python3 -c 'import json,sys
m = json.load(sys.stdin)
settings = m.get("browser_specific_settings") or m.get("applications") or {}
print(settings.get("gecko", {}).get("id", ""))') ||
    die "could not read manifest.json from $xpi"
  [[ $actual == "$expected" ]] ||
    die "$prefix add-on ID mismatch: config says '$expected', XPI says '$actual'"
}

update_checksum=0
[[ ${1-} == --update-checksum ]] && update_checksum=1

if ((update_checksum)); then
  for prefix in $MIZU_EXTENSIONS; do
    version=$(field "$prefix" VERSION)
    url_template=$(field "$prefix" URL)
    url=${url_template//%VERSION%/$version}
    note "Fetching $prefix $version to compute its checksum"
    curl -fsSL --retry 3 --max-time 300 -o "$cache_dir/$prefix.probe" "$url"
    printf '%s_SHA256=%s\n' "$prefix" \
      "$(sha256sum "$cache_dir/$prefix.probe" | cut -d' ' -f1)"
    rm -f "$cache_dir/$prefix.probe"
  done
  exit 0
fi

require_checkout
objdir="$FIREFOX_DIR/obj-mizu-$(build_mode)"
[[ -d $objdir/dist/bin ]] ||
  die "no build output in $objdir; run './mizu build' first"

dist_dir="$objdir/dist/bin/distribution/extensions"
mkdir -p "$dist_dir"

for prefix in $MIZU_EXTENSIONS; do
  id=$(field "$prefix" ID)
  version=$(field "$prefix" VERSION)
  sha=$(field "$prefix" SHA256)
  url_template=$(field "$prefix" URL)
  [[ -n $id && -n $version && -n $sha && -n $url_template ]] ||
    die "config/extensions.env is missing fields for $prefix"

  url=${url_template//%VERSION%/$version}
  cached="$cache_dir/$prefix-$version.xpi"

  fetch_extension "$prefix" "$version" "$sha" "$url" "$cached"
  verify_id "$prefix" "$id" "$cached"

  # Firefox matches the filename against the add-on ID.
  cp "$cached" "$dist_dir/$id.xpi"
  note "Installed $prefix $version as $id"
done

note "Bundled extensions are up to date"

#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Re-vendors the Anime4K models as ES modules. The shader text is copied
# verbatim, upstream licence notice included, so this only has to run when the
# pinned revision changes or a model is added to the list below.

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# Pinned so the vendored text can always be diffed against its origin.
ANIME4K_REVISION=7684e9586f8dcc738af08a1cdceb024cc184f426
ANIME4K_BASE="https://raw.githubusercontent.com/bloc97/Anime4K/$ANIME4K_REVISION/glsl"

# Every model any preset in Anime4KLibrary.sys.mjs can name. The VL and UL
# tiers are deliberately absent: they cost more than a browser can absorb at
# playback frame rates.
models=(
  "Restore/Anime4K_Restore_CNN_S"
  "Restore/Anime4K_Restore_CNN_M"
  "Restore/Anime4K_Restore_CNN_L"
  "Restore/Anime4K_Restore_CNN_Soft_S"
  "Restore/Anime4K_Restore_CNN_Soft_M"
  "Restore/Anime4K_Restore_CNN_Soft_L"
  "Restore/Anime4K_Clamp_Highlights"
  "Upscale/Anime4K_Upscale_CNN_x2_S"
  "Upscale/Anime4K_Upscale_CNN_x2_M"
  "Upscale/Anime4K_Upscale_CNN_x2_L"
  "Upscale/Anime4K_Upscale_DoG_x2"
  "Upscale/Anime4K_AutoDownscalePre_x2"
  "Upscale/Anime4K_AutoDownscalePre_x4"
  "Upscale+Denoise/Anime4K_Upscale_Denoise_CNN_x2_S"
  "Upscale+Denoise/Anime4K_Upscale_Denoise_CNN_x2_M"
  "Upscale+Denoise/Anime4K_Upscale_Denoise_CNN_x2_L"
  "Deblur/Anime4K_Deblur_DoG"
  "Experimental-Effects/Anime4K_Thin_Fast"
  "Experimental-Effects/Anime4K_Darken_Fast"
)

target="$PROJECT_ROOT/overlay/browser/actors/anime4k"
mkdir -p "$target"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

note "Vendoring ${#models[@]} Anime4K models from ${ANIME4K_REVISION:0:12}"
for model in "${models[@]}"; do
  name=${model##*/}
  curl -fsS -o "$work/$name.glsl" "$ANIME4K_BASE/$model.glsl" ||
    die "could not fetch $model"

  # The shader is embedded with String.raw, which only breaks on a backtick or
  # a template placeholder; GLSL contains neither, but check rather than trust.
  if grep -qF '`' "$work/$name.glsl" || grep -qF '${' "$work/$name.glsl"; then
    die "$name cannot be embedded in a template literal"
  fi

  {
    cat <<EOF
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Verbatim copy of glsl/$model.glsl from bloc97/Anime4K at revision
 * $ANIME4K_REVISION. The upstream licence notice is retained
 * inside the shader text below.
 * Source: https://github.com/bloc97/Anime4K/blob/$ANIME4K_REVISION/glsl/$model.glsl */

/* eslint-disable */

export const SHADER = String.raw\`
EOF
    # Command substitution drops every trailing newline, so printf can put back
    # exactly one and leave the closing backtick on a line of its own.
    printf '%s\n' "$(sed -e 's/\r$//' "$work/$name.glsl")"
    printf '`;\n'
  } > "$target/$name.sys.mjs"
done

note "Vendored models are in overlay/browser/actors/anime4k"
note "Add any new file to patches/0003-add-mizu-video-player.patch as well"

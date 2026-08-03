/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseShader } from "resource:///actors/Anime4KProgram.sys.mjs";

/**
 * The Anime4K shader catalogue and the official preset chains built from it.
 *
 * Shader text is bulky, so each `.glsl` file lives in its own module and is
 * imported the first time a chain needs it. Parsed passes are cached per
 * content process, which means switching modes back and forth costs nothing.
 */

const SHADER_DIRECTORY = "resource:///actors/anime4k/";

/**
 * Quality tiers, named after the upstream model sizes. Anime4K also ships VL
 * and UL models; they are omitted because they cost far more than a browser
 * compositing thread can absorb at 60fps.
 */
export const QUALITY_TIERS = [
  { id: "S", label: "Fast", note: "Smallest models, lowest GPU cost" },
  { id: "M", label: "Balanced", note: "Upstream's recommended default" },
  { id: "L", label: "High", note: "Largest models, needs a discrete GPU" },
];

const LOWER_TIER = { S: "S", M: "S", L: "M" };

/** Families whose file name ends in the quality tier. */
const TIERED = new Set([
  "Anime4K_Restore_CNN",
  "Anime4K_Restore_CNN_Soft",
  "Anime4K_Upscale_CNN_x2",
  "Anime4K_Upscale_Denoise_CNN_x2",
]);

/**
 * The upscaling modes from Anime4K's own quick-start table. `main` uses the
 * selected quality tier and `small` the tier below it, matching how upstream
 * pairs a large first pass with a cheaper second one.
 */
export const MODES = [
  {
    id: "a",
    label: "Mode A",
    note: "Restore then upscale. Best for most modern anime.",
    chain: [
      "Anime4K_Restore_CNN@main",
      "Anime4K_Upscale_CNN_x2@main",
      "Anime4K_AutoDownscalePre_x2",
      "Anime4K_AutoDownscalePre_x4",
      "Anime4K_Upscale_CNN_x2@small",
    ],
  },
  {
    id: "b",
    label: "Mode B",
    note: "Softer restore. Best for blurry or heavily compressed sources.",
    chain: [
      "Anime4K_Restore_CNN_Soft@main",
      "Anime4K_Upscale_CNN_x2@main",
      "Anime4K_AutoDownscalePre_x2",
      "Anime4K_AutoDownscalePre_x4",
      "Anime4K_Upscale_CNN_x2@small",
    ],
  },
  {
    id: "c",
    label: "Mode C",
    note: "Upscale and denoise in one model. Best for very noisy sources.",
    chain: [
      "Anime4K_Upscale_Denoise_CNN_x2@main",
      "Anime4K_AutoDownscalePre_x2",
      "Anime4K_AutoDownscalePre_x4",
      "Anime4K_Upscale_CNN_x2@small",
    ],
  },
  {
    id: "aa",
    label: "Mode A+A",
    note: "Mode A with a second restore pass. Strongest line reconstruction.",
    chain: [
      "Anime4K_Restore_CNN@main",
      "Anime4K_Upscale_CNN_x2@main",
      "Anime4K_Restore_CNN@small",
      "Anime4K_AutoDownscalePre_x2",
      "Anime4K_AutoDownscalePre_x4",
      "Anime4K_Upscale_CNN_x2@small",
    ],
  },
  {
    id: "bb",
    label: "Mode B+B",
    note: "Mode B with a second soft restore pass.",
    chain: [
      "Anime4K_Restore_CNN_Soft@main",
      "Anime4K_Upscale_CNN_x2@main",
      "Anime4K_AutoDownscalePre_x2",
      "Anime4K_Restore_CNN_Soft@small",
      "Anime4K_AutoDownscalePre_x4",
      "Anime4K_Upscale_CNN_x2@small",
    ],
  },
  {
    id: "ca",
    label: "Mode C+A",
    note: "Mode C followed by a restore pass.",
    chain: [
      "Anime4K_Upscale_Denoise_CNN_x2@main",
      "Anime4K_AutoDownscalePre_x2",
      "Anime4K_AutoDownscalePre_x4",
      "Anime4K_Restore_CNN@small",
      "Anime4K_Upscale_CNN_x2@small",
    ],
  },
  {
    id: "dog",
    label: "Lite (DoG)",
    note: "No neural network at all. For integrated graphics and laptops.",
    chain: ["Anime4K_Upscale_DoG_x2"],
    fixedQuality: true,
  },
];

/**
 * Optional passes the user can add to any mode. `before` runs ahead of the
 * chain, which is where Anime4K's own documentation places de-ringing so its
 * statistics are gathered from the untouched frame.
 */
export const EXTRAS = [
  {
    id: "clamp",
    label: "De-ring highlights",
    note: "Suppresses the halo the CNN can leave around bright edges",
    file: "Anime4K_Clamp_Highlights",
    position: "before",
  },
  {
    id: "deblur",
    label: "Deblur",
    note: "Sharpens soft line art before upscaling",
    file: "Anime4K_Deblur_DoG",
    position: "before",
  },
  {
    id: "thin",
    label: "Thin lines",
    note: "Warps thick outlines inward",
    file: "Anime4K_Thin_Fast",
    position: "after",
  },
  {
    id: "darken",
    label: "Darken lines",
    note: "Deepens outlines that upscaling washed out",
    file: "Anime4K_Darken_Fast",
    position: "after",
  },
];

const parsedShaders = new Map();

/**
 * Resolves a mode, quality tier and set of extras into an ordered list of
 * shader file names.
 *
 * @param {object} selection The user's Anime4K settings.
 * @param {string} selection.mode A mode id from {@link MODES}.
 * @param {string} selection.quality A tier id from {@link QUALITY_TIERS}.
 * @param {string[]} [selection.extras] Extra pass ids from {@link EXTRAS}.
 * @returns {string[]} Shader file names without their extension.
 */
export function resolveChain({ mode, quality, extras = [] }) {
  let definition = MODES.find(entry => entry.id == mode);
  if (!definition) {
    throw new Error(`Unknown Anime4K mode: ${mode}`);
  }
  let tier = QUALITY_TIERS.some(entry => entry.id == quality) ? quality : "M";
  let enabled = new Set(extras);
  let chosen = EXTRAS.filter(extra => enabled.has(extra.id));

  return [
    ...chosen.filter(extra => extra.position == "before").map(e => e.file),
    ...definition.chain.map(entry => expandTier(entry, tier)),
    ...chosen.filter(extra => extra.position == "after").map(e => e.file),
  ];
}

function expandTier(entry, tier) {
  let [family, slot] = entry.split("@");
  if (!slot) {
    return family;
  }
  if (!TIERED.has(family)) {
    throw new Error(`${family} has no quality tiers`);
  }
  return `${family}_${slot == "small" ? LOWER_TIER[tier] : tier}`;
}

/**
 * Loads and parses a shader file, caching the result for the process.
 *
 * @param {string} file A file name returned by {@link resolveChain}.
 * @returns {import("resource:///actors/Anime4KProgram.sys.mjs").ShaderPass[]}
 */
export function loadShader(file) {
  let cached = parsedShaders.get(file);
  if (cached) {
    return cached;
  }
  if (!/^Anime4K_[A-Za-z0-9_]+$/.test(file)) {
    throw new Error(`Refusing to load shader with unexpected name: ${file}`);
  }
  let { SHADER } = ChromeUtils.importESModule(
    `${SHADER_DIRECTORY}${file}.sys.mjs`
  );
  let passes = parseShader(SHADER, file);
  parsedShaders.set(file, passes);
  return passes;
}

/**
 * Loads every pass of a resolved chain, in order.
 *
 * @param {string[]} files Shader file names.
 * @returns {import("resource:///actors/Anime4KProgram.sys.mjs").ShaderPass[]}
 */
export function loadChain(files) {
  return files.flatMap(file => loadShader(file));
}

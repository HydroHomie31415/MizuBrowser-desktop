/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Translates mpv user shaders into WebGL2 programs.
 *
 * Anime4K ships as mpv "hook" shaders: a single file holds several passes, each
 * introduced by `//!` directives that say which texture the pass reads, where it
 * writes, how large its output is and when it should run at all. mpv resolves
 * that description at render time; this module does the same work ahead of time
 * so Anime4KRenderer only has to bind textures and draw quads.
 *
 * Nothing here touches WebGL, so the translation can be exercised on its own.
 */

/** Directives that introduce a new pass header rather than shader body text. */
const DIRECTIVE = /^\/\/!([A-Z]+)[ \t]*(.*)$/;

/** Texture names mpv provides rather than the shader author. */
export const HOOKED = "HOOKED";
export const MAIN = "MAIN";
export const NATIVE = "NATIVE";
export const OUTPUT = "OUTPUT";

/**
 * mpv runs hooks in pipeline order, not in the order the files were listed, so
 * a shader that hooks a later stage always applies after every MAIN pass.
 */
export const HOOK_ORDER = [MAIN, "PREKERNEL", "POSTKERNEL", "SCALED", OUTPUT];

/**
 * mpv's later stages exist because it hands the image to a scaling kernel and
 * then to the display. We scale the finished image ourselves, so every stage
 * reads and writes the one working texture; only the ordering above survives.
 */
function stageTexture(stage) {
  return HOOK_ORDER.includes(stage) ? MAIN : stage;
}

const SIZE_OPERATORS = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  ">": (a, b) => (a > b ? 1 : 0),
  "<": (a, b) => (a < b ? 1 : 0),
  "=": (a, b) => (a == b ? 1 : 0),
};

/**
 * One `//!DESC`-introduced pass of an mpv user shader.
 */
export class ShaderPass {
  constructor(file, index) {
    this.file = file;
    this.index = index;
    this.desc = `${file} pass ${index + 1}`;
    this.stage = MAIN;
    this.hook = MAIN;
    this.binds = [];
    this.save = null;
    this.width = null;
    this.height = null;
    this.components = 4;
    this.when = null;
    this.body = "";
  }

  /** The texture this pass writes, defaulting to the texture it hooked. */
  get target() {
    return this.save ?? this.hook;
  }

  /**
   * Textures the pass reads, with mpv's `HOOKED` alias resolved and duplicates
   * removed so each one maps to exactly one sampler uniform.
   */
  get sources() {
    let names = this.binds.map(name => (name == HOOKED ? this.hook : name));
    return [...new Set(names)];
  }
}

/**
 * Splits an mpv user shader into its passes.
 *
 * @param {string} source The complete `.glsl` file.
 * @param {string} file A short name used in diagnostics.
 * @returns {ShaderPass[]} The passes in declaration order.
 */
export function parseShader(source, file = "shader") {
  let passes = [];
  let pass = null;
  let inHeader = false;

  for (let line of source.split("\n")) {
    let directive = DIRECTIVE.exec(line);
    if (!directive) {
      // Text before the first directive is the upstream licence header.
      if (pass) {
        inHeader = false;
        pass.body += `${line}\n`;
      }
      continue;
    }

    if (!inHeader) {
      pass = new ShaderPass(file, passes.length);
      passes.push(pass);
      inHeader = true;
    }
    applyDirective(pass, directive[1], directive[2].trim());
  }

  if (!passes.length) {
    throw new Error(`${file} declares no shader passes`);
  }
  for (let entry of passes) {
    if (!entry.body.includes("vec4 hook()")) {
      throw new Error(`${entry.desc} has no hook() entry point`);
    }
  }
  return passes;
}

function applyDirective(pass, name, value) {
  switch (name) {
    case "DESC":
      pass.desc = value;
      break;
    case "HOOK":
      pass.stage = value;
      pass.hook = stageTexture(value);
      break;
    case "BIND":
      pass.binds.push(value);
      break;
    case "SAVE":
      pass.save = value;
      break;
    case "WIDTH":
      pass.width = parseSizeExpression(value);
      break;
    case "HEIGHT":
      pass.height = parseSizeExpression(value);
      break;
    case "COMPONENTS":
      pass.components = Number(value);
      break;
    case "WHEN":
      pass.when = parseSizeExpression(value);
      break;
    default:
      // Failing loudly keeps a shader we cannot honour from silently rendering
      // something other than what its author described.
      throw new Error(`${pass.desc} uses the unsupported directive //!${name}`);
  }
}

/**
 * Tokenises one of mpv's reverse-polish size expressions, such as
 * `OUTPUT.w MAIN.w / 1.200 >`.
 *
 * @param {string} text The directive's argument.
 * @returns {Array<number|string>} Tokens ready for {@link evaluateSizeExpression}.
 */
export function parseSizeExpression(text) {
  return text
    .split(/\s+/)
    .filter(token => token.length)
    .map(token => {
      if (/^[-+]?[0-9]*\.?[0-9]+$/.test(token)) {
        return Number(token);
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*\.[wh]$/.test(token)) {
        return token;
      }
      if (token in SIZE_OPERATORS || token == "!") {
        return token;
      }
      throw new Error(`Unsupported size expression token: ${token}`);
    });
}

/**
 * Evaluates a parsed size expression.
 *
 * @param {Array<number|string>} tokens Output of {@link parseSizeExpression}.
 * @param {Function} resolve Maps a texture name to `{ width, height }`.
 * @returns {number} The expression's value; comparisons yield 1 or 0.
 */
export function evaluateSizeExpression(tokens, resolve) {
  let stack = [];
  for (let token of tokens) {
    if (typeof token == "number") {
      stack.push(token);
      continue;
    }
    if (token == "!") {
      stack.push(stack.pop() ? 0 : 1);
      continue;
    }
    let operator = SIZE_OPERATORS[token];
    if (operator) {
      let right = stack.pop();
      let left = stack.pop();
      if (left === undefined || right === undefined) {
        throw new Error(`Size expression underflowed at "${token}"`);
      }
      stack.push(operator(left, right));
      continue;
    }

    let [name, axis] = token.split(".");
    let size = resolve(name);
    if (!size) {
      throw new Error(`Size expression refers to unknown texture ${name}`);
    }
    stack.push(axis == "w" ? size.width : size.height);
  }
  if (stack.length != 1) {
    throw new Error("Size expression did not reduce to a single value");
  }
  return stack[0];
}

/**
 * Works out which passes actually run for a given frame size and how large each
 * one's output has to be.
 *
 * This mirrors mpv's own bookkeeping: passes execute in pipeline-stage order
 * rather than file order, `//!WHEN` gates them against the sizes as they stand
 * at that point in the chain, and a pass that saves a texture changes the size
 * every later expression sees.
 *
 * @param {ShaderPass[]} passes Every pass of every selected shader, in the order
 *   the user listed the shaders.
 * @param {object} frame `{ sourceWidth, sourceHeight, outputWidth, outputHeight }`.
 * @returns {object} `{ steps, width, height }` where each step carries its pass
 *   and the exact size of its render target, and `width`/`height` describe the
 *   final MAIN texture.
 */
export function buildRenderPlan(passes, frame) {
  let sizes = new Map([
    [NATIVE, { width: frame.sourceWidth, height: frame.sourceHeight }],
    [MAIN, { width: frame.sourceWidth, height: frame.sourceHeight }],
    [OUTPUT, { width: frame.outputWidth, height: frame.outputHeight }],
  ]);
  let ordered = [...passes].sort(
    (a, b) => stageRank(a.stage) - stageRank(b.stage)
  );
  let steps = [];

  for (let pass of ordered) {
    let hooked = sizes.get(pass.hook);
    if (!hooked || pass.sources.some(name => !sizes.has(name))) {
      // A texture this pass needs was never produced, because the pass that
      // would have produced it was skipped. mpv drops the dependent pass too.
      continue;
    }

    let resolve = name => (name == HOOKED ? hooked : sizes.get(name));
    if (pass.when && !evaluateSizeExpression(pass.when, resolve)) {
      continue;
    }

    let width = pass.width
      ? toTextureSize(evaluateSizeExpression(pass.width, resolve))
      : hooked.width;
    let height = pass.height
      ? toTextureSize(evaluateSizeExpression(pass.height, resolve))
      : hooked.height;

    steps.push({ pass, width, height });
    sizes.set(pass.target, { width, height });
  }

  let main = sizes.get(MAIN);
  return { steps, width: main.width, height: main.height };
}

function stageRank(hook) {
  let rank = HOOK_ORDER.indexOf(hook);
  return rank < 0 ? HOOK_ORDER.length : rank;
}

function toTextureSize(value) {
  // mpv truncates the float the expression produces; the epsilon keeps sizes
  // such as `1080 2 /` from landing one pixel short through binary rounding.
  return Math.max(1, Math.floor(value + 1e-6));
}

/**
 * The vertex shader every pass shares.
 *
 * `mizuPosition` is the pass's own output coordinate in the 0..1 range, mapped
 * so that a value written at some position reads back at that same position.
 * Frames are uploaded without a vertical flip, which puts the top of the image
 * at y = 0 and makes +y point down exactly as mpv's `_pos` variables do; the
 * kernels therefore see the neighbourhood their authors trained them on.
 */
export const VERTEX_SOURCE = `#version 300 es
in vec2 vertex;
out vec2 mizuPosition;
void main() {
  mizuPosition = (vertex + 1.0) * 0.5;
  gl_Position = vec4(vertex, 0.0, 1.0);
}`;

/**
 * Draws the finished chain to the canvas, optionally blended back towards the
 * untouched frame so the effect strength is adjustable.
 *
 * This is the only pass whose destination is the screen rather than a texture,
 * so it is also where the top-down image is flipped back for display.
 */
export const BLIT_SOURCE = `#version 300 es
precision highp float;
in vec2 mizuPosition;
uniform sampler2D processed;
uniform sampler2D original;
uniform float strength;
out vec4 fragmentColor;
void main() {
  vec2 position = vec2(mizuPosition.x, 1.0 - mizuPosition.y);
  vec3 color = mix(
    texture(original, position).rgb,
    texture(processed, position).rgb,
    strength
  );
  fragmentColor = vec4(color, 1.0);
}`;

/**
 * Builds the WebGL2 fragment shader for a single pass.
 *
 * mpv exposes each bound texture as a family of names (`NAME_tex`, `NAME_pos`,
 * `NAME_pt`, ...). Anime4K's bodies are written against those names, so they are
 * declared here and the body is appended untouched.
 *
 * @param {ShaderPass} pass The pass to translate.
 * @returns {string} GLSL ES 3.00 source.
 */
export function buildFragmentSource(pass) {
  let declarations = [];
  for (let name of pass.sources) {
    declarations.push(`
uniform sampler2D ${name}_raw;
uniform vec2 ${name}_size;
#define ${name}_pos mizuPosition
#define ${name}_pt (1.0 / ${name}_size)
vec4 ${name}_tex(vec2 position) { return texture(${name}_raw, position); }
vec4 ${name}_texOff(vec2 offset) {
  return texture(${name}_raw, mizuPosition + offset / ${name}_size);
}`);
  }

  // Passes may read the hooked texture through mpv's HOOKED alias even when
  // they bind it under its real name, and Thin/Darken bind it under neither.
  if (pass.sources.includes(pass.hook)) {
    declarations.push(`
#define ${HOOKED}_pos mizuPosition
#define ${HOOKED}_size ${pass.hook}_size
#define ${HOOKED}_pt ${pass.hook}_pt
#define ${HOOKED}_tex ${pass.hook}_tex
#define ${HOOKED}_texOff ${pass.hook}_texOff`);
  }

  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 mizuPosition;
out vec4 mizuFragmentColor;
${declarations.join("\n")}

${pass.body}
void main() { mizuFragmentColor = hook(); }
`;
}

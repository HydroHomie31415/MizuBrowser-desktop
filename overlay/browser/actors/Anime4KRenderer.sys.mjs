/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  BLIT_SOURCE,
  MAIN,
  NATIVE,
  VERTEX_SOURCE,
  buildFragmentSource,
  buildRenderPlan,
} from "resource:///actors/Anime4KProgram.sys.mjs";
import {
  QUALITY_TIERS,
  loadChain,
  resolveChain,
} from "resource:///actors/Anime4KLibrary.sys.mjs";

/**
 * Runs an Anime4K chain over a playing `<video>` and paints the result into a
 * canvas.
 *
 * The renderer owns every piece of GPU state and is expected to survive things
 * the page does to it: the source can change resolution mid-stream when an
 * adaptive player switches rendition, the display size changes on every
 * fullscreen toggle, and the WebGL context itself can be lost when the
 * compositor is reconfigured. All three rebuild the pipeline rather than
 * failing, because the alternative the user sees is a black frame.
 */
export class Anime4KRenderer {
  /**
   * @param {HTMLCanvasElement} canvas Destination canvas.
   * @param {HTMLVideoElement} video Source video.
   * @param {Window} window The content window both elements belong to.
   * @param {object} settings Initial settings, see {@link configure}.
   */
  constructor(canvas, video, window, settings) {
    this.canvas = canvas;
    this.video = video;
    this.window = window;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };

    this.stats = emptyStats();
    this.onstats = null;
    this.onerror = null;
    this.onsuspend = null;

    this.running = false;
    this.contextLost = false;
    this.suspended = false;

    this.gl = null;
    this.programs = new Map();
    this.pending = [];
    this.blitProgram = null;
    this.framebuffer = null;
    this.vertexBuffer = null;
    this.sourceTexture = null;
    this.plan = null;
    this.chain = [];
    this.textures = new Map();
    this.pool = new Map();
    this.pooledBytes = 0;

    this.frameHandle = null;
    this.lastPresentTime = 0;
    this.lastPosition = -1;
    this.lastStatsTime = 0;
    this.lastLayoutTime = 0;
    this.layoutDirty = true;
    this.cachedOutput = null;
    this.lastScale = 0;
    this.sourceSize = { width: 0, height: 0 };
    this.slowFrames = 0;

    this.onContextLost = event => {
      // Without preventDefault the context can never come back, and the canvas
      // stays black over a video that is still playing underneath it.
      event.preventDefault();
      this.contextLost = true;
      this.#teardownGPUState(false);
      this.stats.state = "context-lost";
      this.#publishStats();
      this.onsuspend?.("The graphics context was lost; recovering");
    };
    this.onContextRestored = () => {
      this.contextLost = false;
      if (this.running) {
        try {
          this.#initialize();
          this.stats.state = "running";
          this.#publishStats();
        } catch (error) {
          this.#fail(error);
        }
      }
    };
  }

  /**
   * Starts processing. Throws if the machine cannot run the pipeline at all, in
   * which case the caller should leave the untouched video on screen.
   */
  start() {
    if (this.running) {
      return;
    }
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener(
      "webglcontextrestored",
      this.onContextRestored
    );
    this.#initialize();
    this.running = true;
    this.stats.state = "running";
    this.#schedule();
  }

  /** Releases every GPU resource and stops the frame loop. */
  stop() {
    this.running = false;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.onContextRestored
    );
    this.#cancelFrame();
    this.#teardownGPUState(true);
    this.stats = emptyStats();
  }

  /**
   * Applies new settings. Changes that alter the shader chain rebuild the
   * pipeline on the next frame; the rest take effect immediately.
   *
   * @param {object} settings Partial settings to merge in.
   */
  configure(settings) {
    let previous = this.settings;
    this.settings = { ...previous, ...settings };
    if (
      this.settings.mode != previous.mode ||
      this.settings.quality != previous.quality ||
      String(this.settings.extras) != String(previous.extras)
    ) {
      this.chain = [];
      this.plan = null;
    }
    // Any deliberate change is worth retrying a pipeline we gave up on.
    this.suspended = false;
    this.slowFrames = 0;
    this.layoutDirty = true;
  }

  /** True when the pipeline is producing frames the caller should show. */
  get painting() {
    return this.running && !this.contextLost && this.stats.state == "running";
  }

  #initialize() {
    let gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
      // Frames the video has not advanced past are skipped, so the canvas has
      // to keep showing the last one it drew instead of being cleared.
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!gl) {
      throw new Error("WebGL2 is unavailable");
    }
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("This GPU cannot render to floating-point textures");
    }
    gl.getExtension("OES_texture_float_linear");
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    this.programs = new Map();
    this.pending = [];
    this.textures = new Map();
    this.pool = new Map();
    this.pooledBytes = 0;
    this.plan = null;

    this.vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    );
    this.framebuffer = gl.createFramebuffer();
    this.blitProgram = this.#createProgram(BLIT_SOURCE, "blit");
    this.sourceTexture = this.#createTexture(gl.RGBA8, 1, 1);
    this.sourceSize = { width: 0, height: 0 };
    this.stats.backend = gl.getParameter(gl.VERSION);
  }

  #teardownGPUState(deleteObjects) {
    let gl = this.gl;
    if (gl && deleteObjects && !this.contextLost) {
      for (let entry of this.programs.values()) {
        gl.deleteProgram(entry.program);
      }
      if (this.blitProgram) {
        gl.deleteProgram(this.blitProgram.program);
      }
      for (let list of this.pool.values()) {
        for (let texture of list) {
          gl.deleteTexture(texture.handle);
        }
      }
      for (let texture of new Set(this.textures.values())) {
        gl.deleteTexture(texture.handle);
      }
      gl.deleteTexture(this.sourceTexture?.handle);
      gl.deleteFramebuffer(this.framebuffer);
      gl.deleteBuffer(this.vertexBuffer);
    }
    this.programs = new Map();
    this.textures = new Map();
    this.pool = new Map();
    this.pooledBytes = 0;
    this.blitProgram = null;
    this.framebuffer = null;
    this.vertexBuffer = null;
    this.sourceTexture = null;
    this.plan = null;
    this.gl = null;
  }

  #schedule() {
    if (!this.running || this.contextLost) {
      return;
    }
    // requestVideoFrameCallback would be the natural fit, but it is delivered
    // to this actor about once a second rather than once per decoded frame, so
    // the loop runs off the refresh rate and drops frames it has already seen.
    this.frameHandle = this.window.requestAnimationFrame(now => {
      this.frameHandle = null;
      try {
        this.#onFrame(now);
      } catch (error) {
        this.#fail(error);
        return;
      }
      this.#schedule();
    });
  }

  #cancelFrame() {
    if (this.frameHandle === null) {
      return;
    }
    this.window.cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  #onFrame(now) {
    let width = this.video.videoWidth;
    let height = this.video.videoHeight;
    if (!width || !height) {
      return;
    }

    let ceiling = this.settings.maxSourceHeight;
    if (ceiling > 0 && height > ceiling) {
      this.#suspend(
        `Source is already ${height}p, above the ${ceiling}p processing limit`
      );
      return;
    }
    if (this.suspended) {
      // A source that changed resolution is worth another try; the same one is
      // not, or we would spend every frame rediscovering that it is too slow.
      if (width == this.sourceSize.width && height == this.sourceSize.height) {
        return;
      }
      this.suspended = false;
    }

    if (this.settings.frameRateLimit > 0) {
      let interval = 1000 / this.settings.frameRateLimit;
      if (now - this.lastPresentTime < interval - 1) {
        this.stats.skipped++;
        return;
      }
    }

    // The refresh rate is usually higher than the frame rate, so most callbacks
    // are looking at a frame that has already been through the chain. The
    // canvas keeps its contents, which is what makes skipping them safe.
    let position = this.video.currentTime;
    if (position == this.lastPosition && this.plan && !this.pending.length) {
      return;
    }
    this.lastPosition = position;

    this.#ensurePipeline(width, height);
    if (!this.plan || this.#compilePending()) {
      return;
    }

    let started = this.window.performance.now();
    this.#render();
    let elapsed = this.window.performance.now() - started;

    this.stats.frames++;
    this.stats.renderMs = ease(this.stats.renderMs, elapsed);
    if (this.lastPresentTime) {
      this.stats.frameIntervalMs = ease(
        this.stats.frameIntervalMs,
        now - this.lastPresentTime
      );
    }
    this.lastPresentTime = now;
    this.#trackPerformance(elapsed);
    this.#publishStats();
  }

  #ensurePipeline(width, height) {
    let output = this.#outputSize(width, height);
    let sourceChanged =
      width != this.sourceSize.width || height != this.sourceSize.height;

    if (
      this.plan &&
      !sourceChanged &&
      output.width == this.stats.outputWidth &&
      output.height == this.stats.outputHeight
    ) {
      return;
    }

    if (sourceChanged) {
      this.sourceSize = { width, height };
      this.#recreateSourceTexture(width, height);
    }
    this.stats.outputWidth = output.width;
    this.stats.outputHeight = output.height;

    if (!this.chain.length) {
      let files = resolveChain(this.settings);
      this.chain = loadChain(files);
      this.stats.shaders = files;
    }

    let plan = buildRenderPlan(this.chain, {
      sourceWidth: width,
      sourceHeight: height,
      outputWidth: output.width,
      outputHeight: output.height,
    });
    if (plan.width > this.maxTextureSize || plan.height > this.maxTextureSize) {
      throw new Error(
        `The chain wants a ${plan.width}x${plan.height} texture, ` +
          `above this GPU's ${this.maxTextureSize} limit`
      );
    }

    this.plan = plan;
    this.canvas.width = plan.width;
    this.canvas.height = plan.height;
    this.stats.sourceWidth = width;
    this.stats.sourceHeight = height;
    this.stats.width = plan.width;
    this.stats.height = plan.height;
    this.stats.passes = plan.steps.length;
    this.stats.state = "running";
    this.slowFrames = 0;
    this.#prepareProgramsFor(plan);
  }

  /**
   * Tells the renderer its canvas may have changed size, which happens on every
   * fullscreen toggle and window resize.
   */
  invalidateLayout() {
    this.layoutDirty = true;
  }

  /**
   * The size the finished frame is actually shown at, in device pixels. Anime4K
   * uses it to decide how far to upscale, so getting it wrong either wastes a
   * whole extra x2 pass or leaves the image soft.
   *
   * Measuring forces a layout flush, so the result is cached; sizes are also
   * quantised so that dragging a window edge does not reallocate the whole
   * pipeline on every pixel.
   */
  #outputSize(width, height) {
    let now = this.window.performance.now();
    if (
      !this.layoutDirty &&
      this.cachedOutput &&
      now - this.lastLayoutTime < LAYOUT_INTERVAL_MS
    ) {
      return this.cachedOutput;
    }
    this.layoutDirty = false;
    this.lastLayoutTime = now;

    // Measured on the video rather than the canvas: the canvas is hidden until
    // the first processed frame exists, so measuring it would report no size,
    // pick a 1x target, drop the upscale passes, and then flip back the moment
    // the canvas appeared -- rebuilding and recompiling the chain forever.
    let box = this.video.getBoundingClientRect();
    let ratio = this.window.devicePixelRatio || 1;
    let scale = this.lastScale || 1;
    if (box.width > 0 && box.height > 0) {
      let fit = Math.min(box.width / width, box.height / height);
      scale = Math.max(1, fit * ratio);
      this.lastScale = scale;
    }
    let cap = this.settings.maxOutputScale;
    if (cap > 0) {
      scale = Math.min(scale, cap);
    }
    this.cachedOutput = {
      width: quantise(width * scale),
      height: quantise(height * scale),
    };
    return this.cachedOutput;
  }

  #recreateSourceTexture(width, height) {
    let gl = this.gl;
    gl.deleteTexture(this.sourceTexture.handle);
    this.sourceTexture = this.#createTexture(gl.RGBA8, width, height);
  }

  #prepareProgramsFor(plan) {
    this.pending = plan.steps
      .map(step => step.pass)
      .filter(pass => !this.programs.has(pass));
    if (this.pending.length) {
      this.stats.state = "compiling";
    }
  }

  /**
   * Compiles a couple of programs per frame.
   *
   * A large chain is thirty programs of dense matrix arithmetic, and compiling
   * them in one go stalls the content process long enough to drop audio. The
   * player keeps the untouched video on screen until this returns false.
   *
   * @returns {boolean} True while programs are still outstanding.
   */
  #compilePending() {
    if (!this.pending.length) {
      return false;
    }
    for (let count = 0; count < COMPILE_PER_FRAME && this.pending.length; ) {
      let pass = this.pending.shift();
      if (this.programs.has(pass)) {
        continue;
      }
      this.programs.set(
        pass,
        this.#createProgram(buildFragmentSource(pass), pass.desc)
      );
      count++;
    }
    if (this.pending.length) {
      this.#publishStats();
      return true;
    }
    this.stats.state = "running";
    return false;
  }

  #render() {
    let gl = this.gl;
    let plan = this.plan;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture.handle);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.video
    );

    this.#releaseAll();
    this.textures.set(NATIVE, this.sourceTexture);
    this.textures.set(MAIN, this.sourceTexture);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    for (let step of plan.steps) {
      this.#runStep(step);
    }

    let result = this.textures.get(MAIN);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    let blit = this.blitProgram;
    gl.useProgram(blit.program);
    this.#bindVertices(blit);
    this.#bindSampler(blit, "processed", result, 0);
    this.#bindSampler(blit, "original", this.sourceTexture, 1);
    gl.uniform1f(blit.uniform("strength"), this.settings.strength);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  #runStep(step) {
    let gl = this.gl;
    let entry = this.programs.get(step.pass);
    let target = this.#acquire(step.width, step.height, step.pass.components);

    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      target.handle,
      0
    );
    gl.viewport(0, 0, step.width, step.height);
    gl.useProgram(entry.program);
    this.#bindVertices(entry);

    let unit = 0;
    for (let name of step.pass.sources) {
      let texture = this.textures.get(name);
      this.#bindSampler(entry, `${name}_raw`, texture, unit++);
      gl.uniform2f(
        entry.uniform(`${name}_size`),
        texture.width,
        texture.height
      );
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    let replaced = this.textures.get(step.pass.target);
    this.textures.set(step.pass.target, target);
    if (
      replaced &&
      replaced != this.sourceTexture &&
      !this.#isBound(replaced)
    ) {
      this.#release(replaced);
    }
  }

  #isBound(texture) {
    for (let bound of this.textures.values()) {
      if (bound == texture) {
        return true;
      }
    }
    return false;
  }

  #bindVertices(entry) {
    let gl = this.gl;
    gl.enableVertexAttribArray(entry.vertex);
    gl.vertexAttribPointer(entry.vertex, 2, gl.FLOAT, false, 0, 0);
  }

  #bindSampler(entry, name, texture, unit) {
    let gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture.handle);
    gl.uniform1i(entry.uniform(name), unit);
  }

  #acquire(width, height, components) {
    let format = formatFor(this.gl, components);
    let key = `${width}x${height}x${format.internal}`;
    let free = this.pool.get(key);
    if (free?.length) {
      let texture = free.pop();
      this.pooledBytes -= texture.bytes;
      return texture;
    }
    return this.#createTexture(format.internal, width, height);
  }

  #release(texture) {
    let key = `${texture.width}x${texture.height}x${texture.internal}`;
    let free = this.pool.get(key);
    if (!free) {
      free = [];
      this.pool.set(key, free);
    }
    free.push(texture);
    this.pooledBytes += texture.bytes;
    this.#trimPool();
  }

  #releaseAll() {
    for (let texture of new Set(this.textures.values())) {
      if (texture != this.sourceTexture) {
        this.#release(texture);
      }
    }
    this.textures.clear();
  }

  #trimPool() {
    // The chain's working set is stable, so anything beyond it is left over
    // from a resolution the video no longer uses.
    while (this.pooledBytes > POOL_BUDGET_BYTES) {
      let largest = null;
      let largestKey = null;
      for (let [key, list] of this.pool) {
        for (let texture of list) {
          if (!largest || texture.bytes > largest.bytes) {
            largest = texture;
            largestKey = key;
          }
        }
      }
      if (!largest) {
        return;
      }
      let list = this.pool.get(largestKey);
      list.splice(list.indexOf(largest), 1);
      this.pooledBytes -= largest.bytes;
      this.gl.deleteTexture(largest.handle);
    }
  }

  #createTexture(internal, width, height) {
    let gl = this.gl;
    let handle = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, height);
    return {
      handle,
      width,
      height,
      internal,
      bytes: width * height * bytesPerTexel(gl, internal),
    };
  }

  #createProgram(fragmentSource, label) {
    let gl = this.gl;
    let program = gl.createProgram();
    let vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE, label);
    let fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, label);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`${label}: ${gl.getProgramInfoLog(program)}`);
    }

    let locations = new Map();
    return {
      program,
      vertex: gl.getAttribLocation(program, "vertex"),
      uniform(name) {
        if (!locations.has(name)) {
          locations.set(name, gl.getUniformLocation(program, name));
        }
        return locations.get(name);
      },
    };
  }

  #trackPerformance(elapsed) {
    if (!this.settings.adaptive || this.stats.frames < 30) {
      return;
    }
    // The frame is late when producing it eats most of the gap between two
    // decoded frames; a couple of stutters are normal, a run of them is not.
    let budget = Math.max(8, (this.stats.frameIntervalMs || 40) * 0.8);
    this.slowFrames = elapsed > budget ? this.slowFrames + 1 : 0;
    if (this.slowFrames < 45) {
      return;
    }
    this.slowFrames = 0;

    let index = QUALITY_TIERS.findIndex(
      tier => tier.id == this.settings.quality
    );
    if (index > 0) {
      let lighter = QUALITY_TIERS[index - 1];
      this.configure({ quality: lighter.id });
      this.onsuspend?.(
        `Anime4K could not keep up; dropped to ${lighter.label} quality`
      );
      this.stats.autoAdjusted = lighter.id;
    } else {
      this.#suspend("Anime4K cannot keep up with this video on this GPU");
    }
  }

  #suspend(reason) {
    let repeated = this.suspended && this.stats.reason == reason;
    this.suspended = true;
    this.stats.state = "suspended";
    this.stats.reason = reason;
    if (!repeated) {
      this.#publishStats();
      this.onsuspend?.(reason);
    }
  }

  #fail(error) {
    this.stop();
    this.stats.state = "failed";
    this.stats.reason = error.message;
    this.onerror?.(error);
  }

  #publishStats() {
    // The overlay is read by a person, not by another machine.
    let now = this.window.performance.now();
    if (now - this.lastStatsTime < STATS_INTERVAL_MS) {
      return;
    }
    this.lastStatsTime = now;
    this.onstats?.(this.stats);
  }
}

const DEFAULT_SETTINGS = {
  mode: "a",
  quality: "M",
  extras: [],
  strength: 1,
  frameRateLimit: 0,
  maxSourceHeight: 1080,
  maxOutputScale: 4,
  adaptive: true,
};

/** 256MB of spare render targets is far more than any chain needs. */
const POOL_BUDGET_BYTES = 256 * 1024 * 1024;

/** Shader compilation is synchronous, so it is spread over several frames. */
const COMPILE_PER_FRAME = 2;

const STATS_INTERVAL_MS = 250;
const LAYOUT_INTERVAL_MS = 500;

function quantise(value) {
  return Math.max(8, Math.round(value / 8) * 8);
}

function emptyStats() {
  return {
    state: "idle",
    reason: "",
    backend: "",
    shaders: [],
    passes: 0,
    frames: 0,
    skipped: 0,
    renderMs: 0,
    frameIntervalMs: 0,
    sourceWidth: 0,
    sourceHeight: 0,
    outputWidth: 0,
    outputHeight: 0,
    width: 0,
    height: 0,
    autoAdjusted: "",
  };
}

function ease(previous, sample) {
  return previous ? previous * 0.9 + sample * 0.1 : sample;
}

function formatFor(gl, components) {
  // RGB16F is not colour-renderable in WebGL2, so three-component passes round
  // up rather than falling back to a slower readback path.
  if (components <= 1) {
    return { internal: gl.R16F };
  }
  if (components == 2) {
    return { internal: gl.RG16F };
  }
  return { internal: gl.RGBA16F };
}

function bytesPerTexel(gl, internal) {
  switch (internal) {
    case gl.R16F:
      return 2;
    case gl.RG16F:
      return 4;
    case gl.RGBA8:
      return 4;
    default:
      return 8;
  }
}

function compile(gl, type, source, label) {
  let shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`${label}: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

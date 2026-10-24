import { VERTEX_SHADER, FRAGMENT_SHADER, FALLBACK_FRAGMENT_SHADER } from './shaders.js';

export const QUALITY_PRESETS = Object.freeze({
  low: Object.freeze({ renderScale: 0.65, steps: 48, dprLimit: 1, maxWidth: 960 }),
  balanced: Object.freeze({ renderScale: 0.85, steps: 88, dprLimit: 1.5, maxWidth: 1280 }),
  high: Object.freeze({ renderScale: 1, steps: 144, dprLimit: 2, maxWidth: 2560 }),
});

const PATTERNS = Object.freeze({ mirror: 0, square: 1, diamond: 2, triangle: 3, radial: 4 });
const BACKGROUNDS = Object.freeze({
  cyber: [0.018, 0.025, 0.045], golden: [0.035, 0.022, 0.01], void: [0.005, 0.006, 0.012],
});
const UNIFORMS = [
  'image', 'resolution', 'imageAspect', 'anchor', 'time', 'zoom', 'rotation', 'folds',
  'pattern', 'morph', 'warp', 'imageMix', 'pointer', 'energy', 'pinch', 'depth',
  'paletteA', 'paletteB', 'background', 'steps', 'guides',
];

const bounded = (value, fallback, lo, hi) => Number.isFinite(value)
  ? Math.min(hi, Math.max(lo, value)) : fallback;
const rgb = (value, fallback) => [0, 1, 2].map(i => bounded(value?.[i], fallback[i], 0, 1));

function compileShader(gl, kind, source) {
  const shader = gl.createShader(kind);
  if (!shader) throw new Error('The graphics driver could not allocate a shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'No compiler diagnostic was returned.';
    gl.deleteShader(shader);
    throw new Error(`${kind === gl.VERTEX_SHADER ? 'Vertex' : 'Fragment'} shader: ${log}`);
  }
  return shader;
}

function makeProgram(gl, fragment) {
  let vertex, pixel, program;
  try {
    vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    pixel = compileShader(gl, gl.FRAGMENT_SHADER, fragment);
    program = gl.createProgram();
    if (!program) throw new Error('The graphics driver could not allocate a program.');
    gl.attachShader(program, vertex);
    gl.attachShader(program, pixel);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Shader link: ${gl.getProgramInfoLog(program) || 'Unknown driver error.'}`);
    }
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    if (vertex) gl.deleteShader(vertex);
    if (pixel) gl.deleteShader(pixel);
  }
}

/**
 * Renderer owns GPU resources, not the animation loop or ImageSource lifetime.
 * Anchors and interaction.x/y use top-left normalized coordinates. Source
 * rotation rotates the reflection layout; zoom > 1 crops toward the anchor.
 * The input module already smooths gestures: do not add another latency filter.
 * Call setSource again after editing the source canvas/background mask.
 */
export class Renderer {
  constructor(canvas, { onError = () => {}, onStatus = () => {} } = {}) {
    this.canvas = canvas;
    this.onError = onError;
    this.onStatus = onStatus;
    this.gl = null;
    this.ready = false;
    this.fallback = false;
    this.disposed = false;
    this.contextLost = false;
    this.source = null;
    this.imageAspect = 1;
    this.program = null;
    this.texture = null;
    this.vao = null;
    this.uniforms = {};
    this._time = 0;
    this._lastError = '';
    this._onLost = event => {
      event.preventDefault(); // Opt in to WebGL's asynchronous context recovery.
      this.contextLost = true;
      this.ready = false;
      this.onStatus('Graphics context lost; waiting for recovery.');
    };
    this._onRestored = () => {
      if (this.disposed) return;
      this.contextLost = false;
      // Old handles are invalid after a loss. Rebuild and re-upload the latest
      // source, including any mask changes made while the context was lost.
      this.program = this.texture = this.vao = null;
      this._initialize();
      if (this.ready) this.onStatus(this.fallback
        ? 'Graphics recovered in simple mirror mode.' : 'Graphics context restored.');
    };
    if (!canvas?.getContext || !canvas?.addEventListener) {
      this._error(new Error('Renderer requires an HTML canvas.'));
      return;
    }
    canvas.addEventListener('webglcontextlost', this._onLost);
    canvas.addEventListener('webglcontextrestored', this._onRestored);
    try {
      this.gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      });
      if (!this.gl) throw new Error('WebGL2 is unavailable. Enable browser hardware acceleration or try another browser.');
      this._initialize();
    } catch (error) {
      this._error(error);
    }
  }

  _error(error) {
    const detail = error instanceof Error ? error : new Error(String(error));
    // Avoid a toast every frame if the driver has stopped accepting commands.
    if (detail.message === this._lastError) return;
    this._lastError = detail.message;
    this.onError(detail);
  }

  _initialize() {
    const gl = this.gl;
    this.ready = false;
    this.fallback = false;
    this._lastError = '';
    try {
      try {
        this.program = makeProgram(gl, FRAGMENT_SHADER);
      } catch (error) {
        this._error(error);
        this.program = makeProgram(gl, FALLBACK_FRAGMENT_SHADER);
        this.fallback = true;
        this.onStatus('Full shader unavailable; using simple image mirrors.');
      }
      for (const name of UNIFORMS) this.uniforms[name] = gl.getUniformLocation(this.program, `u_${name}`);
      this.vao = gl.createVertexArray();
      this.texture = gl.createTexture();
      if (!this.vao || !this.texture) throw new Error('The graphics driver could not allocate rendering resources.');
      gl.bindVertexArray(this.vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.DITHER); // Preserve source values, especially monochrome.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      // A complete texture is valid even before the asynchronous image arrives.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([24, 29, 43, 255]));
      gl.generateMipmap(gl.TEXTURE_2D);
      this._maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      this._maxSize = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), viewport[0], viewport[1]);
      this.ready = true;
      if (this.source) this.setSource(this.source);
      if (!this.fallback) this.onStatus('WebGL2 renderer ready.');
    } catch (error) {
      this._deleteResources();
      this._error(error);
    }
  }

  setSource(source) {
    if (this.disposed) return;
    const width = source?.canvas?.width;
    const height = source?.canvas?.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      this._error(new Error('ImageSource must contain a non-empty canvas.'));
      return;
    }
    // Store even during context loss; restoration should use the new source.
    this.source = source;
    if (!this.ready || this.contextLost) return;
    const gl = this.gl;
    let nextTexture;
    try {
      let pixels = source.canvas;
      if (Math.max(width, height) > this._maxTexture) {
        const ratio = this._maxTexture / Math.max(width, height);
        const reduced = this.canvas.ownerDocument.createElement('canvas');
        reduced.width = Math.max(1, Math.round(width * ratio));
        reduced.height = Math.max(1, Math.round(height * ratio));
        const context = reduced.getContext('2d');
        if (!context) throw new Error('Unable to resize the image for this GPU.');
        context.imageSmoothingQuality = 'high';
        context.drawImage(pixels, 0, 0, reduced.width, reduced.height);
        pixels = reduced;
        this.onStatus(`Image scaled to ${reduced.width} × ${reduced.height} for this GPU.`);
      }
      // Upload transactionally: an invalid/tainted canvas keeps the previous
      // texture on screen rather than erasing a working composition.
      nextTexture = gl.createTexture();
      if (!nextTexture) throw new Error('Unable to allocate the image texture.');
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, nextTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.generateMipmap(gl.TEXTURE_2D);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`Image texture upload failed (WebGL error ${error}).`);
      gl.deleteTexture(this.texture);
      this.texture = nextTexture;
      nextTexture = null;
      const sourceWidth = bounded(source.width, width, 1, 1e8);
      const sourceHeight = bounded(source.height, height, 1, 1e8);
      this.imageAspect = sourceWidth / sourceHeight;
      this._lastError = '';
    } catch (error) {
      if (nextTexture) gl.deleteTexture(nextTexture);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      this._error(error);
    }
  }

  _resize(quality) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const dpr = bounded(globalThis.devicePixelRatio, 1, 0.5, quality.dprLimit);
    let scale = dpr * quality.renderScale;
    // Bound both dimensions and total allocation on large/retina displays.
    scale = Math.min(scale, quality.maxWidth / rect.width,
      this._maxSize / Math.max(rect.width, rect.height),
      Math.sqrt(8294400 / (rect.width * rect.height)));
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
    return true;
  }

  render({ time = 0, dt = 0, scene = {}, interaction = {} } = {}) {
    if (this.disposed || !this.ready || this.contextLost || this.gl.isContextLost()) return;
    const quality = QUALITY_PRESETS[scene.quality] || QUALITY_PRESETS.balanced;
    try {
      if (!this._resize(quality)) return;
      if (!scene.paused) this._time = bounded(time, this._time + bounded(dt, 0, 0, 0.1), 0, 1e9);
      const gl = this.gl;
      const u = this.uniforms;
      const anchor = scene.anchor || this.source?.anchor || { x: 0.5, y: 0.5 };
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(u.image, 0);
      gl.uniform2f(u.resolution, this.canvas.width, this.canvas.height);
      gl.uniform1f(u.imageAspect, this.imageAspect);
      gl.uniform2f(u.anchor, bounded(anchor.x, 0.5, 0, 1), bounded(anchor.y, 0.5, 0, 1));
      gl.uniform1f(u.time, this._time);
      gl.uniform1f(u.zoom, bounded(scene.zoom, 1, 0.1, 16));
      gl.uniform1f(u.rotation, bounded(scene.rotation, 0, -1e6, 1e6) % (Math.PI * 2));
      // Integer folds close the radial branch cut exactly. Gestures deform
      // the common folded domain instead of introducing fractional sectors.
      gl.uniform1f(u.folds, Math.round(bounded(scene.folds, 6, 2, 32)));
      gl.uniform1i(u.pattern, PATTERNS[scene.pattern] ?? PATTERNS.radial);
      gl.uniform1f(u.morph, bounded(scene.morph, 0.35, 0, 1));
      gl.uniform1f(u.warp, bounded(scene.warp, 0.5, 0, 1));
      gl.uniform1f(u.imageMix, bounded(scene.imageMix, 1, 0, 1));
      gl.uniform2f(u.pointer, bounded(interaction.x, 0.5, 0, 1), bounded(interaction.y, 0.5, 0, 1));
      gl.uniform1f(u.energy, bounded(interaction.energy, 0, 0, 1));
      gl.uniform1f(u.pinch, bounded(interaction.pinch, 0, 0, 1));
      gl.uniform1f(u.depth, bounded(interaction.depth, 0.5, 0, 1));
      gl.uniform3fv(u.paletteA, rgb(scene.paletteA, [0.2, 0.85, 0.9]));
      gl.uniform3fv(u.paletteB, rgb(scene.paletteB, [0.8, 0.3, 0.95]));
      gl.uniform3fv(u.background, BACKGROUNDS[scene.preset] || BACKGROUNDS.cyber);
      gl.uniform1i(u.steps, quality.steps);
      gl.uniform1i(u.guides, scene.guides ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } catch (error) {
      this._error(error);
    }
  }

  _deleteResources() {
    if (this.gl && !this.contextLost) {
      if (this.texture) this.gl.deleteTexture(this.texture);
      if (this.vao) this.gl.deleteVertexArray(this.vao);
      if (this.program) this.gl.deleteProgram(this.program);
    }
    this.texture = this.vao = this.program = null;
    this.ready = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas?.removeEventListener?.('webglcontextlost', this._onLost);
    this.canvas?.removeEventListener?.('webglcontextrestored', this._onRestored);
    this._deleteResources();
    this.source = null;
  }
}

export default Renderer;

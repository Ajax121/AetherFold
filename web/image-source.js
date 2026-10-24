// Image coordinates are normalized, TOP LEFT. Source textures contain no padding.
// Analysis estimates useful detail, not semantic subjects or guaranteed subject fusion.
export const MAX_SOURCE_SIZE = 2048;
export const MOBILE_SOURCE_SIZE = 1280;
export const MIN_CROP_ZOOM = 0.25;
export const MAX_CROP_ZOOM = 6;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const DECODE_TIMEOUT = 20000;
const ANALYSIS_SIZE = 256;

const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const normalizedAnchor = anchor => ({
  x: clamp(finite(anchor?.x, 0.5)), y: clamp(finite(anchor?.y, 0.5)),
});
const smoothstep = (a, b, value) => {
  const t = clamp((value - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Mobile browsers retain the decoded image, the original canvas, the editable
 * canvas, analysis pixels, and a GPU texture at once. Keep enough source detail
 * for a phone screen without exhausting that much smaller memory budget.
 */
export function sourceSizeLimit({ coarsePointer = false, shortEdge = Infinity } = {}) {
  return coarsePointer && Number.isFinite(shortEdge) && shortEdge <= 680
    ? MOBILE_SOURCE_SIZE : MAX_SOURCE_SIZE;
}

function runtimeSourceSizeLimit() {
  const width = finite(globalThis.innerWidth, Infinity);
  const height = finite(globalThis.innerHeight, Infinity);
  const coarsePointer = Boolean(globalThis.matchMedia?.('(pointer: coarse)')?.matches);
  return sourceSizeLimit({ coarsePointer, shortEdge: Math.min(width, height) });
}

export function boundedDimensions(width, height, limit = MAX_SOURCE_SIZE) {
  if (![width, height, limit].every(v => Number.isFinite(v) && v >= 1)) {
    throw new RangeError('Image dimensions must be positive finite numbers.');
  }
  const scale = Math.min(1, limit / width, limit / height);
  return {width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale))};
}

// Preview coordinates are CSS pixels, independent of canvas backing-store DPI.
export function fitImageRect(width, height, viewportWidth, viewportHeight, padding = 12) {
  if (![width, height, viewportWidth, viewportHeight].every(v => Number.isFinite(v) && v > 0)) {
    return {x: 0, y: 0, width: 0, height: 0};
  }
  const inset = clamp(finite(padding, 0), 0, Math.min(viewportWidth, viewportHeight) / 2);
  const scale = Math.max(0, Math.min((viewportWidth - 2 * inset) / width,
    (viewportHeight - 2 * inset) / height));
  return {x: (viewportWidth - width * scale) / 2, y: (viewportHeight - height * scale) / 2,
    width: width * scale, height: height * scale};
}

export function pointToImage(x, y, rect, clampOutside = false) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width <= 0 || rect.height <= 0) return null;
  const point = {x: (x - rect.x) / rect.width, y: (y - rect.y) / rect.height};
  if (!clampOutside && (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) return null;
  return normalizedAnchor(point);
}

export function imageToPoint(point, rect) {
  return {x: rect.x + point.x * rect.width, y: rect.y + point.y * rect.height};
}

// Matches shaders.js: UV = anchor + q / (sourceAspect, 1) / zoom.
// The anchor is the CORNER of the source motif, not the centre of a photo crop.
// Square/diamond/triangle use q in [0,.65]; mirror/radial show a representative
// unit-height motif with radius .75 (the viewport/gesture can extend it).
// Layout rotation acts BEFORE folding; it does not rotate this source region.
// Coordinates may extend outside [0,1]: the renderer reflects at image edges.
export function cropWindow(width, height, anchor, zoom = 1, pattern = 'square', folds = 6) {
  boundedDimensions(width, height);
  const center = normalizedAnchor(anchor);
  const scale = 1 / clamp(finite(zoom, 1), MIN_CROP_ZOOM, MAX_CROP_ZOOM);
  let points;
  if (pattern === 'radial') {
    const wedge = Math.PI / Math.round(clamp(finite(folds, 6), 2, 32));
    points = [[0, 0], ...Array.from({length: 17}, (_, i) =>
      [0.75 * Math.cos(wedge * i / 16), 0.75 * Math.sin(wedge * i / 16)])];
  } else {
    const size = pattern === 'mirror' ? 0.75 : 0.65;
    points = [[0, 0], [size, 0], [size, size]];
    if (pattern !== 'triangle') points.push([0, size]);
  }
  return points.map(([x, y]) => ({
    x: center.x + x * height / width * scale,
    y: center.y + y * scale,
  }));
}

function validatePixels({data, width, height}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      !data || data.length !== width * height * 4) {
    throw new TypeError('Expected RGBA pixels with matching width and height.');
  }
}

function colorDistance(data, offset, color) {
  return Math.hypot(data[offset] - color[0], data[offset + 1] - color[1],
    data[offset + 2] - color[2]) / Math.sqrt(3);
}

// A robust border estimate deliberately refuses busy or multicoloured edges.
function borderModel({data, width, height}) {
  const samples = [];
  const add = (x, y) => {
    const i = 4 * (y * width + x);
    if (data[i + 3] > 220) samples.push([data[i], data[i + 1], data[i + 2]]);
  };
  const stride = Math.max(1, Math.floor(Math.max(width, height) / 128));
  for (let x = 0; x < width; x += stride) { add(x, 0); if (height > 1) add(x, height - 1); }
  for (let y = stride; y < height - 1; y += stride) { add(0, y); if (width > 1) add(width - 1, y); }
  if (samples.length < 4) return {color: [0, 0, 0], confidence: 0};
  const color = [0, 1, 2].map(channel => {
    const sorted = samples.map(pixel => pixel[channel]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  });
  const consistent = samples.filter(pixel => colorDistance(pixel, 0, color) < 24).length;
  return {color, confidence: consistent / samples.length};
}

export function estimateFocalAnchor(pixels) {
  validatePixels(pixels);
  const {data, width, height} = pixels;
  const {color, confidence} = borderModel(pixels);
  const weights = new Float64Array(width * height);
  let total = 0, sumX = 0, sumY = 0;
  const distance = (i, j) => {
    const a = data[i + 3] / 255, b = data[j + 3] / 255;
    return (Math.abs(data[i] * a - data[j] * b) +
      Math.abs(data[i + 1] * a - data[j + 1] * b) +
      Math.abs(data[i + 2] * a - data[j + 2] * b)) / 765 + Math.abs(a - b);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x, i = index * 4, alpha = data[i + 3] / 255;
    if (alpha < 0.05) continue;
    const edge = distance(i, (y * width + Math.max(0, x - 1)) * 4) +
      distance(i, (y * width + Math.min(width - 1, x + 1)) * 4) +
      distance(i, (Math.max(0, y - 1) * width + x) * 4) +
      distance(i, (Math.min(height - 1, y + 1) * width + x) * 4);
    const foreground = confidence > 0.65 ? smoothstep(8, 90, colorDistance(data, i, color)) : 0;
    const weight = alpha * (2 * edge + 0.18 * foreground);
    weights[index] = weight;
    total += weight; sumX += (x + 0.5) * weight; sumY += (y + 0.5) * weight;
  }
  if (total < 1e-6) return {x: 0.5, y: 0.5};
  const centroid = {x: sumX / total, y: sumY / total};
  // Search a detail patch, instead of anchoring in empty space between subjects.
  const stride = width + 1, integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += weights[y * width + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const radius = Math.max(2, Math.round(Math.min(width, height) * 0.14));
  let best = null, bestScore = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = Math.max(0, x - radius), y0 = Math.max(0, y - radius);
    const x1 = Math.min(width, x + radius + 1), y1 = Math.min(height, y + radius + 1);
    const mass = integral[y1 * stride + x1] - integral[y0 * stride + x1] -
      integral[y1 * stride + x0] + integral[y0 * stride + x0];
    const bias = 1 - 0.12 * Math.hypot((x + 0.5 - centroid.x) / width, (y + 0.5 - centroid.y) / height);
    if (mass * bias > bestScore) { bestScore = mass * bias; best = {x0, y0, x1, y1}; }
  }
  let localTotal = 0, localX = 0, localY = 0;
  for (let y = best.y0; y < best.y1; y++) for (let x = best.x0; x < best.x1; x++) {
    const weight = weights[y * width + x];
    localTotal += weight; localX += (x + 0.5) * weight; localY += (y + 0.5) * weight;
  }
  return normalizedAnchor({x: localX / localTotal / width, y: localY / localTotal / height});
}

// Returns an alpha MULTIPLIER, preserving the original alpha when applied.
// Only similar-colour pixels connected to the border are eligible. This is
// conservative colour removal, not person/object segmentation.
export function backgroundAlphaMask(pixels, amount = 0) {
  validatePixels(pixels);
  const {data, width, height} = pixels, count = width * height;
  const alpha = new Uint8ClampedArray(count).fill(255);
  const strength = clamp(finite(amount, 0));
  if (!strength) return alpha;
  const {color, confidence} = borderModel(pixels);
  if (confidence < 0.7) return alpha;
  const threshold = 14 + 36 * strength;
  const visited = new Uint8Array(count), queue = new Uint32Array(count);
  const removal = new Float32Array(count);
  let head = 0, tail = 0;
  const visit = index => {
    if (visited[index]) return;
    visited[index] = 1;
    const distance = colorDistance(data, index * 4, color);
    if (distance > threshold && data[index * 4 + 3] > 8) return;
    queue[tail++] = index;
    removal[index] = data[index * 4 + 3] <= 8 ? 1 :
      1 - smoothstep(threshold * 0.35, threshold, distance);
  };
  for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { visit(y * width); visit(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++], x = index % width, y = Math.floor(index / width);
    if (x > 0) visit(index - 1); if (x + 1 < width) visit(index + 1);
    if (y > 0) visit(index - width); if (y + 1 < height) visit(index + width);
  }
  // A small spatial feather plus colour feather avoids hard binary cutouts.
  // Never feather into a contrasting foreground pixel or an enclosed island.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (!removal[index]) continue;
    let sum = 0, weight = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = clamp(x + dx, 0, width - 1), yy = clamp(y + dy, 0, height - 1);
      const k = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
      sum += removal[yy * width + xx] * k; weight += k;
    }
    alpha[index] = Math.round(255 * (1 - strength * Math.min(removal[index], sum / weight)));
  }
  return alpha;
}

function makeCanvas(width, height, readOften = false) {
  if (typeof document === 'undefined') throw new Error('Image sources need a browser with Canvas 2D.');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', {willReadFrequently: readOften});
  if (!context) throw new Error('Canvas 2D is unavailable in this browser.');
  return {canvas, context};
}

function sourceFromCanvas(original, name) {
  const width = original.width, height = original.height;
  const {canvas, context} = makeCanvas(width, height);
  const analysisSize = boundedDimensions(width, height, ANALYSIS_SIZE);
  const analysis = makeCanvas(analysisSize.width, analysisSize.height, true);
  analysis.context.drawImage(original, 0, 0, analysis.canvas.width, analysis.canvas.height);
  const pixels = analysis.context.getImageData(0, 0, analysis.canvas.width, analysis.canvas.height);
  const anchor = estimateFocalAnchor(pixels);
  let removal = -1, disposed = false;
  const source = {
    canvas, width, height, name, anchor,
    // The editor uses this read-only original, never the masked output canvas.
    originalCanvas: original,
    setBackgroundRemoval(amount) {
      if (disposed) return false;
      const value = clamp(finite(amount, 0));
      if (value === removal) return false;
      context.globalCompositeOperation = 'source-over';
      context.clearRect(0, 0, width, height);
      context.drawImage(original, 0, 0);
      if (value > 0) {
        const mask = backgroundAlphaMask(pixels, value);
        const maskPixels = analysis.context.createImageData(pixels.width, pixels.height);
        for (let i = 0; i < mask.length; i++) {
          maskPixels.data[i * 4] = maskPixels.data[i * 4 + 1] = maskPixels.data[i * 4 + 2] = 255;
          maskPixels.data[i * 4 + 3] = mask[i];
        }
        analysis.context.putImageData(maskPixels, 0, 0);
        context.globalCompositeOperation = 'destination-in';
        context.imageSmoothingEnabled = true;
        context.drawImage(analysis.canvas, 0, 0, width, height);
        context.globalCompositeOperation = 'source-over';
      }
      removal = value;
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Resetting size releases backing stores; retain no decoded Image/Blob.
      for (const item of [canvas, original, analysis.canvas]) { item.width = 1; item.height = 1; }
    },
  };
  source.setBackgroundRemoval(0);
  return source;
}

async function fetchImageBlob(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DECODE_TIMEOUT);
  try {
    const response = await fetch(url, {signal: controller.signal, mode: 'cors', credentials: 'same-origin'});
    if (!response.ok) throw new Error(`Image request failed (HTTP ${response.status}).`);
    if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) {
      controller.abort(); throw new Error('Choose an image smaller than 32 MB.');
    }
    const type = response.headers.get('content-type')?.split(';')[0] || '';
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_FILE_BYTES) {
            await reader.cancel(); throw new Error('Choose an image smaller than 32 MB.');
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return new Blob(chunks, {type});
    }
    return await response.blob();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Image download timed out. Try a local image file.');
    if (error instanceof TypeError) throw new Error('Could not download the image. Check the URL and cross-origin permissions, or upload a file.');
    throw error;
  } finally { clearTimeout(timer); }
}

function decodeBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob), image = new Image();
    let timer;
    const cleanup = () => {
      clearTimeout(timer); image.onload = null; image.onerror = null;
      URL.revokeObjectURL(url);
    };
    image.decoding = 'async';
    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => { cleanup(); image.src = ''; reject(new Error('This image is damaged or uses an unsupported format. Try PNG, JPEG or WebP.')); };
    timer = setTimeout(() => { cleanup(); image.src = ''; reject(new Error('Image decoding timed out. Try a smaller image.')); }, DECODE_TIMEOUT);
    image.src = url;
  });
}

export async function createImageSource(fileOrURL) {
  let blob, name;
  if (typeof Blob !== 'undefined' && fileOrURL instanceof Blob) {
    blob = fileOrURL; name = fileOrURL.name || 'Uploaded image';
  } else if (typeof fileOrURL === 'string' || fileOrURL instanceof URL) {
    let url;
    try { url = new URL(fileOrURL, globalThis.location?.href); }
    catch { throw new Error('Choose a valid image file or URL.'); }
    if (!['http:', 'https:', 'blob:', 'data:'].includes(url.protocol)) {
      throw new Error('Use an HTTP image URL or upload a local image file.');
    }
    try { name = decodeURIComponent(url.pathname.split('/').pop()) || 'Remote image'; }
    catch { name = 'Remote image'; }
    if (url.protocol === 'data:' || url.protocol === 'blob:') name = 'Imported image';
    blob = await fetchImageBlob(url);
  } else throw new TypeError('Choose an image File, Blob or URL.');
  if (!blob.size) throw new Error('The selected image is empty.');
  if (blob.size > MAX_FILE_BYTES) throw new Error('Choose an image smaller than 32 MB.');
  if (blob.type && !blob.type.startsWith('image/') && blob.type !== 'application/octet-stream') {
    throw new Error('The selected resource is not an image. Choose PNG, JPEG, WebP, AVIF or SVG.');
  }
  const image = await decodeBlob(blob);
  let original;
  try {
    const width = image.naturalWidth, height = image.naturalHeight;
    if (width * height > 100000000 || Math.max(width, height) > 32768) {
      throw new Error('This image is too large to decode safely. Resize it below 100 megapixels first.');
    }
    const size = boundedDimensions(width, height, runtimeSourceSizeLimit());
    const target = makeCanvas(size.width, size.height);
    original = target.canvas;
    target.context.imageSmoothingEnabled = true;
    target.context.imageSmoothingQuality = 'high';
    target.context.drawImage(image, 0, 0, size.width, size.height);
    return sourceFromCanvas(original, String(name).slice(0, 160));
  } catch (error) {
    if (original) { original.width = 1; original.height = 1; }
    if (error.name === 'SecurityError') throw new Error('The browser cannot read this image. Upload a local PNG or JPEG copy.');
    throw error;
  } finally { image.src = ''; }
}

export function createDemoSource() {
  const {canvas, context: ctx} = makeCanvas(1440, 1080);
  const background = ctx.createLinearGradient(0, 0, 1440, 1080);
  background.addColorStop(0, '#071320'); background.addColorStop(0.5, '#301449'); background.addColorStop(1, '#061c27');
  ctx.fillStyle = background; ctx.fillRect(0, 0, 1440, 1080);
  // Seeded stars and a hand-drawn mathematical jewel: no external assets/randomness.
  let seed = 0x41544852;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 700; i++) {
    const x = random() * 1440, y = random() * 1080, radius = 0.4 + random() * 1.8;
    ctx.fillStyle = `rgba(155,225,241,${0.12 + random() * 0.5})`;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
  }
  ctx.save(); ctx.translate(720, 540);
  for (let ring = 9; ring >= 0; ring--) {
    const radius = 48 + ring * 48, points = 12 + ring * 4;
    ctx.save(); ctx.rotate(ring * 0.103);
    for (let i = 0; i < points; i++) {
      const a = i / points * Math.PI * 2, b = (i + 1) / points * Math.PI * 2;
      const hue = (175 + ring * 23 + i * 7) % 360;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * radius, Math.sin(a) * radius);
      ctx.lineTo(Math.cos((a + b) / 2) * (radius - 78), Math.sin((a + b) / 2) * (radius - 78));
      ctx.lineTo(Math.cos(b) * radius, Math.sin(b) * radius);
      ctx.lineTo(Math.cos((a + b) / 2) * (radius + 18), Math.sin((a + b) / 2) * (radius + 18));
      ctx.closePath();
      ctx.fillStyle = `hsla(${hue},72%,${20 + ring * 2.5}%,0.82)`; ctx.fill();
      ctx.lineWidth = 1.25; ctx.strokeStyle = `hsla(${hue},95%,76%,0.72)`; ctx.stroke();
    }
    ctx.restore();
  }
  for (let i = 0; i < 36; i++) {
    ctx.save(); ctx.rotate(i * Math.PI / 18);
    ctx.beginPath(); ctx.moveTo(55, 0); ctx.bezierCurveTo(190, -85, 310, 95, 470, 0);
    ctx.strokeStyle = i % 2 ? '#f7b97599' : '#67eeeabb'; ctx.lineWidth = 1.4; ctx.stroke(); ctx.restore();
  }
  // An eye-like central motif gives the anchor a legible feature to join.
  const eye = ctx.createRadialGradient(0, 0, 8, 0, 0, 94);
  eye.addColorStop(0, '#071522'); eye.addColorStop(0.25, '#09091e');
  eye.addColorStop(0.3, '#ffe0a8'); eye.addColorStop(0.48, '#a17be8');
  eye.addColorStop(0.78, '#35d7c6'); eye.addColorStop(1, '#102b48');
  ctx.fillStyle = eye; ctx.beginPath(); ctx.ellipse(0, 0, 118, 70, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ffe5b2'; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.fillStyle = '#e8ffff'; ctx.beginPath(); ctx.arc(-20, -17, 6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  const source = sourceFromCanvas(canvas, 'Aether jewel · procedural');
  source.anchor = {x: 0.5, y: 0.5};
  return source;
}

export function mountImageEditor(canvas, onChange = () => {}) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) throw new Error('The source editor needs a Canvas 2D element.');
  let source = null, scene = {anchor: {x: 0.5, y: 0.5}, zoom: 1, rotation: 0, pattern: 'radial', folds: 6};
  let rect = {x: 0, y: 0, width: 0, height: 0}, activePointer = null, destroyed = false;
  let viewport = {width: 0, height: 0}, renderKey = '';
  const previousTouchAction = canvas.style.touchAction, previousCursor = canvas.style.cursor;
  const previousTabIndex = canvas.getAttribute('tabindex'), previousLabel = canvas.getAttribute('aria-label');
  const previousTitle = canvas.getAttribute('title');
  canvas.style.touchAction = 'none'; canvas.style.cursor = 'crosshair';
  if (previousTabIndex === null) canvas.tabIndex = 0;
  if (previousLabel === null) canvas.setAttribute('aria-label', 'Original image. Drag to choose the mirror anchor. Scroll to change crop size. Arrow keys move anchor; plus and minus zoom.');
  if (previousTitle === null) canvas.title = 'Original source. Crosshair: mirror seam anchor. Dashed area: base motif before gesture warp; beyond image edges, pixels mirror back. Rotation turns the layout, not the source.';

  const render = nextScene => {
    if (destroyed) return;
    if (nextScene) scene = {...scene, ...nextScene, anchor: normalizedAnchor(nextScene.anchor ?? scene.anchor),
      zoom: clamp(finite(nextScene.zoom, scene.zoom), MIN_CROP_ZOOM, MAX_CROP_ZOOM)};
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(1, bounds.width || canvas.clientWidth || 320);
    const height = Math.max(1, bounds.height || canvas.clientHeight || 240);
    const ratio = Math.min(2, finite(globalThis.devicePixelRatio, 1));
    const pixelWidth = Math.max(1, Math.round(width * ratio)), pixelHeight = Math.max(1, Math.round(height * ratio));
    const key = [width, height, ratio, scene.anchor.x, scene.anchor.y, scene.zoom, scene.pattern, scene.folds].join('|');
    if (key === renderKey && canvas.width === pixelWidth && canvas.height === pixelHeight) return;
    renderKey = key; viewport = {width, height};
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    ctx.fillStyle = '#0b1018'; ctx.fillRect(0, 0, width, height);
    if (!source) {
      ctx.fillStyle = '#a8b5ca'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Upload an image to choose a mirror anchor', width / 2, height / 2); return;
    }
    rect = fitImageRect(source.width, source.height, width, height, 10);
    ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.width, rect.height); ctx.clip();
    for (let y = rect.y; y < rect.y + rect.height; y += 10) for (let x = rect.x; x < rect.x + rect.width; x += 10) {
      const dark = (Math.floor((x - rect.x) / 10) + Math.floor((y - rect.y) / 10)) % 2;
      ctx.fillStyle = dark ? '#27313d' : '#35414e'; ctx.fillRect(x, y, 10, 10);
    }
    ctx.drawImage(source.originalCanvas || source.canvas, rect.x, rect.y, rect.width, rect.height);
    const corners = cropWindow(source.width, source.height, scene.anchor, scene.zoom, scene.pattern, scene.folds).map(p => imageToPoint(p, rect));
    ctx.beginPath(); corners.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath();
    ctx.lineWidth = 3; ctx.strokeStyle = '#07131ccc'; ctx.stroke();
    ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = '#72f8e5'; ctx.stroke(); ctx.setLineDash([]);
    const center = imageToPoint(scene.anchor, rect);
    ctx.beginPath(); ctx.moveTo(center.x - 18, center.y); ctx.lineTo(center.x + 18, center.y);
    ctx.moveTo(center.x, center.y - 18); ctx.lineTo(center.x, center.y + 18);
    ctx.lineWidth = 4; ctx.strokeStyle = '#07131c'; ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff1bc'; ctx.stroke();
    ctx.beginPath(); ctx.arc(center.x, center.y, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#9aaec64d'; ctx.lineWidth = 1; ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  };
  const emit = patch => {
    scene = {...scene, ...patch}; renderKey = ''; render(); onChange(patch);
  };
  const locate = event => {
    const bounds = canvas.getBoundingClientRect();
    return {x: (event.clientX - bounds.left) * viewport.width / Math.max(bounds.width, 1),
      y: (event.clientY - bounds.top) * viewport.height / Math.max(bounds.height, 1)};
  };
  const setAnchor = (event, outside) => {
    const point = locate(event), anchor = pointToImage(point.x, point.y, rect, outside);
    if (anchor) emit({anchor});
    return Boolean(anchor);
  };
  const down = event => {
    if (!source || activePointer !== null || event.button !== 0) return;
    render();
    if (!setAnchor(event, false)) return;
    event.preventDefault(); activePointer = event.pointerId;
    canvas.focus({preventScroll: true});
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Detached canvas. */ }
  };
  const move = event => {
    if (event.pointerId !== activePointer) return;
    event.preventDefault(); setAnchor(event, true);
  };
  const up = event => {
    if (event.pointerId !== activePointer) return;
    activePointer = null;
    try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
  };
  const wheel = event => {
    if (!source) return;
    const point = locate(event);
    if (!pointToImage(point.x, point.y, rect)) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1);
    const zoom = clamp(finite(scene.zoom, 1) * Math.exp(-clamp(delta, -300, 300) * 0.002), MIN_CROP_ZOOM, MAX_CROP_ZOOM);
    emit({zoom});
  };
  const keydown = event => {
    if (!source || event.ctrlKey || event.metaKey || event.altKey) return;
    const step = event.shiftKey ? 0.025 : 0.005;
    const offsets = {ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]};
    if (offsets[event.key]) {
      const [x, y] = offsets[event.key]; emit({anchor: normalizedAnchor({x: scene.anchor.x + x, y: scene.anchor.y + y})});
    } else if (['+', '=', '-', '_'].includes(event.key)) {
      emit({zoom: clamp(scene.zoom * (event.key === '-' || event.key === '_' ? 1 / 1.1 : 1.1), MIN_CROP_ZOOM, MAX_CROP_ZOOM)});
    } else return;
    event.preventDefault(); event.stopPropagation();
  };
  const listeners = {pointerdown: down, pointermove: move, pointerup: up, pointercancel: up, lostpointercapture: up, wheel, keydown};
  for (const [name, handler] of Object.entries(listeners)) canvas.addEventListener(name, handler, {passive: false});
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => render()) : null;
  observer?.observe(canvas);
  render();
  return {
    setSource(nextSource) {
      if (destroyed) return;
      if (activePointer !== null) up({pointerId: activePointer});
      source = nextSource; scene = {...scene, anchor: normalizedAnchor(source?.anchor)};
      renderKey = ''; render();
    },
    render,
    destroy() {
      if (destroyed) return;
      if (activePointer !== null) up({pointerId: activePointer});
      destroyed = true; observer?.disconnect();
      for (const [name, handler] of Object.entries(listeners)) canvas.removeEventListener(name, handler);
      canvas.style.touchAction = previousTouchAction; canvas.style.cursor = previousCursor;
      if (previousTabIndex === null) canvas.removeAttribute('tabindex'); else canvas.setAttribute('tabindex', previousTabIndex);
      if (previousLabel === null) canvas.removeAttribute('aria-label'); else canvas.setAttribute('aria-label', previousLabel);
      if (previousTitle === null) canvas.removeAttribute('title'); else canvas.setAttribute('title', previousTitle);
      source = null;
    },
  };
}

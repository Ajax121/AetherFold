export const PRESETS = Object.freeze({
  cyber: { name: 'Cyber Shamanic', pattern: 'radial', folds: 6, morph: 0.3, warp: 0.55,
    paletteA: [0.12, 0.83, 0.88], paletteB: [0.82, 0.25, 0.94] },
  golden: { name: 'Golden Tesseract', pattern: 'diamond', folds: 8, morph: 0.22, warp: 0.4,
    paletteA: [1, 0.69, 0.25], paletteB: [0.8, 0.3, 0.08] },
  void: { name: 'Brutalist Void', pattern: 'triangle', folds: 4, morph: 0.5, warp: 0.3,
    paletteA: [0.7, 0.76, 0.82], paletteB: [0.25, 0.3, 0.36] },
});

export const DEFAULT_SCENE = Object.freeze({
  preset: 'void', pattern: 'triangle', folds: 4, zoom: 0.25,
  rotation: 0.7853981633974483,
  anchor: Object.freeze({ x: 0.5081025233130377, y: 0.4826755275974026 }),
  morph: 0.5, warp: 0.3, imageMix: 1, quality: 'high', guides: false,
  backgroundRemoval: 0, paused: false, volume: 0.8, muted: false,
  tuning: 'pentatonic', paletteA: Object.freeze([0.7, 0.76, 0.82]),
  paletteB: Object.freeze([0.25, 0.3, 0.36]),
});

export const SAMPLE_IMAGES = [
  { name: 'Generated rosette', url: 'demo' },
  { name: 'Eyes / original reference', url: './images/Screenshot.png' },
  { name: 'Vision study 01', url: './images/il_1588xN.2149403506_tv42.png' },
  { name: 'Vision study 02', url: './images/il_1588xN.4864111991_td17.png' },
  { name: 'Vision study 03', url: './images/il_1588xN.8476925782_aaau.png' },
  { name: 'Vision study 04', url: './images/il_1588xN.8644117008_cbg7.png' },
  { name: 'Vision study 05', url: './images/il_765x956.1749903615_lrug.png' },
  { name: 'Vision study 06', url: './images/il_765x956.5036136845_6dq7.png' },
  { name: 'Vision study 07', url: './images/il_765x956.5116193169_n62n.png' },
  { name: 'Vision study 08', url: './images/il_765x956.5127148965_nd13.png' },
  { name: 'Vision study 09', url: './images/il_765x956.6114736989_npwx.png' },
  { name: 'Vision study 10', url: './images/il_765x956.8448243588_40k2.png' },
  { name: 'Photo study 01', url: './images/test_img/images%20(2).jpeg' },
  { name: 'Photo study 02', url: './images/test_img/images%20(8).jpeg' },
  { name: 'Photo study 03', url: './images/test_img/images%20(9).jpeg' },
  { name: 'Photo study 04', url: './images/test_img/images%20(10).jpeg' },
];

export const DEFAULT_SOURCE = './images/il_1588xN.4864111991_td17.png';

const enums = {
  preset: Object.keys(PRESETS), pattern: ['mirror', 'square', 'diamond', 'triangle', 'radial'],
  quality: ['low', 'balanced', 'high'], tuning: ['just', 'pentatonic', 'microtonal'],
};
const ranges = {
  folds: [2, 32], zoom: [0.25, 6], rotation: [-Math.PI, Math.PI],
  morph: [0, 1], warp: [0, 1], imageMix: [0, 1], volume: [0, 0.8], backgroundRemoval: [0, 1],
};
const bounded = (value, min, max, fallback) => Number.isFinite(value)
  ? Math.min(max, Math.max(min, value)) : fallback;

/** Only known, finite values cross the saved-scene / live engine boundary. */
export function normalizeScene(raw = {}, base = DEFAULT_SCENE) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const scene = { ...base, anchor: { ...base.anchor }, paletteA: [...base.paletteA], paletteB: [...base.paletteB] };
  for (const [key, values] of Object.entries(enums)) {
    if (values.includes(input[key])) scene[key] = input[key];
  }
  for (const [key, [min, max]] of Object.entries(ranges)) {
    scene[key] = bounded(input[key], min, max, scene[key]);
  }
  scene.folds = Math.round(scene.folds);
  for (const key of ['guides', 'paused', 'muted']) {
    if (typeof input[key] === 'boolean') scene[key] = input[key];
  }
  for (const key of ['x', 'y']) {
    scene.anchor[key] = bounded(input.anchor?.[key], 0, 1, scene.anchor[key]);
  }
  for (const key of ['paletteA', 'paletteB']) {
    if (Array.isArray(input[key]) && input[key].length === 3) {
      scene[key] = input[key].map((v, i) => bounded(v, 0, 1, scene[key][i]));
    }
  }
  return scene;
}

export function applyPreset(scene, name) {
  return PRESETS[name] ? normalizeScene({ ...PRESETS[name], preset: name }, scene) : normalizeScene(scene);
}

export function parseSceneDocument(text) {
  const data = JSON.parse(text);
  if (!data || data.version !== 1 || !data.scene || typeof data.scene !== 'object') {
    throw new Error('This is not an AetherFold scene (version 1).');
  }
  let image = null;
  if (data.image != null) {
    if (typeof data.image.data !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[a-z\d+/=\r\n]+$/i.test(data.image.data)) {
      throw new Error('Scene images must be embedded PNG, JPEG, or WebP data.');
    }
    if (data.image.data.length > 32 * 1024 * 1024) throw new Error('Embedded image exceeds 32 MB.');
    image = { data: data.image.data, name: String(data.image.name || 'Scene image').slice(0, 200) };
  }
  return { scene: normalizeScene(data.scene), image };
}

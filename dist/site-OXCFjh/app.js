import { Renderer } from './renderer.js';
import { createImageSource, createDemoSource, mountImageEditor } from './image-source.js';
import { InputController } from './input.js';
import { AudioEngine } from './audio.js';
import {
  DEFAULT_SCENE, DEFAULT_SOURCE, SAMPLE_IMAGES, normalizeScene, applyPreset,
  parseSceneDocument,
} from './state.js';

const $ = (id) => document.getElementById(id);
const storageKey = 'aetherfold.scene.v1';
let scene = normalizeScene(DEFAULT_SCENE);
try {
  const stored = JSON.parse(localStorage.getItem(storageKey));
  if (stored?.version === 1) scene = normalizeScene({ ...stored.scene, paused: false });
} catch { /* Storage can be unavailable in private browsing. */ }

let launched = false;
let source = null;
let loadSequence = 0;
let toastTimer;
let saveTimer;
let lastInteraction = { x: 0.5, y: 0.5, energy: 0, pinch: 0, depth: 0.5, active: false, tracked: false, mode: 'pointer', timestamp: 0 };
let fps = 0;
let renderer = null;
let renderFailed = false;
let displayedSoundOn = false;
const audio = new AudioEngine();
const appChrome = document.querySelector('.app-chrome');
appChrome.inert = true;
$('stage').tabIndex = -1;
$('launch-sound').focus();
$('launch-overlay').addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const first = $('launch-sound'), last = $('launch-silent');
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

function toast(message, persistent = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  $('toast').hidden = false;
  if (!persistent) toastTimer = setTimeout(() => {
    $('toast').classList.remove('visible');
    $('toast').hidden = true;
  }, 6000);
}

try {
  renderer = new Renderer($('stage'), {
    onError(error) { renderFailed = true; toast(`Visual engine: ${error.message || error}`, true); },
    onStatus(message) {
      toast(message);
      if (/ready|recover|restor|using simple/i.test(message)) renderFailed = false;
    },
  });
} catch (error) {
  renderFailed = true;
  toast(`The visual engine could not start. Enable WebGL2 or try another browser. ${error.message}`, true);
}

const input = new InputController($('stage'), {
  onStatus(status) {
    $('input-status').textContent = status.mode === 'camera' && status.tracked ? 'Hand tracked' : 'Pointer';
    $('camera-toggle').setAttribute('aria-pressed', String(status.mode === 'camera'));
    $('camera-toggle').textContent = status.mode === 'camera' ? 'Use pointer' : 'Enable camera';
    if (status.message) toast(status.message);
  },
});

const editor = mountImageEditor($('source-preview'), (patch) => changeScene(patch));
const numberControls = {
  folds: 'folds', zoom: 'zoom', rotation: 'rotation', morph: 'morph', warp: 'warp',
  'image-mix': 'imageMix', volume: 'volume', 'background-removal': 'backgroundRemoval',
};

function syncAudioControls() {
  displayedSoundOn = audio.started && !scene.muted && !document.hidden;
  const label = displayedSoundOn ? 'Mute' : 'Enable sound';
  if ($('mute-toggle').textContent !== label) $('mute-toggle').textContent = label;
  $('mute-toggle').setAttribute('aria-pressed', String(!displayedSoundOn));
  const status = displayedSoundOn ? `${scene.tuning} · sound on` : 'Sound off';
  if ($('audio-status').textContent !== status) $('audio-status').textContent = status;
}

function syncControls() {
  for (const [id, key] of Object.entries(numberControls)) {
    const value = key === 'rotation' ? scene[key] * 180 / Math.PI : scene[key];
    $(id).value = String(value);
    const label = document.querySelector(`[data-value="${id}"]`);
    if (label) label.textContent = id === 'folds' ? String(value)
      : id === 'rotation' ? `${Math.round(value)}°`
        : id === 'zoom' ? `${value.toFixed(2)}×` : `${Math.round(value * 100)}%`;
  }
  for (const id of ['preset', 'pattern', 'quality', 'tuning']) $(id).value = scene[id];
  $('folds').disabled = scene.pattern === 'mirror';
  $('folds').title = scene.pattern === 'mirror' ? 'Connected mirror uses two fixed reflection axes.' : '';
  $('image-mix').disabled = scene.morph === 0;
  $('image-mix').title = scene.morph === 0 ? 'Raise Geometry morph to blend the image with the spatial palette.' : '';
  $('guides').checked = scene.guides;
  $('pause-toggle').textContent = scene.paused ? 'Resume' : 'Pause';
  $('pause-toggle').setAttribute('aria-pressed', String(scene.paused));
  syncAudioControls();
  document.documentElement.dataset.preset = scene.preset;
  editor.render(scene);
}

function rememberScene() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, scene })); } catch { /* Optional persistence. */ }
  }, 250);
}

function changeScene(patch) {
  const previousRemoval = scene.backgroundRemoval;
  scene = normalizeScene(patch, scene);
  if (source && scene.backgroundRemoval !== previousRemoval) {
    source.setBackgroundRemoval(scene.backgroundRemoval);
    renderer?.setSource(source);
  }
  audio.setVolume(scene.volume);
  audio.setMuted(scene.muted || document.hidden);
  audio.setTuning(scene.tuning);
  audio.setPreset(scene.preset);
  syncControls();
  rememberScene();
}

async function loadImage(value, options = {}) {
  const sequence = ++loadSequence;
  $('image-name').textContent = 'Preparing image…';
  let next;
  try {
    next = value === 'demo' ? createDemoSource() : await createImageSource(value);
    if (sequence !== loadSequence) { next.dispose(); return false; }
    if (options.name) next.name = options.name;
    const nextScene = options.scene ? normalizeScene(options.scene) : normalizeScene({ anchor: next.anchor }, scene);
    next.setBackgroundRemoval(nextScene.backgroundRemoval);
    renderer?.setSource(next);
    const previous = source;
    source = next;
    scene = nextScene;
    editor.setSource(source);
    previous?.dispose();
    $('image-name').textContent = `${source.name} · ${source.width} × ${source.height}`;
    changeScene({});
    return true;
  } catch (error) {
    if (next && next !== source) next.dispose();
    if (sequence === loadSequence) {
      $('image-name').textContent = source?.name || 'No image loaded';
      toast(`Could not load image: ${error.message}`);
    }
    return false;
  }
}

for (const sample of SAMPLE_IMAGES) $('sample-image').add(new Option(sample.name, sample.url));
$('sample-image').value = DEFAULT_SOURCE;
$('sample-image').addEventListener('change', () => loadImage($('sample-image').value));
$('image-upload').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (file && await loadImage(file)) $('sample-image').selectedIndex = -1;
  event.target.value = '';
});

for (const [id, key] of Object.entries(numberControls)) {
  $(id).addEventListener('input', () => changeScene({ [key]: Number($(id).value) * (key === 'rotation' ? Math.PI / 180 : 1) }));
}
for (const id of ['pattern', 'quality', 'tuning']) $(id).addEventListener('change', () => changeScene({ [id]: $(id).value }));
$('preset').addEventListener('change', () => changeScene(applyPreset(scene, $('preset').value)));
$('guides').addEventListener('change', () => changeScene({ guides: $('guides').checked }));
$('pause-toggle').addEventListener('click', () => changeScene({ paused: !scene.paused }));
$('reset-scene').addEventListener('click', async () => {
  if (await loadImage(DEFAULT_SOURCE, { scene: DEFAULT_SCENE })) {
    $('sample-image').value = DEFAULT_SOURCE;
    toast('Default Vision Study 02 composition restored.');
  }
});

async function launch(withSound) {
  // Call start before any unrelated await so the browser sees the click gesture.
  const audioAttempt = withSound ? audio.start() : Promise.resolve(false);
  launched = true;
  $('launch-overlay').hidden = true;
  appChrome.inert = false;
  $('stage').tabIndex = 0;
  $('stage').focus({ preventScroll: true });
  let enabled = false;
  try { enabled = await audioAttempt; } catch (error) { toast(`Sound unavailable: ${error.message}. Visuals are ready.`); }
  changeScene({ muted: !enabled });
  if (withSound && !enabled) toast('Audio could not start. You can continue silently and retry Enable sound.');
}
$('launch-sound').addEventListener('click', () => launch(true));
$('launch-silent').addEventListener('click', () => launch(false));
$('mute-toggle').addEventListener('click', async () => {
  // Honor the action the displayed button promised, even if the OS suspended
  // the context between the last UI refresh and this click.
  if (displayedSoundOn) { changeScene({ muted: true }); return; }
  if (!audio.started) {
    try {
      if (await audio.start()) changeScene({ muted: false });
      else toast('Audio is unavailable. Visuals remain active.');
    } catch (error) { toast(`Audio could not start: ${error.message}`); }
  } else changeScene({ muted: false });
});
$('camera-toggle').addEventListener('click', async () => {
  const button = $('camera-toggle');
  const requested = button.getAttribute('aria-pressed') === 'true' ? 'pointer' : 'camera';
  button.disabled = true;
  button.textContent = requested === 'camera' ? 'Starting camera…' : 'Stopping camera…';
  try {
    const enabled = await input.setMode(requested);
    button.setAttribute('aria-pressed', String(requested === 'camera' && enabled));
  } catch (error) { toast(`Camera unavailable: ${error.message}`); }
  finally {
    button.disabled = false;
    button.textContent = button.getAttribute('aria-pressed') === 'true' ? 'Use pointer' : 'Enable camera';
  }
});
$('fullscreen-toggle').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else toast('Fullscreen is not available in this browser.');
  } catch (error) { toast(`Fullscreen unavailable: ${error.message}`); }
});
document.addEventListener('fullscreenchange', () => {
  const label = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  $('fullscreen-toggle').setAttribute('aria-label', label);
  $('fullscreen-toggle').setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
  $('fullscreen-toggle').title = label;
});

$('save-scene').addEventListener('click', () => {
  try {
    const imageCanvas = source?.originalCanvas || source?.canvas;
    const document = { version: 1, scene: normalizeScene(scene), image: imageCanvas ? {
      name: source.name, data: imageCanvas.toDataURL('image/png'),
    } : null };
    const url = URL.createObjectURL(new Blob([JSON.stringify(document)], { type: 'application/json' }));
    const link = window.document.createElement('a');
    link.href = url;
    link.download = 'aetherfold-scene.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Scene saved with its source image. Load it to restore this composition.');
  } catch (error) { toast(`Scene could not be saved: ${error.message}`); }
});
$('load-scene').addEventListener('click', () => $('scene-upload').click());
$('scene-upload').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 34 * 1024 * 1024) throw new Error('Scene file exceeds 34 MB.');
    const saved = parseSceneDocument(await file.text());
    if (saved.image) {
      if (!await loadImage(saved.image.data, { scene: saved.scene, name: saved.image.name })) return;
      $('sample-image').selectedIndex = -1;
    } else changeScene(saved.scene);
    toast('Scene restored.');
  } catch (error) { toast(`Scene could not be loaded: ${error.message}`); }
});

document.addEventListener('keydown', (event) => {
  if (!launched || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey
    || event.target.id === 'source-preview' || /INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName)) return;
  if (event.code === 'Space') { event.preventDefault(); changeScene({ paused: !scene.paused }); }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    if (scene.pattern === 'mirror') toast('Connected mirror has fixed axes. Choose a lattice or radial pattern to change the fold count.');
    else changeScene({ folds: scene.folds + (event.key === 'ArrowUp' ? 1 : -1) });
  }
  if (event.key.toLowerCase() === 'm') $('mute-toggle').click();
  if (event.key.toLowerCase() === 'r') $('reset-scene').click();
});

await loadImage(DEFAULT_SOURCE, { scene });
let lastFrame = performance.now();
let lastAnimationFrame = lastFrame;
let frameBudget = 0;
const frameInterval = 1000 / 60;
let elapsed = 0;
let fpsStart = lastFrame;
let frames = 0;
let animationFrame;
function frame(now) {
  animationFrame = requestAnimationFrame(frame);
  frameBudget += now - lastAnimationFrame;
  lastAnimationFrame = now;
  if (frameBudget < frameInterval - 0.1) return;
  frameBudget = Math.max(0, frameBudget % frameInterval);
  const delta = now - lastFrame;
  const dt = Math.min(delta / 1000, 0.1);
  lastFrame = now;
  const interaction = input.update(dt, now / 1000);
  if (!scene.paused) {
    elapsed += dt;
    lastInteraction = launched ? interaction : { ...interaction, energy: 0, pinch: 0, active: false };
  }
  const soundInteraction = launched && !scene.paused ? lastInteraction : { ...lastInteraction, active: false, energy: 0 };
  audio.update(soundInteraction, document.hidden ? { ...scene, muted: true } : scene, dt);
  if (renderer && !renderFailed && source) {
    try { renderer.render({ time: elapsed, dt, scene, interaction: lastInteraction }); }
    catch (error) { renderFailed = true; toast(`Rendering stopped: ${error.message}`, true); }
  }
  frames++;
  if (now - fpsStart >= 600) {
    syncAudioControls();
    fps = Math.round(frames * 1000 / (now - fpsStart));
    $('fps').textContent = String(fps);
    frames = 0;
    fpsStart = now;
  }
}
animationFrame = requestAnimationFrame(frame);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) audio.setMuted(true);
  else {
    lastFrame = lastAnimationFrame = performance.now();
    frameBudget = 0;
    audio.setMuted(scene.muted);
  }
  syncAudioControls();
});
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  cancelAnimationFrame(animationFrame);
  input.dispose(); audio.dispose(); renderer?.dispose(); editor.destroy(); source?.dispose();
});

// Read-only diagnostics for local integration checks and performance tuning.
globalThis.aetherfold = Object.freeze({
  get scene() { return normalizeScene(scene); },
  get interaction() { return { ...lastInteraction }; },
  get source() { return source ? { name: source.name, width: source.width, height: source.height } : null; },
  get status() { return { launched, fps, renderFailed, audioStarted: audio.started, audioMuted: audio.muted, inputMode: lastInteraction.mode }; },
});

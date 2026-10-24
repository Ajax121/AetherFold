/**
 * AetherFold ambient instrument. Importing/constructing this module is silent.
 * Call start() directly from a user gesture; update() never creates or resumes
 * an AudioContext. Coordinates match docs/INTEGRATION.md (top-left origin).
 */

export const TUNINGS = Object.freeze({
  pentatonic: Object.freeze({
    label: 'Pentatonic',
    ratios: Object.freeze([1, 9 / 8, 5 / 4, 3 / 2, 5 / 3]),
    chord: Object.freeze([0, 1, 2, 4]),
  }),
  just: Object.freeze({
    label: 'Just intonation',
    ratios: Object.freeze([1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 15 / 8]),
    chord: Object.freeze([0, 2, 4, 6]),
  }),
  microtonal: Object.freeze({
    // Includes the 7th, 11th and 13th harmonics; never MIDI-rounded to 12-TET.
    label: 'Harmonic microtonal',
    ratios: Object.freeze([1, 16 / 15, 9 / 8, 7 / 6, 5 / 4, 11 / 8, 3 / 2, 13 / 8, 7 / 4, 15 / 8]),
    chord: Object.freeze([0, 4, 6, 8]),
  }),
});

export const AUDIO_PRESETS = Object.freeze({
  cyber: Object.freeze({ rootHz: 110, attack: 0.65, release: 2.2, brightness: 1, harmonic: 0.18, space: 0.45, delay: 0.375 }),
  golden: Object.freeze({ rootHz: 130.8127826503, attack: 1.05, release: 2.6, brightness: 0.8, harmonic: 0.12, space: 0.65, delay: 0.5625 }),
  void: Object.freeze({ rootHz: 73.4161919794, attack: 1.4, release: 2.8, brightness: 0.5, harmonic: 0.08, space: 0.9, delay: 0.75 }),
});

export const AUDIO_LIMITS = Object.freeze({
  maxVoices: 12, // Four tones per chord, including all fading tails.
  quantum: 0.75, // 80 BPM; changes are at most once every two beats.
  minTriggerInterval: 1.5,
  maxFeedback: 0.62,
  maxMasterGain: 0.7,
});

export const MOBILE_AUDIO_PROFILE = Object.freeze({
  maxVoices: 8,
  impulseSeconds: 1.25,
  wetGain: 0.36,
  delaySend: 0.68,
  reverbSend: 0.62,
  maxFeedback: 0.46,
});
export const DESKTOP_AUDIO_PROFILE = Object.freeze({
  maxVoices: AUDIO_LIMITS.maxVoices,
  impulseSeconds: 2.6,
  wetGain: 0.55,
  delaySend: 1,
  reverbSend: 1,
  maxFeedback: AUDIO_LIMITS.maxFeedback,
});

/** Keep phone audio robust when the renderer and browser are under load. */
export function audioProfile({ coarsePointer = false, width = Infinity } = {}) {
  return coarsePointer && Number.isFinite(width) && width <= 680
    ? MOBILE_AUDIO_PROFILE : DESKTOP_AUDIO_PROFILE;
}

function runtimeAudioProfile() {
  return audioProfile({
    coarsePointer: Boolean(globalThis.matchMedia?.('(pointer: coarse)')?.matches),
    width: globalThis.innerWidth,
  });
}

const DEFAULT_SETTINGS = Object.freeze({ preset: 'cyber', tuning: 'just', volume: 0.25, muted: false });
const DEFAULT_INTERACTION = Object.freeze({ x: 0.5, y: 0.5, energy: 0, pinch: 0, depth: 0.5, active: false });
const own = (table, name) => typeof name === 'string' && Object.hasOwn(table, name);
const bounded = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(min, Math.min(max, value)) : fallback;
const record = (value) => value && typeof value === 'object' ? value : {};

export function sanitizeInteraction(value) {
  const input = record(value);
  return {
    x: bounded(input.x, 0, 1, 0.5),
    y: bounded(input.y, 0, 1, 0.5),
    energy: bounded(input.energy, 0, 1, 0),
    pinch: bounded(input.pinch, 0, 1, 0),
    depth: bounded(input.depth, 0, 1, 0.5),
    active: input.active === true,
  };
}

export function sanitizeAudioSettings(value, previous = DEFAULT_SETTINGS) {
  const input = record(value);
  const prior = record(previous);
  const preset = own(AUDIO_PRESETS, prior.preset) ? prior.preset : DEFAULT_SETTINGS.preset;
  const tuning = own(TUNINGS, prior.tuning) ? prior.tuning : DEFAULT_SETTINGS.tuning;
  return {
    preset: own(AUDIO_PRESETS, input.preset) ? input.preset : preset,
    tuning: own(TUNINGS, input.tuning) ? input.tuning : tuning,
    volume: bounded(input.volume, 0, 1, bounded(prior.volume, 0, 1, DEFAULT_SETTINGS.volume)),
    muted: typeof input.muted === 'boolean' ? input.muted : prior.muted === true,
  };
}

/** Scale degrees wrap through exact octave ratios, including negative degrees. */
export function frequencyForDegree(tuning, degree = 0, rootHz = 110, register = 0) {
  const table = TUNINGS[own(TUNINGS, tuning) ? tuning : 'just'].ratios;
  const step = Math.trunc(bounded(degree, -64, 64, 0));
  const octave = Math.floor(step / table.length) + Math.trunc(bounded(register, -3, 3, 0));
  const index = ((step % table.length) + table.length) % table.length;
  return bounded(rootHz, 20, 440, 110) * table[index] * 2 ** octave;
}

export function chordFrequencies({ tuning = 'just', rootHz = 110, degree = 0, register = 0 } = {}) {
  const name = own(TUNINGS, tuning) ? tuning : 'just';
  const base = Math.trunc(bounded(degree, -32, 32, 0));
  return TUNINGS[name].chord.map((interval) => frequencyForDegree(name, base + interval, rootHz, register));
}

/** Nine vertical bands: three chord roots in each of three registers. */
export function selectChordBand(y, previous = null) {
  const height = 1 - bounded(y, 0, 1, 0.5);
  if (Number.isInteger(previous) && previous >= 0 && previous <= 8
      && height >= previous / 9 - 0.018 && height <= (previous + 1) / 9 + 0.018) {
    return previous; // Hysteresis keeps hand jitter from alternating chords.
  }
  return Math.min(8, Math.floor(height * 9));
}

export function mapInteraction(value, presetName = 'cyber') {
  const input = sanitizeInteraction(value);
  const preset = AUDIO_PRESETS[own(AUDIO_PRESETS, presetName) ? presetName : 'cyber'];
  return {
    ...input,
    cutoff: bounded(240 * 26 ** input.x * (1 + input.energy * 0.8) * preset.brightness, 120, 12000, 1200),
    pan: (input.x * 2 - 1) * 0.8,
    attack: Math.max(0.12, preset.attack * (1 - input.energy * 0.72)),
    peak: 0.13 + input.energy * 0.04,
    harmonic: preset.harmonic + input.energy * 0.1,
    reverb: 0.12 + preset.space * 0.16 + input.pinch * 0.3,
    delaySend: 0.1 + input.pinch * 0.24,
    feedback: Math.min(AUDIO_LIMITS.maxFeedback, 0.18 + preset.space * 0.1 + input.pinch * 0.34),
  };
}

export function quantizeTime(time, quantum = AUDIO_LIMITS.quantum) {
  const t = bounded(time, 0, Number.MAX_SAFE_INTEGER, 0);
  const step = bounded(quantum, 0.05, 10, AUDIO_LIMITS.quantum);
  return Math.ceil((t - 1e-9) / step) * step;
}

/** Plans at most one pending chord. Commit only after voices were allocated. */
export class ChordPacer {
  constructor() { this.reset(); }

  reset() {
    this.lastTime = -Infinity;
    this.lastKey = null;
  }

  plan(now, key) {
    if (!Number.isFinite(now) || now < 0 || typeof key !== 'string') return null;
    const time = quantizeTime(now + 0.02);
    if (key === this.lastKey || time < this.lastTime + AUDIO_LIMITS.minTriggerInterval) return null;
    return { key, time };
  }

  commit(event) {
    if (!event || !Number.isFinite(event.time) || event.time < 0 || typeof event.key !== 'string') return false;
    if (event.time < this.lastTime + AUDIO_LIMITS.minTriggerInterval) return false;
    this.lastKey = event.key;
    this.lastTime = event.time;
    return true;
  }
}

/** Deterministic stereo impulse; generated locally, with no fetched audio. */
export function createImpulseResponse(context, seconds = 2.6, seed = 0xa37e) {
  const duration = bounded(seconds, 0.1, 4, 2.6);
  const length = Math.max(2, Math.floor(context.sampleRate * duration));
  const buffer = context.createBuffer(2, length, context.sampleRate);
  let state = (seed >>> 0) || 1;
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let i = 0; i < length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const noise = state / 0x100000000 * 2 - 1;
      low += 0.32 * (noise - low);
      const envelope = (1 - i / (length - 1)) ** 3;
      const fadeIn = Math.min(1, i / (context.sampleRate * 0.008));
      data[i] = low * envelope * fadeIn;
    }
  }
  return buffer;
}

function envelopeAt(voice, time) {
  if (time <= voice.start) return 0;
  if (voice.released && time >= voice.releaseAt) {
    return voice.releaseLevel * Math.max(0, 1 - (time - voice.releaseAt) / voice.releaseDuration);
  }
  if (time < voice.start + voice.attack) return voice.peak * (time - voice.start) / voice.attack;
  const settle = Math.min(1, (time - voice.start - voice.attack) / 2);
  return voice.peak * (1 - settle * 0.25);
}

export class AudioEngine {
  // contextFactory is optional dependency injection for offline/lifecycle tests.
  constructor({ contextFactory, profile = runtimeAudioProfile() } = {}) {
    this._contextFactory = contextFactory;
    this._profile = profile;
    this._context = null;
    this._nodes = new Set();
    this._voices = [];
    this._targets = new Map();
    this._settings = { ...DEFAULT_SETTINGS };
    this._interaction = { ...DEFAULT_INTERACTION };
    this._pacer = new ChordPacer();
    this._band = null;
    this._ready = false;
    this._disposed = false;
    this._startPromise = null;
    this._closePromise = null;
    this.lastError = null;
    this.graph = null;
  }

  get started() { return !this._disposed && this._ready && this._context?.state === 'running'; }
  get muted() { return this._settings.muted; }

  /** The only method that creates/resumes an AudioContext. Always resolves. */
  start() {
    if (this._disposed) return Promise.resolve(false);
    if (this._startPromise) return this._startPromise;
    if (this.started) return Promise.resolve(true);
    let context;
    try {
      if (this._context?.state === 'closed') this._clearGraph();
      if (!this._context) {
        const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!this._contextFactory && !AudioContextClass) {
          this.lastError = 'Web Audio is unavailable in this browser.';
          return Promise.resolve(false);
        }
        this._context = this._contextFactory
          ? this._contextFactory() : new AudioContextClass({ latencyHint: 'interactive' });
        this._buildGraph();
      }
      context = this._context;
      // Invoke resume synchronously, before yielding the initiating click event.
      const resumed = context.state === 'running' ? Promise.resolve() : context.resume();
      this._startPromise = Promise.resolve(resumed).then(() => {
        if (this._disposed || this._context !== context) return false;
        this._ready = context.state === 'running';
        this.lastError = this._ready ? null : 'Audio is suspended. Use Enable sound to retry.';
        return this._ready;
      }).catch((error) => {
        this.lastError = String(error?.message || error || 'Audio could not start.');
        this._ready = false;
        return false; // Retain the silent graph for another explicit attempt.
      }).finally(() => { this._startPromise = null; });
      return this._startPromise;
    } catch (error) {
      this.lastError = String(error?.message || error || 'Audio could not start.');
      const failed = this._context;
      this._clearGraph();
      this._closeContext(failed);
      return Promise.resolve(false);
    }
  }

  _track(node) { this._nodes.add(node); return node; }

  _buildGraph() {
    const context = this._context;
    const gain = (level) => {
      const node = this._track(context.createGain());
      node.gain.value = level;
      return node;
    };
    const bus = gain(0.65);
    const filter = this._track(context.createBiquadFilter());
    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    filter.Q.value = 0.6;
    // StereoPanner is standard; a mono fallback still allows older Web Audio.
    const pan = this._track(typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : context.createGain());
    const dry = gain(0.8);
    const delaySend = gain(0.15);
    const delay = this._track(context.createDelay(1.5));
    delay.delayTime.value = AUDIO_PRESETS[this._settings.preset].delay;
    const feedbackFilter = this._track(context.createBiquadFilter());
    feedbackFilter.type = 'lowpass';
    feedbackFilter.frequency.value = 2400;
    feedbackFilter.Q.value = 0.3;
    const feedback = gain(0.25);
    const echo = gain(0.38);
    const reverbSend = gain(0.25);
    const reverb = this._track(context.createConvolver());
    reverb.buffer = createImpulseResponse(context, this._profile.impulseSeconds);
    const wet = gain(this._profile.wetGain);
    const compressor = this._track(context.createDynamicsCompressor());
    compressor.threshold.value = -20;
    compressor.knee.value = 18;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.015;
    compressor.release.value = 0.3;
    const master = gain(0);
    bus.connect(filter).connect(pan);
    pan.connect(dry).connect(compressor);
    pan.connect(delaySend).connect(delay);
    delay.connect(feedbackFilter).connect(feedback).connect(delay);
    delay.connect(echo).connect(compressor);
    pan.connect(reverbSend).connect(reverb).connect(wet).connect(compressor);
    compressor.connect(master).connect(context.destination);
    this.graph = { bus, filter, pan, delaySend, delay, feedbackFilter, feedback, reverbSend, reverb, master };
    this._applyMaster();
  }

  _smooth(param, value, tau = 0.08) {
    if (!param || !this._context || !Number.isFinite(value)) return;
    if (Math.abs((this._targets.get(param) ?? Infinity) - value) < 0.0001) return;
    param.setTargetAtTime(value, this._context.currentTime, tau);
    this._targets.set(param, value);
  }

  _applyMaster() {
    this._smooth(this.graph?.master.gain,
      this.muted ? 0 : this._settings.volume * AUDIO_LIMITS.maxMasterGain, 0.035);
  }

  setVolume(value) {
    if (this._disposed) return;
    this._settings.volume = bounded(value, 0, 1, this._settings.volume);
    this._applyMaster();
  }

  setMuted(value) {
    if (this._disposed || typeof value !== 'boolean' || this.muted === value) return;
    this._settings.muted = value;
    this._applyMaster();
    if (value && this._context) {
      const now = this._context.currentTime;
      for (const voice of this._voices) this._releaseVoice(voice, now, 0.12);
    }
    this._pacer.reset();
  }

  setTuning(name) {
    if (!this._disposed && own(TUNINGS, name)) this._settings.tuning = name;
  }

  setPreset(name) {
    if (!this._disposed && own(AUDIO_PRESETS, name)) this._settings.preset = name;
  }

  update(interaction, scene, dt = 1 / 60) {
    if (this._disposed) return;
    const settings = sanitizeAudioSettings(scene, this._settings);
    this.setVolume(settings.volume);
    this.setMuted(settings.muted);
    this.setTuning(settings.tuning);
    this.setPreset(settings.preset);
    const input = sanitizeInteraction(interaction);
    const elapsed = bounded(dt, 0, 0.25, 1 / 60);
    const blend = 1 - Math.exp(-elapsed / 0.09);
    for (const key of ['x', 'y', 'energy', 'pinch', 'depth']) {
      this._interaction[key] += (input[key] - this._interaction[key]) * blend;
    }
    this._interaction.active = input.active;
    if (!this.started) return;

    const now = this._context.currentTime;
    this._pruneVoices(now);
    const preset = AUDIO_PRESETS[this._settings.preset];
    const modulation = mapInteraction(this._interaction, this._settings.preset);
    this._smooth(this.graph.filter.frequency, Math.min(modulation.cutoff, this._context.sampleRate * 0.45));
    this._smooth(this.graph.pan.pan, modulation.pan);
    this._smooth(this.graph.delaySend.gain, modulation.delaySend * this._profile.delaySend);
    this._smooth(this.graph.feedback.gain, Math.min(modulation.feedback, this._profile.maxFeedback));
    this._smooth(this.graph.delay.delayTime, preset.delay, 0.4);
    this._smooth(this.graph.reverbSend.gain, modulation.reverb * this._profile.reverbSend);
    for (const voice of this._voices) {
      if (!voice.released) this._smooth(voice.harmonic.gain, modulation.harmonic, 0.12);
    }
    if (this.muted || this._settings.volume === 0) return;
    if (!input.active) {
      // Pause/lost tracking holds notes already sounding. Cancel future onsets
      // so a chord cannot unexpectedly begin after the visitor stops acting.
      // Keep the pacing timestamp, even when cancelling, to prevent rapid
      // active/inactive toggles from bypassing the chord rate limit.
      for (const voice of [...this._voices]) {
        if (voice.start > now) {
          for (const oscillator of voice.oscillators) oscillator.stop(now);
          this._removeVoice(voice);
          this._pacer.lastKey = null;
        }
      }
      return;
    }

    this._band = selectChordBand(this._interaction.y, this._band);
    const register = Math.floor(this._band / 3) - 1;
    const scaleLength = TUNINGS[this._settings.tuning].ratios.length;
    const degree = [0, Math.floor(scaleLength / 3), Math.floor(scaleLength * 2 / 3)][this._band % 3];
    const key = `${this._settings.preset}:${this._settings.tuning}:${this._band}`;
    const event = this._pacer.plan(now, key);
    if (!event) return;
    const frequencies = chordFrequencies({ tuning: this._settings.tuning, rootHz: preset.rootHz, degree, register });
    // Count tails too. If still full, leave the event uncommitted and retry on
    // the next frame; never cut a sounding voice to make room for another.
    if (this._voices.length + frequencies.length > this._profile.maxVoices) return;
    for (const voice of this._voices) {
      if (!voice.released) this._releaseVoice(voice, event.time, preset.release);
    }
    for (const frequency of frequencies) this._addVoice(frequency, event.time, modulation);
    this._pacer.commit(event);
  }

  _addVoice(frequency, start, modulation) {
    const context = this._context;
    const envelope = this._track(context.createGain());
    const harmonic = this._track(context.createGain());
    const fundamental = this._track(context.createOscillator());
    const overtone = this._track(context.createOscillator());
    fundamental.type = 'sine';
    overtone.type = 'triangle';
    fundamental.frequency.value = Math.min(frequency, context.sampleRate * 0.2);
    overtone.frequency.value = Math.min(frequency * 2, context.sampleRate * 0.4);
    harmonic.gain.value = modulation.harmonic;
    envelope.gain.value = 0;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(modulation.peak, start + modulation.attack);
    envelope.gain.linearRampToValueAtTime(modulation.peak * 0.75, start + modulation.attack + 2);
    fundamental.connect(envelope);
    overtone.connect(harmonic).connect(envelope);
    envelope.connect(this.graph.bus);
    const voice = {
      start, attack: modulation.attack, peak: modulation.peak,
      envelope, harmonic, oscillators: [fundamental, overtone],
      nodes: [fundamental, overtone, harmonic, envelope], released: false, end: Infinity,
    };
    this._voices.push(voice);
    let ended = 0;
    for (const oscillator of voice.oscillators) {
      oscillator.onended = () => { if (++ended === 2) this._removeVoice(voice); };
      oscillator.start(start);
    }
  }

  _releaseVoice(voice, time, duration) {
    const gain = voice.envelope.gain;
    const level = envelopeAt(voice, time);
    // Holding at a future quantized boundary preserves an in-flight attack.
    if (typeof gain.cancelAndHoldAtTime === 'function') gain.cancelAndHoldAtTime(time);
    else {
      gain.cancelScheduledValues(time);
      // Reconstruct the truncated ramp for browsers without cancelAndHold.
      gain.linearRampToValueAtTime(level, time);
    }
    gain.linearRampToValueAtTime(0, time + duration);
    voice.released = true;
    voice.releaseAt = time;
    voice.releaseLevel = level;
    voice.releaseDuration = duration;
    voice.end = time + duration + 0.02;
    for (const oscillator of voice.oscillators) oscillator.stop(voice.end);
  }

  _removeVoice(voice) {
    const index = this._voices.indexOf(voice);
    if (index < 0) return;
    this._voices.splice(index, 1);
    for (const oscillator of voice.oscillators) oscillator.onended = null;
    for (const node of voice.nodes) {
      node.disconnect();
      this._nodes.delete(node);
      if (node.gain) this._targets.delete(node.gain);
    }
  }

  _pruneVoices(now) {
    for (const voice of [...this._voices]) if (voice.end <= now) this._removeVoice(voice);
  }

  _clearGraph() {
    for (const voice of this._voices) {
      for (const oscillator of voice.oscillators) {
        oscillator.onended = null;
        try { oscillator.stop(); } catch { /* Already stopped/closed. */ }
      }
    }
    for (const node of this._nodes) {
      try { node.disconnect(); } catch { /* Partially constructed graph. */ }
    }
    if (this.graph?.reverb) this.graph.reverb.buffer = null;
    this._voices.length = 0;
    this._nodes.clear();
    this._targets.clear();
    this._context = null;
    this.graph = null;
    this._ready = false;
    this._pacer.reset();
  }

  _closeContext(context) {
    try { return context && context.state !== 'closed' ? Promise.resolve(context.close()).catch(() => {}) : Promise.resolve(); }
    catch { return Promise.resolve(); }
  }

  dispose() {
    if (this._disposed) return this._closePromise || Promise.resolve();
    this._disposed = true;
    const context = this._context;
    if (this.graph && context) {
      this.graph.master.gain.cancelScheduledValues(context.currentTime);
      this.graph.master.gain.setValueAtTime(0, context.currentTime);
    }
    this._clearGraph();
    this._closePromise = this._closeContext(context);
    return this._closePromise;
  }
}

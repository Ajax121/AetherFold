/** Kinetic input. Public coordinates use a top-left origin; pinch 1 = closed.
 * No capture, CDN request or background task is started by importing this file.
 */
export const clamp01 = (value, fallback = 0) => Number.isFinite(value)
  ? Math.max(0, Math.min(1, value)) : fallback;
export const smooth = (current, target, dt, tau = 0.07) => current
  + (target - current) * -Math.expm1(-Math.max(0, Number.isFinite(dt) ? dt : 0) / tau);

export function normalizePoint(clientX, clientY, rect) {
  return { x: clamp01((clientX - rect.left) / Math.max(1, rect.width), 0.5),
    y: clamp01((clientY - rect.top) / Math.max(1, rect.height), 0.5) };
}

// Official API: https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js
// https://ai.google.dev/edge/api/mediapipe/js/tasks-vision.handlandmarker
// JS and WASM must use the same pinned release. Model URL pins model revision 1.
export const HAND_TRACKING = Object.freeze({
  bundle: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs',
  wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm',
  model: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  interval: 1000 / 20,
  staleAfter: 0.35,
});

/** Thumb/index distance divided by palm width avoids depth-dependent pinching.
 * Depth is a relative palm-size control, not a metric distance measurement.
 */
export function landmarksToGesture(landmarks, aspect = 4 / 3) {
  if (!landmarks || [0, 4, 5, 8, 9, 17].some(i => !landmarks[i]
    || !Number.isFinite(landmarks[i].x) || !Number.isFinite(landmarks[i].y))) return null;
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3;
  const distance = (a, b) => Math.hypot((a.x - b.x) * ratio, a.y - b.y);
  const width = distance(landmarks[5], landmarks[17]);
  if (width < 0.015) return null;
  const gap = distance(landmarks[4], landmarks[8]) / width;
  return {
    x: clamp01(1 - (landmarks[0].x + landmarks[5].x + landmarks[9].x + landmarks[17].x) / 4),
    y: clamp01((landmarks[0].y + landmarks[5].y + landmarks[9].y + landmarks[17].y) / 4),
    pinch: clamp01((0.9 - gap) / 0.7),
    depth: clamp01((width - 0.06) / 0.3),
  };
}

function stopStream(stream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

// getUserMedia cannot be aborted. Stop any stream arriving after cancellation.
function cancellable(promise, signal, timeout, message, onLate = () => {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, new Error('Camera request cancelled.'));
    const timer = setTimeout(() => finish(reject, new Error(message)), timeout);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      if (settled) onLate(value);
      else finish(resolve, value);
    }, error => finish(reject, error));
    if (signal.aborted) abort();
  });
}

// This function becomes a classic worker via a Blob, keeping the module standalone.
// Dynamic import loads the ESM bundle; classic workers allow MediaPipe's WASM
// loader to use importScripts. Inference never runs on the rendering thread.
function handWorker() {
  let tracker = null;
  let closing = false;
  self.onmessage = async ({ data }) => {
    if (data.type === 'dispose') {
      closing = true;
      try { tracker?.close(); } finally {
        tracker = null;
        self.postMessage({ type: 'disposed' });
        self.close();
      }
      return;
    }
    if (closing) { data.frame?.close(); return; }
    try {
      if (data.type === 'init') {
        const { FilesetResolver, HandLandmarker } = await import(data.config.bundle);
        const files = await FilesetResolver.forVisionTasks(data.config.wasm);
        if (closing) return;
        tracker = await HandLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: data.config.model, delegate: 'CPU' },
          canvas: new OffscreenCanvas(1, 1), runningMode: 'VIDEO', numHands: 1,
          minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6,
          minTrackingConfidence: 0.6,
        });
        if (closing) { tracker.close(); tracker = null; return; }
        self.postMessage({ type: 'ready' });
      } else if (data.type === 'frame') {
        try {
          const result = tracker.detectForVideo(data.frame, data.timestamp);
          self.postMessage({ type: 'result', landmarks: result.landmarks,
            timestamp: data.timestamp, aspect: data.aspect });
        } finally { data.frame.close(); }
      }
    } catch (error) {
      self.postMessage({ type: 'error', message: error?.message || 'Hand tracking failed.' });
    }
  };
}

function cameraError(error) {
  const reasons = {
    NotAllowedError: 'Camera permission was denied. Enable access in browser settings to retry.',
    SecurityError: 'Camera access was blocked by browser security settings.',
    NotFoundError: 'No camera was found.',
    NotReadableError: 'The camera is unavailable or in use by another app.',
    OverconstrainedError: 'The camera does not support the requested video stream.',
  };
  return `${reasons[error?.name] ?? error?.message ?? 'Camera tracking failed.'} Pointer and touch remain available.`;
}

/** Separating sample time from render time keeps energy independent of FPS. */
export class KineticSignal {
  constructor() {
    this.state = { x: 0.5, y: 0.5, energy: 0, pinch: 0, depth: 0.5,
      active: false, mode: 'pointer', tracked: false, timestamp: 0 };
    this.target = { x: 0.5, y: 0.5, pinch: 0, depth: 0.5 };
    this.lastSample = null;
    this.motionEnergy = 0;
    this.motionAt = 0;
    this.active = false;
    this.tracked = false;
  }

  sample({ x, y, pinch = 0, depth = 0.5 }, now, tracked = false) {
    if (!Number.isFinite(now)) return;
    const point = { x: clamp01(x, 0.5), y: clamp01(y, 0.5) };
    const previous = this.lastSample;
    if (previous && now > previous.time) {
      const elapsed = now - previous.time;
      // A reacquired hand/cursor must not inject a spurious velocity spike.
      if (elapsed <= 0.3) {
        const speed = Math.hypot(point.x - previous.x, point.y - previous.y) / elapsed;
        this.motionEnergy = smooth(this.motionEnergy, clamp01(speed / 1.5), elapsed, 0.06);
      } else this.motionEnergy = 0;
    }
    if (!previous || now >= previous.time) {
      this.lastSample = { ...point, time: now };
      this.motionAt = now;
    }
    Object.assign(this.target, point, { pinch: clamp01(pinch), depth: clamp01(depth, 0.5) });
    this.active = true;
    this.tracked = tracked;
  }

  release() {
    this.active = false;
    this.tracked = false;
    this.target.pinch = 0;
    this.target.depth = 0.5;
    this.lastSample = null;
  }

  update(dt, now, mode = 'pointer') {
    const elapsed = Math.max(0, Number.isFinite(dt) ? dt : 0);
    const time = Number.isFinite(now) ? now : this.state.timestamp + elapsed;
    for (const key of ['x', 'y', 'pinch', 'depth']) {
      this.state[key] = clamp01(smooth(this.state[key], this.target[key], elapsed));
    }
    this.state.energy = clamp01(this.motionEnergy * Math.exp(-Math.max(0, time - this.motionAt) / 0.28));
    this.state.active = this.active;
    this.state.tracked = this.tracked;
    this.state.mode = mode;
    this.state.timestamp = Math.max(this.state.timestamp, time);
    return this.state;
  }
}

export class InputController {
  constructor(canvas, { onStatus = () => {} } = {}) {
    this.canvas = canvas;
    this.onStatus = onStatus;
    this.view = canvas.ownerDocument?.defaultView ?? globalThis;
    this.document = canvas.ownerDocument ?? globalThis.document;
    this.signal = new KineticSignal();
    this.mode = 'pointer';
    this.disposed = false;
    this.contacts = new Map();
    this.handlers = [];
    this.generation = 0;
    this.camera = null;
    this.initialSpan = null;
    this.oldTouchAction = canvas.style?.touchAction;
    if (canvas.style) canvas.style.touchAction = 'none';
    const on = (target, type, handler, options) => {
      target?.addEventListener(type, handler, options);
      this.handlers.push(() => target?.removeEventListener(type, handler, options));
    };
    const down = event => this._pointer(event, 'down');
    const move = event => this._pointer(event, 'move');
    const up = event => this._pointer(event, 'up');
    on(canvas, 'pointerdown', down);
    on(canvas, 'pointermove', move);
    on(this.view, 'pointerup', up);
    on(this.view, 'pointercancel', up);
    on(canvas, 'lostpointercapture', up);
    on(canvas, 'pointerleave', () => {
      if (!this.contacts.size && !this.signal.tracked) this.signal.release();
    });
    // Older touch browsers still work without PointerEvent support.
    if (!this.view.PointerEvent) {
      for (const [type, action] of [['touchstart', 'down'], ['touchmove', 'move'],
        ['touchend', 'up'], ['touchcancel', 'up']]) {
        on(canvas, type, event => {
          event.preventDefault();
          for (const touch of event.changedTouches) this._pointer({
            pointerId: touch.identifier, pointerType: 'touch', clientX: touch.clientX,
            clientY: touch.clientY, button: 0, preventDefault() {} }, action);
        }, { passive: false });
      }
      on(canvas, 'mousedown', event => this._pointer(event, 'down'));
      on(canvas, 'mousemove', event => this._pointer(event, 'move'));
      on(this.view, 'mouseup', event => this._pointer(event, 'up'));
    }
    on(this.view, 'blur', () => this._releasePointers());
    on(this.document, 'visibilitychange', () => {
      if (this.document.hidden) this._releasePointers();
    });
    this._status('Move to warp; hold or squeeze two fingers to pinch.');
  }

  _now() { return (this.view.performance?.now() ?? Date.now()) / 1000; }

  _status(message, tracked = this.signal.tracked) {
    // Status consumers must not prevent resource cleanup.
    try { this.onStatus({ mode: this.mode, tracked, message }); } catch { /* UI callback */ }
  }

  _pointer(event, action) {
    if (this.disposed || (this.mode === 'camera' && this.signal.tracked)) return;
    const id = event.pointerId ?? 1;
    if (action === 'down' && event.button != null && event.button !== 0) return;
    const point = normalizePoint(event.clientX, event.clientY, this.canvas.getBoundingClientRect());
    if (action === 'down') {
      event.preventDefault?.();
      this.contacts.set(id, point);
      try { this.canvas.setPointerCapture?.(id); } catch { /* old touch browser */ }
    } else if (action === 'up') {
      if (!this.contacts.has(id)) return;
      this.contacts.delete(id);
      try { this.canvas.releasePointerCapture?.(id); } catch { /* already released */ }
    } else if (this.contacts.has(id)) this.contacts.set(id, point);
    else if (event.pointerType === 'touch') return;

    const points = [...this.contacts.values()];
    let pinch = points.length ? 1 : 0;
    let center = points[0] ?? point;
    if (points.length >= 2) {
      const rect = this.canvas.getBoundingClientRect();
      const span = Math.hypot((points[0].x - points[1].x) * rect.width,
        (points[0].y - points[1].y) * rect.height);
      this.initialSpan ??= Math.max(1, span);
      pinch = clamp01(1 - span / this.initialSpan);
      center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    } else this.initialSpan = null;
    this.signal.sample({ ...center, pinch }, this._now());
    if (action === 'up' && !points.length) this.signal.release();
  }

  _releasePointers() {
    const ids = [...this.contacts.keys()];
    this.contacts.clear();
    this.initialSpan = null;
    for (const id of ids) {
      try { this.canvas.releasePointerCapture?.(id); } catch { /* no capture */ }
    }
    this.signal.release();
  }

  update(dt, now) {
    const time = Number.isFinite(now) ? now : this._now();
    if (this.camera && this.signal.tracked && time - this.camera.handAt > HAND_TRACKING.staleAfter) {
      this._lostHand(this.camera);
    }
    if (!this.signal.tracked && !this.contacts.size && this.signal.lastSample
        && time - this.signal.lastSample.time > 0.4) this.signal.release();
    return this.signal.update(dt, now, this.mode);
  }

  async setMode(mode) {
    if (!['pointer', 'camera'].includes(mode) || this.disposed) return false;
    if (mode === 'camera' && this.camera) return this.camera.startPromise;
    ++this.generation;
    this._stopCamera(this.camera);
    this._releasePointers();
    this.mode = 'pointer';
    if (mode === 'pointer') {
      this._status('Pointer mode. Move to warp; hold to pinch.');
      return true;
    }
    const session = { generation: this.generation, abort: new AbortController(),
      closed: false, cleanups: [], busy: false, lastVideoTime: -1, handAt: -Infinity,
      hadHand: false, timer: null, watchdog: null };
    this.camera = session;
    session.startPromise = this._startCamera(session);
    return session.startPromise;
  }

  _current(session) {
    return !this.disposed && !session.closed && this.camera === session
      && this.generation === session.generation;
  }

  async _startCamera(session) {
    try {
      if (!this.view.isSecureContext) throw new Error('Camera needs HTTPS or localhost.');
      const media = this.view.navigator?.mediaDevices;
      if (!media?.getUserMedia) throw new Error('Camera capture is not supported in this browser.');
      if (!this.view.Worker || !this.view.OffscreenCanvas || !this.view.createImageBitmap) {
        throw new Error('Background hand tracking is not supported in this browser.');
      }
      this._status('Requesting camera permission…');
      session.stream = await cancellable(media.getUserMedia({ audio: false, video: {
        facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 },
      } }), session.abort.signal, 30000, 'Camera permission timed out.', stopStream);
      if (!this._current(session)) { stopStream(session.stream); return false; }
      for (const track of session.stream.getTracks()) {
        const ended = () => this._cameraFailed(session, new Error('Camera disconnected.'));
        track.addEventListener('ended', ended);
        session.cleanups.push(() => track.removeEventListener('ended', ended));
      }
      const video = this.document.createElement('video');
      session.video = video;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.srcObject = session.stream;
      await cancellable(video.play(), session.abort.signal, 10000, 'Camera video did not start.');
      if (!this._current(session)) return false;
      this._status('Loading hand tracking… Pointer remains available.');
      const blob = new this.view.Blob([`(${handWorker.toString()})();`], { type: 'text/javascript' });
      session.workerURL = this.view.URL.createObjectURL(blob);
      const worker = new this.view.Worker(session.workerURL, { name: 'aetherfold-hands' });
      session.worker = worker;
      const ready = new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          if (!this._current(session)) return;
          if (data.type === 'ready') resolve();
          else if (data.type === 'result') this._handResult(session, data);
          else if (data.type === 'error') {
            const error = new Error(`Hand tracking could not run: ${data.message}`);
            reject(error);
            this._cameraFailed(session, error);
          }
        };
        worker.onerror = event => {
          event.preventDefault?.();
          const error = new Error('Hand tracking could not load. Check the connection or CDN access.');
          reject(error);
          this._cameraFailed(session, error);
        };
        worker.onmessageerror = () => {
          const error = new Error('Hand tracking could not read a camera frame.');
          reject(error);
          this._cameraFailed(session, error);
        };
      });
      worker.postMessage({ type: 'init', config: HAND_TRACKING });
      await cancellable(ready, session.abort.signal, 25000, 'Hand tracking download timed out.');
      if (!this._current(session)) return false;
      this.mode = 'camera';
      this._status('Camera ready. Show one hand; bring thumb and index together to pinch.', false);
      this._scheduleFrame(session);
      return true;
    } catch (error) {
      this._cameraFailed(session, error);
      return false;
    }
  }

  _scheduleFrame(session) {
    if (this._current(session)) {
      clearTimeout(session.timer);
      session.timer = setTimeout(() => this._captureFrame(session), HAND_TRACKING.interval);
    }
  }

  async _captureFrame(session) {
    if (!this._current(session)) return;
    const video = session.video;
    if (this.document.hidden || session.busy || video.readyState < 2
        || video.currentTime === session.lastVideoTime) {
      if (this.document.hidden) this._lostHand(session);
      this._scheduleFrame(session);
      return;
    }
    session.busy = true;
    session.lastVideoTime = video.currentTime;
    const timestamp = this._now() * 1000;
    session.watchdog = setTimeout(() => {
      this._cameraFailed(session, new Error('Hand tracking stopped responding.'));
    }, 4000);
    let frame;
    try {
      // Only one transferable frame can be in flight; no queue or render-loop inference.
      frame = await this.view.createImageBitmap(video);
      if (!this._current(session)) { frame.close(); return; }
      session.worker.postMessage({ type: 'frame', frame, timestamp,
        aspect: video.videoWidth / Math.max(1, video.videoHeight) }, [frame]);
    } catch (error) {
      frame?.close();
      this._cameraFailed(session, error);
    }
    // Schedule again only after the result arrives (backpressure for slow devices).
  }

  _handResult(session, data) {
    if (!this._current(session)) return;
    clearTimeout(session.watchdog);
    session.busy = false;
    const now = this._now();
    const sampleTime = data.timestamp / 1000;
    const gesture = landmarksToGesture(data.landmarks?.[0], data.aspect);
    if (!this.document.hidden && gesture && Number.isFinite(sampleTime)
        && now - sampleTime <= HAND_TRACKING.staleAfter && sampleTime >= session.handAt) {
      if (!session.hadHand) this._releasePointers();
      session.handAt = sampleTime;
      this.signal.sample(gesture, sampleTime, true);
      if (!session.hadHand) this._status('Hand tracked. Move to warp; pinch to draw the geometry inward.', true);
      session.hadHand = true;
    } else this._lostHand(session);
    this._scheduleFrame(session);
  }

  _lostHand(session) {
    if (this.signal.tracked) this.signal.release();
    if (session.hadHand) this._status('Hand lost. Show your hand again, or use pointer/touch.', false);
    session.hadHand = false;
  }

  _cameraFailed(session, error) {
    if (!this._current(session)) return;
    this._stopCamera(session);
    this.mode = 'pointer';
    this._releasePointers();
    this._status(cameraError(error), false);
  }

  _stopCamera(session) {
    if (!session || session.closed) return;
    session.closed = true;
    session.abort.abort();
    clearTimeout(session.timer);
    clearTimeout(session.watchdog);
    for (const remove of session.cleanups) remove();
    stopStream(session.stream);
    if (session.video) {
      session.video.pause();
      session.video.srcObject = null;
      session.video.remove();
    }
    if (session.worker) {
      const worker = session.worker;
      // Let the tracker close its WASM/GL resources, but bound shutdown if stuck.
      const timeout = setTimeout(() => worker.terminate(), 250);
      timeout.unref?.();
      worker.onmessage = ({ data }) => {
        if (data.type === 'disposed') { clearTimeout(timeout); worker.terminate(); }
      };
      worker.onerror = worker.onmessageerror = null;
      try { worker.postMessage({ type: 'dispose' }); }
      catch { clearTimeout(timeout); worker.terminate(); }
    }
    if (session.workerURL) this.view.URL.revokeObjectURL(session.workerURL);
    if (this.camera === session) this.camera = null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    this._stopCamera(this.camera);
    this._releasePointers();
    for (const remove of this.handlers.splice(0)) remove();
    if (this.canvas.style) this.canvas.style.touchAction = this.oldTouchAction ?? '';
  }
}

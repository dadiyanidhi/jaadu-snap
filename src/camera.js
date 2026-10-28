// Main-world script. Wraps getUserMedia so the call site (Meet, Teams, Zoom,
// …) receives a processed camera track: every frame is redrawn with the active
// effect, and a downscaled copy is sent to the detector iframe (MediaPipe +
// MI-GAN, running in the extension's origin). Sites like Meet keep several
// copies of the camera alive, so detection, the person mask and the learned
// room are shared by all of them.
(() => {
  const NS = (window.__snapFX ||= {});
  if (NS.installed) return;
  NS.installed = true;

  if (!window.MediaDevices || !('MediaStreamTrackProcessor' in window) || !('MediaStreamTrackGenerator' in window)) {
    console.warn('[Jaadu Snap] This browser lacks insertable streams; effects disabled.');
    return;
  }

  const DETECT_W = 320;
  const SCENE_W = 640;
  const ROOM_W = 512;
  const FIRST_INPAINT_MS = 4000;
  const INPAINT_EVERY_MS = 15000;
  const SHORTCUTS = { Digit1: 'dust', Digit2: 'cash', Digit3: 'cinema', Digit4: 'facepalm' };
  const GESTURE_FX = { snap: ['snap', 'dust'], doubleSnap: ['doubleSnap', 'cash'], cinema: ['cinema', 'cinema'], facepalm: ['facepalm', 'facepalm'] };

  NS.settings = {
    enabled: true, snap: true, doubleSnap: true, cinema: true, facepalm: true, snapSound: true,
    sensitivity: 0.5, showDebug: false, cinemaText: 'ABSOLUTE CINEMA', facepalmText: 'bruh.',
  };
  const status = { hooked: false, detector: 'idle', backend: null, error: null, room: 'idle', sound: 'off' };
  const fx = new NS.FXManager();
  const gestures = new NS.GestureEngine();
  const pipelines = new Set();

  const post = (msg) => window.postMessage({ snapfx: true, ...msg }, location.origin);
  const reportStatus = () => post({ type: 'status', status: { ...status } });
  const setStatus = (patch) => {
    Object.assign(status, patch);
    reportStatus();
  };
  const canvas = (w, h) => new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const originalGUM = MediaDevices.prototype.getUserMedia;

  // ---- Shared scene: latest frame, person mask, and the learned empty room.

  let scene = null;

  // One scene per camera aspect ratio. A copy with a different shape only
  // takes over if the current scene has stopped receiving detections.
  function sceneFor(W, H, now) {
    const aspect = W / H;
    if (scene && (Math.abs(scene.aspect - aspect) < 0.01 || now - scene.lastDetectAt < 2000)) return scene;
    const sh = Math.round(SCENE_W / aspect);
    const rh = Math.round(ROOM_W / aspect / 8) * 8;
    scene = {
      aspect,
      sent: canvas(SCENE_W, sh),
      pendingSent: canvas(SCENE_W, sh),
      detect: canvas(DETECT_W, Math.round(DETECT_W / aspect)),
      mask: canvas(DETECT_W, Math.round(DETECT_W / aspect)),
      wide: canvas(DETECT_W, Math.round(DETECT_W / aspect)),
      hasMask: false,
      plate: canvas(SCENE_W, sh),
      cutout: canvas(SCENE_W, sh),
      filled: canvas(SCENE_W, sh),
      room: canvas(SCENE_W, sh),
      roomInput: canvas(ROOM_W, rh),
      faceBox: null,
      lastDetectAt: now,
      learnStart: 0,
      inpaintedAt: 0,
      captureFrom: 0,
      captureUntil: 0,
    };
    fx.active = null;
    setStatus({ room: 'learning' });
    return scene;
  }

  function maskCanvas(target, alpha, w, h) {
    const img = new ImageData(w, h);
    for (let i = 0; i < alpha.length; i++) {
      const o = i * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
      img.data[o + 3] = alpha[i];
    }
    const c = target.width === w && target.height === h ? target : canvas(w, h);
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }

  function onMask(res, now) {
    const s = scene;
    const { width: mw, height: mh, data, wide } = res.mask;
    s.mask = maskCanvas(s.mask, new Uint8Array(data), mw, mh);
    s.wide = maskCanvas(s.wide, new Uint8Array(wide), mw, mh);
    if (!s.hasMask) s.learnStart = now;
    s.hasMask = true;
    const sent = s.sent.getContext('2d');
    sent.clearRect(0, 0, s.sent.width, s.sent.height);
    sent.drawImage(s.pendingSent, 0, 0);
    updatePlate(now);
  }

  // The plate accumulates background pixels; its alpha records where the room
  // has actually been seen. Unseen parts come from the last inpainting result.
  function updatePlate(now) {
    const s = scene;
    const { width: pw, height: ph } = s.plate;
    const p = s.plate.getContext('2d');

    if (now >= s.captureFrom && now <= s.captureUntil) {
      p.globalAlpha = 1;
      p.drawImage(s.sent, 0, 0);
    } else {
      const c = s.cutout.getContext('2d');
      c.globalCompositeOperation = 'source-over';
      c.clearRect(0, 0, pw, ph);
      c.drawImage(s.sent, 0, 0);
      c.globalCompositeOperation = 'destination-out';
      c.drawImage(s.wide, 0, 0, pw, ph);
      c.globalCompositeOperation = 'source-over';
      p.globalAlpha = 0.5;
      p.drawImage(s.cutout, 0, 0);
      p.globalAlpha = 1;
    }

    if (!s.inpaintedAt) {
      // Until the model has run, fill unseen areas with a heavy blur of the room.
      const f = s.filled.getContext('2d');
      f.filter = 'blur(40px)';
      f.drawImage(s.plate, 0, 0);
      f.drawImage(s.plate, 0, 0);
      f.filter = 'none';
    }
    const r = s.room.getContext('2d');
    r.drawImage(s.filled, 0, 0);
    r.drawImage(s.plate, 0, 0);

    maybeInpaint(now);
  }

  let inpaintInFlight = false;

  function maybeInpaint(now, urgent = false) {
    const s = scene;
    if (inpaintInFlight || !detector.ready || !s.hasMask || status.room === 'unavailable') return;
    const due = s.inpaintedAt ? now - s.inpaintedAt > (urgent ? 4000 : INPAINT_EVERY_MS) : now - s.learnStart > FIRST_INPAINT_MS;
    if (!due) return;
    const { width: rw, height: rh } = s.roomInput;
    const g = s.roomInput.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, rw, rh);
    g.drawImage(s.plate, 0, 0, rw, rh);
    const image = g.getImageData(0, 0, rw, rh);
    inpaintInFlight = true;
    const target = s;
    detector.request('inpaint', { width: rw, height: rh, data: image.data.buffer }, [image.data.buffer], 60000).then((res) => {
      inpaintInFlight = false;
      if (!res || res.error) {
        if (res?.error) console.warn('[Jaadu Snap] inpainting failed', res.error);
        target.inpaintedAt = performance.now();
        if (target === scene && status.room !== 'ready') setStatus({ room: res?.error ? 'unavailable' : status.room });
        return;
      }
      const out = canvas(res.width, res.height);
      out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(res.data), res.width, res.height), 0, 0);
      const f = target.filled.getContext('2d');
      f.drawImage(out, 0, 0, target.filled.width, target.filled.height);
      target.inpaintedAt = performance.now();
      if (target === scene) setStatus({ room: 'ready' });
    });
  }

  // ---- Detector iframe (extension origin).

  const detector = {
    frame: null,
    origin: null,
    ready: false,
    nextId: 1,
    pending: new Map(),
    inFlight: false,
    frameNo: 0,

    ensure() {
      if (this.frame?.isConnected) return;
      const base = document.documentElement.dataset.snapfxBase;
      if (!base) return;
      this.origin = new URL(base).origin;
      this.ready = false;
      const f = document.createElement('iframe');
      f.src = `${base}detector/detector.html`;
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;opacity:0;border:0;pointer-events:none;';
      (document.body || document.documentElement).appendChild(f);
      this.frame = f;
      setStatus({ detector: 'loading' });
    },

    request(type, payload, transfer, timeoutMs) {
      const id = this.nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve(null);
        }, timeoutMs);
        this.pending.set(id, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
        this.frame.contentWindow.postMessage({ type, id, ...payload }, this.origin, transfer);
      });
    },

    maybeDetect(frame, W, H, now) {
      if (this.inFlight) return;
      this.ensure();
      if (!this.ready) return;
      const s = scene;
      if (Math.abs(s.aspect - W / H) > 0.01) return;
      s.lastDetectAt = now;
      const { width: dw, height: dh } = s.detect;
      const d = s.detect.getContext('2d', { willReadFrequently: true });
      d.drawImage(frame, 0, 0, dw, dh);
      const image = d.getImageData(0, 0, dw, dh);
      s.pendingSent.getContext('2d').drawImage(frame, 0, 0, s.pendingSent.width, s.pendingSent.height);
      this.frameNo++;
      this.inFlight = true;
      const payload = {
        width: dw, height: dh, data: image.data.buffer,
        wantFace: this.frameNo % 3 === 1, wantMask: this.frameNo % 2 === 1,
      };
      this.request('detect', payload, [image.data.buffer], 1500).then((res) => {
        this.inFlight = false;
        if (res && s === scene) onResult(res, W / H);
      });
    },
  };

  window.addEventListener('message', (e) => {
    if (!detector.frame || e.source !== detector.frame.contentWindow || e.origin !== detector.origin) return;
    const m = e.data;
    if (m?.type === 'ready') {
      detector.ready = true;
      setStatus({ detector: 'ready', backend: m.backend });
    } else if (m?.type === 'error') {
      setStatus({ detector: 'error', error: m.message });
    } else if (m?.type === 'result' || m?.type === 'inpainted') {
      const done = detector.pending.get(m.id);
      detector.pending.delete(m.id);
      done?.(m);
    }
  });

  let lastHands = [];

  function onResult(res, aspect) {
    const now = performance.now();
    if (res.faces?.length) scene.faceBox = res.faces[0];
    if (res.mask) onMask(res, now);
    lastHands = res.hands;
    const events = gestures.update(now, res.hands, res.faces || [], aspect);
    if (gestures.cinemaActive) fx.keepCinema(now / 1000);
    handleEvents(events, now);
  }

  function handleEvents(events, now) {
    for (const ev of events) {
      const [setting, name] = GESTURE_FX[ev];
      if (fx.active?.name === 'dust' && (ev === 'snap' || ev === 'doubleSnap')) {
        fx.trigger('dust', now / 1000, scene);
        continue;
      }
      if (!NS.settings[setting]) continue;
      startEffect(name, now, false);
    }
  }

  function startEffect(name, now, force) {
    if (!scene) return;
    if (name === 'dust') maybeInpaint(now, true);
    fx.trigger(name, now / 1000, scene, force);
  }

  // ---- Snap sound. A separate raw mic capture (no noise suppression, which
  // would remove the click) feeds a high-pass analyser polled every frame.

  const sound = {
    stream: null,
    ctx: null,
    analyser: null,
    buf: null,
    floor: 0.01,
    startedAt: 0,
    lastPoll: 0,
    lastClick: -Infinity,
    lastClickPeak: 0,
    starting: false,

    async start(deviceId) {
      if (this.stream || this.starting || !NS.settings.snapSound) return;
      this.starting = true;
      try {
        // Never be the reason a site asks for the mic: only listen where the
        // call already has mic access.
        const mic = await navigator.permissions.query({ name: 'microphone' }).catch(() => null);
        if (mic?.state !== 'granted') {
          setStatus({ sound: 'unavailable' });
          return;
        }
        const stream = await originalGUM.call(navigator.mediaDevices, {
          audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          },
        });
        if (!pipelines.size || !NS.settings.snapSound) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 1800;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 4096;
        src.connect(hp).connect(analyser);
        Object.assign(this, { stream, ctx, analyser, buf: new Float32Array(analyser.fftSize), startedAt: performance.now(), floor: 0.01 });
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        gestures.useSound = true;
        setStatus({ sound: 'on' });
      } catch (err) {
        console.warn('[Jaadu Snap] snap sound unavailable, using camera only', err);
        setStatus({ sound: 'unavailable' });
      } finally {
        this.starting = false;
      }
    },

    stop() {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.ctx?.close().catch(() => {});
      Object.assign(this, { stream: null, ctx: null, analyser: null });
      gestures.useSound = false;
      setStatus({ sound: 'off' });
    },

    poll(now) {
      if (!this.analyser || now - this.lastPoll < 20) return;
      this.lastPoll = now;
      if (this.ctx.state !== 'running') {
        this.ctx.resume().catch(() => {});
        return;
      }
      const buf = this.buf;
      this.analyser.getFloatTimeDomainData(buf);
      let peak = 0, sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const ratio = 12 - 6 * (Number(NS.settings.sensitivity) || 0.5);
      const isClick = now - this.startedAt > 1000 && peak > Math.max(0.02, this.floor * ratio) && peak > rms * 4;
      this.lastLevel = { peak, rms, floor: this.floor };
      if (!isClick) {
        this.floor += (rms - this.floor) * 0.05;
        return;
      }
      // A snap is followed by smaller clicks (finger hitting the palm, room
      // echo); only a comparably loud click shortly after counts as a new snap.
      const sinceLast = now - this.lastClick;
      if (sinceLast < 300 || (sinceLast < 700 && peak < this.lastClickPeak * 0.5)) return;
      this.lastClick = now;
      this.lastClickPeak = peak;
      handleEvents(gestures.onClick(now), now);
    },
  };

  ['pointerdown', 'keydown'].forEach((type) => window.addEventListener(type, () => {
    if (sound.ctx?.state === 'suspended') sound.ctx.resume().catch(() => {});
  }, true));

  // ---- Settings and controls.

  function applySettings(s) {
    NS.settings = { ...NS.settings, ...s };
    gestures.sensitivity = Number(NS.settings.sensitivity) || 0.5;
    gestures.doubleSnapMs = NS.settings.doubleSnap ? 650 : 0;
    if (!NS.settings.enabled) fx.active = null;
    if (!NS.settings.snapSound && sound.stream) sound.stop();
    if (NS.settings.snapSound && pipelines.size && !sound.stream) sound.start(lastAudioDevice);
  }

  function manual(name) {
    if (!NS.settings.enabled) return;
    startEffect(name, performance.now(), true);
  }

  function background(action) {
    if (!scene) return;
    const now = performance.now();
    if (action === 'reset') {
      scene = null;
      fx.active = null;
    }
    if (action === 'capture') {
      scene.captureFrom = now + 3000;
      scene.captureUntil = now + 4500;
      scene.inpaintedAt = 1;
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.snapfx !== true) return;
    const m = e.data;
    if (m.type === 'settings') applySettings(m.settings);
    else if (m.type === 'trigger') manual(m.name);
    else if (m.type === 'background') background(m.action);
  });

  window.addEventListener('keydown', (e) => {
    const name = e.altKey && e.shiftKey && SHORTCUTS[e.code];
    if (!name || !pipelines.size || !NS.settings.enabled) return;
    e.preventDefault();
    e.stopPropagation();
    manual(name);
  }, true);

  // ---- Per-track pipeline.

  let lastAudioDevice = null;

  class Pipeline {
    constructor(track) {
      this.W = 0;
      this.H = 0;

      const processor = new MediaStreamTrackProcessor({ track });
      const gen = new MediaStreamTrackGenerator({ kind: 'video' });
      processor.readable
        .pipeThrough(new TransformStream({ transform: (frame, c) => this.process(frame, c) }))
        .pipeTo(gen.writable)
        .catch(() => {});

      // Meet clones camera tracks and stops the originals, so the real camera
      // may only stop once the generator and every clone of it have stopped.
      const live = new Map();
      const adopt = (t) => {
        const nativeStop = t.stop.bind(t);
        const nativeClone = t.clone.bind(t);
        live.set(t, nativeStop);
        t.stop = () => {
          if (!live.delete(t)) return;
          nativeStop();
          if (!live.size) {
            track.stop();
            this.dispose();
          }
        };
        t.clone = () => adopt(nativeClone());
        t.getSettings = () => track.getSettings();
        t.getCapabilities = () => track.getCapabilities();
        t.getConstraints = () => track.getConstraints();
        t.applyConstraints = (c) => track.applyConstraints(c);
        Object.defineProperty(t, 'label', { get: () => track.label });
        return t;
      };
      track.addEventListener('ended', () => {
        for (const [t, nativeStop] of live) {
          nativeStop();
          t.dispatchEvent(new Event('ended'));
        }
        live.clear();
        this.dispose();
      });
      this.out = adopt(gen);

      pipelines.add(this);
      setStatus({ hooked: true });
    }

    dispose() {
      if (!pipelines.delete(this)) return;
      if (!pipelines.size) sound.stop();
    }

    process(frame, controller) {
      if (!NS.settings.enabled) {
        controller.enqueue(frame);
        return;
      }
      try {
        const now = performance.now();
        const W = frame.displayWidth, H = frame.displayHeight;
        if (W !== this.W || H !== this.H) {
          this.W = W;
          this.H = H;
          this.canvas = canvas(W, H);
          this.ctx = this.canvas.getContext('2d', { alpha: false });
        }
        const ctx = this.ctx;
        ctx.filter = fx.frameFilter(now / 1000);
        ctx.drawImage(frame, 0, 0, W, H);
        ctx.filter = 'none';

        sceneFor(W, H, now);
        detector.maybeDetect(frame, W, H, now);
        sound.poll(now);
        handleEvents(gestures.tick(now), now);
        fx.draw(ctx, frame, W, H, now / 1000, scene, NS.settings);
        if (NS.settings.showDebug) drawDebug(ctx, W, H);

        const out = new VideoFrame(this.canvas, { timestamp: frame.timestamp });
        frame.close();
        controller.enqueue(out);
      } catch (err) {
        console.warn('[Jaadu Snap] frame error', err);
        controller.enqueue(frame);
      }
    }
  }

  function drawDebug(ctx, W, H) {
    ctx.save();
    ctx.fillStyle = '#00e5ff';
    for (const hand of lastHands) {
      for (const [x, y] of hand.landmarks) ctx.fillRect(x * W - 3, y * H - 3, 6, 6);
    }
    const f = scene?.faceBox;
    if (f) {
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 2;
      ctx.strokeRect(f.x * W, f.y * H, f.w * W, f.h * H);
    }
    ctx.font = `${Math.round(H * 0.03)}px monospace`;
    ctx.fillStyle = '#fff';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 4;
    const lines = [
      `detector ${status.detector} ${status.backend || ''} | room ${status.room} | sound ${status.sound}`,
      `hands ${lastHands.length} | fx ${fx.active?.name || '-'}`,
    ];
    if (sound.lastLevel) {
      const { peak, floor } = sound.lastLevel;
      lines.push(`mic peak ${peak.toFixed(3)} floor ${floor.toFixed(4)} | last click ${((performance.now() - sound.lastClick) / 1000).toFixed(1)}s ago`);
    }
    for (const d of gestures.debug) lines.push(`${d.key}: pinch ${d.pinch.toFixed(2)} curl ${d.curl.toFixed(2)}`);
    lines.forEach((line, i) => ctx.fillText(line, 10, H * 0.05 + i * H * 0.04));
    ctx.restore();
  }

  MediaDevices.prototype.getUserMedia = async function getUserMedia(constraints) {
    const stream = await originalGUM.call(this, constraints);
    const [video] = stream.getVideoTracks();
    const [audio] = stream.getAudioTracks();
    if (audio) lastAudioDevice = audio.getSettings().deviceId || lastAudioDevice;
    if (!constraints?.video || !video) {
      // The call may get mic access after the camera is already running.
      if (audio && pipelines.size) sound.start(lastAudioDevice);
      return stream;
    }
    try {
      const pipeline = new Pipeline(video);
      sound.start(lastAudioDevice);
      return new MediaStream([pipeline.out, ...stream.getAudioTracks()]);
    } catch (err) {
      console.warn('[Jaadu Snap] could not wrap camera', err);
      return stream;
    }
  };

  post({ type: 'hello' });
})();

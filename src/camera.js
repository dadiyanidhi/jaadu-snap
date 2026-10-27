// Main-world script. Wraps getUserMedia so Meet receives a processed camera
// track: every frame is redrawn with the active effect, and a downscaled copy is
// sent to the detector iframe (MediaPipe, running in the extension's origin).
(() => {
  const NS = (window.__snapFX ||= {});
  if (NS.installed) return;
  NS.installed = true;

  if (!window.MediaDevices || !('MediaStreamTrackProcessor' in window) || !('MediaStreamTrackGenerator' in window)) {
    console.warn('[Meet Snap FX] This browser lacks insertable streams; effects disabled.');
    return;
  }

  const DETECT_W = 320;
  const PLATE_W = 640;
  const SHORTCUTS = { Digit1: 'dust', Digit2: 'cash', Digit3: 'cinema', Digit4: 'facepalm' };
  const GESTURE_FX = { snap: ['snap', 'dust'], doubleSnap: ['doubleSnap', 'cash'], cinema: ['cinema', 'cinema'], facepalm: ['facepalm', 'facepalm'] };

  NS.settings = {
    enabled: true, snap: true, doubleSnap: true, cinema: true, facepalm: true,
    sensitivity: 0.5, showDebug: false, cinemaText: 'ABSOLUTE CINEMA', facepalmText: 'bruh.', facepalmImage: null,
  };
  const status = { hooked: false, detector: 'idle', backend: null, error: null };
  const fx = new NS.FXManager();
  const gestures = new NS.GestureEngine();
  const pipelines = new Set();
  let active = null;
  let facepalmImageSrc = null;

  const post = (msg) => window.postMessage({ snapfx: true, ...msg }, location.origin);
  const reportStatus = () => post({ type: 'status', status: { ...status } });
  const canvas = (w, h) => new OffscreenCanvas(Math.max(1, w), Math.max(1, h));

  function applySettings(s) {
    NS.settings = { ...NS.settings, ...s };
    gestures.sensitivity = Number(NS.settings.sensitivity) || 0.5;
    gestures.doubleSnapMs = NS.settings.doubleSnap ? 650 : 0;
    if (!NS.settings.enabled) fx.active = null;
    if (NS.settings.facepalmImage !== facepalmImageSrc) {
      facepalmImageSrc = NS.settings.facepalmImage;
      fx.assets.facepalm = null;
      if (facepalmImageSrc) {
        const img = new Image();
        img.onload = () => createImageBitmap(img).then((bmp) => {
          if (facepalmImageSrc === NS.settings.facepalmImage) fx.assets.facepalm = bmp;
        });
        img.src = facepalmImageSrc;
      }
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.snapfx !== true) return;
    const m = e.data;
    if (m.type === 'settings') applySettings(m.settings);
    else if (m.type === 'trigger') active?.manual(m.name);
    else if (m.type === 'background') active?.background(m.action);
  });

  window.addEventListener('keydown', (e) => {
    const name = e.altKey && e.shiftKey && SHORTCUTS[e.code];
    if (!name || !active || !NS.settings.enabled) return;
    e.preventDefault();
    e.stopPropagation();
    active.manual(name);
  }, true);

  const detector = {
    frame: null,
    origin: null,
    ready: false,
    nextId: 1,
    pending: new Map(),

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
      status.detector = 'loading';
      reportStatus();
    },

    detect(image, opts) {
      const id = this.nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve(null);
        }, 1500);
        this.pending.set(id, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
        this.frame.contentWindow.postMessage(
          { type: 'detect', id, width: image.width, height: image.height, data: image.data.buffer, ...opts },
          this.origin,
          [image.data.buffer],
        );
      });
    },
  };

  window.addEventListener('message', (e) => {
    if (!detector.frame || e.source !== detector.frame.contentWindow || e.origin !== detector.origin) return;
    const m = e.data;
    if (m?.type === 'ready') {
      detector.ready = true;
      status.detector = 'ready';
      status.backend = m.backend;
      reportStatus();
    } else if (m?.type === 'error') {
      status.detector = 'error';
      status.error = m.message;
      reportStatus();
    } else if (m?.type === 'result') {
      const done = detector.pending.get(m.id);
      detector.pending.delete(m.id);
      done?.(m);
    }
  });

  class Pipeline {
    constructor(track) {
      this.src = track;
      this.W = 0;
      this.H = 0;
      this.inFlight = false;
      this.frameNo = 0;
      this.hands = [];
      this.captureFrom = 0;
      this.captureUntil = 0;

      const processor = new MediaStreamTrackProcessor({ track });
      const gen = new MediaStreamTrackGenerator({ kind: 'video' });
      processor.readable
        .pipeThrough(new TransformStream({ transform: (frame, c) => this.process(frame, c) }))
        .pipeTo(gen.writable)
        .catch(() => {});

      const stopGen = gen.stop.bind(gen);
      gen.stop = () => {
        track.stop();
        stopGen();
        this.dispose();
      };
      gen.getSettings = () => track.getSettings();
      gen.getCapabilities = () => track.getCapabilities();
      gen.getConstraints = () => track.getConstraints();
      gen.applyConstraints = (c) => track.applyConstraints(c);
      Object.defineProperty(gen, 'label', { get: () => track.label });
      track.addEventListener('ended', () => {
        stopGen();
        gen.dispatchEvent(new Event('ended'));
        this.dispose();
      });
      this.out = gen;

      pipelines.add(this);
      active = this;
      status.hooked = true;
      reportStatus();
    }

    dispose() {
      pipelines.delete(this);
      if (active === this) active = [...pipelines].pop() || null;
    }

    resize(W, H) {
      this.W = W;
      this.H = H;
      this.canvas = canvas(W, H);
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      const dh = Math.round(DETECT_W * H / W);
      this.detectCanvas = canvas(DETECT_W, dh);
      this.dctx = this.detectCanvas.getContext('2d', { willReadFrequently: true });
      const ph = Math.round(PLATE_W * H / W);
      this.pendingSent = canvas(PLATE_W, ph);
      this.tmp = canvas(PLATE_W, ph);
      this.scene = {
        sent: canvas(PLATE_W, ph),
        plate: canvas(PLATE_W, ph),
        mask: canvas(DETECT_W, dh),
        hasMask: false,
        plateReady: false,
        faceBox: null,
      };
      fx.active = null;
    }

    process(frame, controller) {
      if (!NS.settings.enabled) {
        controller.enqueue(frame);
        return;
      }
      try {
        const now = performance.now();
        const W = frame.displayWidth, H = frame.displayHeight;
        if (W !== this.W || H !== this.H) this.resize(W, H);
        const ctx = this.ctx;
        ctx.filter = fx.frameFilter(now / 1000);
        ctx.drawImage(frame, 0, 0, W, H);
        ctx.filter = 'none';

        if (this === active) {
          this.maybeDetect(frame);
          for (const ev of gestures.tick(now)) this.onGesture(ev, now);
        }
        fx.draw(ctx, frame, W, H, now / 1000, this.scene, NS.settings);
        if (NS.settings.showDebug) this.drawDebug(ctx, W, H);

        const out = new VideoFrame(this.canvas, { timestamp: frame.timestamp });
        frame.close();
        controller.enqueue(out);
      } catch (err) {
        console.warn('[Meet Snap FX] frame error', err);
        controller.enqueue(frame);
      }
    }

    maybeDetect(frame) {
      if (this.inFlight) return;
      detector.ensure();
      if (!detector.ready) return;
      const { width: dw, height: dh } = this.detectCanvas;
      this.dctx.drawImage(frame, 0, 0, dw, dh);
      const image = this.dctx.getImageData(0, 0, dw, dh);
      this.pendingSent.getContext('2d').drawImage(frame, 0, 0, this.pendingSent.width, this.pendingSent.height);
      this.frameNo++;
      this.inFlight = true;
      detector.detect(image, { wantFace: this.frameNo % 3 === 1, wantMask: this.frameNo % 2 === 1 }).then((res) => {
        this.inFlight = false;
        if (res && this.W === frame.displayWidth) this.onResult(res);
      });
    }

    onResult(res) {
      const now = performance.now();
      const scene = this.scene;
      if (res.faces?.length) scene.faceBox = res.faces[0];
      if (res.mask) {
        const { width: mw, height: mh, data } = res.mask;
        const alpha = new Uint8Array(data);
        const img = new ImageData(mw, mh);
        for (let i = 0; i < alpha.length; i++) {
          const o = i * 4;
          img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
          img.data[o + 3] = alpha[i];
        }
        if (scene.mask.width !== mw || scene.mask.height !== mh) scene.mask = canvas(mw, mh);
        scene.mask.getContext('2d').putImageData(img, 0, 0);
        scene.hasMask = true;
        const s = scene.sent.getContext('2d');
        s.clearRect(0, 0, scene.sent.width, scene.sent.height);
        s.drawImage(this.pendingSent, 0, 0);
        this.updatePlate(now);
      }
      this.hands = res.hands;
      const events = gestures.update(now, res.hands, res.faces || [], this.W / this.H);
      if (gestures.cinemaActive) fx.keepCinema(now / 1000);
      for (const ev of events) this.onGesture(ev, now);
    }

    // Keeps a running picture of the room with the person cut out, used to
    // fill the gap when they turn to dust.
    updatePlate(now) {
      const { plate, sent, mask } = this.scene;
      const pw = plate.width, ph = plate.height;
      const p = plate.getContext('2d');

      if (now >= this.captureFrom && now <= this.captureUntil) {
        p.drawImage(sent, 0, 0);
        this.scene.plateReady = true;
        return;
      }

      const t = this.tmp.getContext('2d');
      t.globalCompositeOperation = 'source-over';
      t.clearRect(0, 0, pw, ph);
      t.drawImage(sent, 0, 0);
      t.globalCompositeOperation = 'destination-out';
      t.drawImage(mask, 0, 0, pw, ph);
      t.globalCompositeOperation = 'source-over';

      if (!this.scene.plateReady) {
        const avg = canvas(1, 1).getContext('2d', { willReadFrequently: true });
        avg.drawImage(this.tmp, 0, 0, 1, 1);
        const [r, g, b] = avg.getImageData(0, 0, 1, 1).data;
        p.fillStyle = `rgb(${r},${g},${b})`;
        p.fillRect(0, 0, pw, ph);
        for (const radius of [60, 30, 15]) {
          p.filter = `blur(${radius}px)`;
          for (let i = 0; i < 3; i++) p.drawImage(this.tmp, 0, 0);
        }
        p.filter = 'none';
        p.drawImage(this.tmp, 0, 0);
        this.scene.plateReady = true;
        return;
      }
      p.globalAlpha = 0.6;
      p.drawImage(this.tmp, 0, 0);
      p.globalAlpha = 1;
    }

    // Before the detector has produced a mask, fall back to the current frame
    // and a blurred copy of it so manual triggers still render something.
    prepareScene() {
      const { sent, plate } = this.scene;
      if (!this.scene.hasMask) sent.getContext('2d').drawImage(this.canvas, 0, 0, sent.width, sent.height);
      if (!this.scene.plateReady) {
        const p = plate.getContext('2d');
        p.filter = 'blur(30px)';
        p.drawImage(sent, 0, 0);
        p.filter = 'none';
      }
    }

    onGesture(ev, now) {
      const [setting, name] = GESTURE_FX[ev];
      if (!NS.settings[setting]) return;
      this.prepareScene();
      fx.trigger(name, now / 1000, this.scene, this.W, this.H);
    }

    manual(name) {
      if (!this.W) return;
      this.prepareScene();
      fx.trigger(name, performance.now() / 1000, this.scene, this.W, this.H, true);
    }

    background(action) {
      if (!this.scene) return;
      if (action === 'reset') this.scene.plateReady = false;
      if (action === 'capture') {
        this.captureFrom = performance.now() + 3000;
        this.captureUntil = this.captureFrom + 1500;
      }
    }

    drawDebug(ctx, W, H) {
      ctx.save();
      ctx.fillStyle = '#00e5ff';
      for (const hand of this.hands) {
        for (const [x, y] of hand.landmarks) ctx.fillRect(x * W - 3, y * H - 3, 6, 6);
      }
      const f = this.scene.faceBox;
      if (f) {
        ctx.strokeStyle = '#ffd400';
        ctx.lineWidth = 2;
        ctx.strokeRect(f.x * W, f.y * H, f.w * W, f.h * H);
      }
      ctx.font = `${Math.round(H * 0.03)}px monospace`;
      ctx.fillStyle = '#fff';
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 4;
      let y = H * 0.05;
      ctx.fillText(`detector: ${status.detector} ${status.backend || ''}  hands: ${this.hands.length}  fx: ${fx.active?.name || '-'}`, 10, y);
      for (const d of gestures.debug) {
        y += H * 0.04;
        ctx.fillText(`${d.key}: pinch ${d.pinch.toFixed(2)} curl ${d.curl.toFixed(2)}${d.touching ? ' (touch)' : ''}`, 10, y);
      }
      ctx.restore();
    }
  }

  const proto = MediaDevices.prototype;
  const originalGUM = proto.getUserMedia;
  proto.getUserMedia = async function getUserMedia(constraints) {
    const stream = await originalGUM.call(this, constraints);
    const [video] = stream.getVideoTracks();
    if (!constraints?.video || !video) return stream;
    try {
      const pipeline = new Pipeline(video);
      return new MediaStream([pipeline.out, ...stream.getAudioTracks()]);
    } catch (err) {
      console.warn('[Meet Snap FX] could not wrap camera', err);
      return stream;
    }
  };

  post({ type: 'hello' });
})();

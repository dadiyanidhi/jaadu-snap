// Runs inside a hidden extension iframe on meet.google.com. Meet's page enforces
// Trusted Types, which blocks MediaPipe's loader, so inference happens here in
// the extension's own origin and only landmarks + a small mask go back.
import { FaceDetector, HandLandmarker, ImageSegmenter } from '../vendor/vision_bundle.mjs';

const PARENT_ORIGIN = 'https://meet.google.com';
const url = (path) => new URL(path, import.meta.url).href;
const fileset = {
  wasmLoaderPath: url('../vendor/wasm/vision_wasm_internal.js'),
  wasmBinaryPath: url('../vendor/wasm/vision_wasm_internal.wasm'),
};

let hands, segmenter, faces, backend;
let lastTs = 0;

const reply = (msg, transfer = []) => parent.postMessage(msg, PARENT_ORIGIN, transfer);

async function create(Task, modelPath, options, delegate) {
  return Task.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: url(modelPath), delegate },
    runningMode: 'VIDEO',
    ...options,
  });
}

async function createAll(delegate) {
  return Promise.all([
    create(HandLandmarker, '../models/hand_landmarker.task', {
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }, delegate),
    create(ImageSegmenter, '../models/selfie_segmenter.tflite', {
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    }, delegate),
    create(FaceDetector, '../models/blaze_face_short_range.tflite', {
      minDetectionConfidence: 0.65,
    }, delegate),
  ]);
}

const WIDE_MARGIN = 0.045;

// Grows a 0/255 mask by r pixels in every direction (square box, via running sums).
function dilate(src, w, h, r) {
  const rows = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = -r; x < w + r; x++) {
      if (x + r < w && src[y * w + x + r]) count++;
      if (x - r - 1 >= 0 && src[y * w + x - r - 1]) count--;
      if (x >= 0 && x < w) rows[y * w + x] = count > 0 ? 255 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = -r; y < h + r; y++) {
      if (y + r < h && rows[(y + r) * w + x]) count++;
      if (y - r - 1 >= 0 && rows[(y - r - 1) * w + x]) count--;
      if (y >= 0 && y < h) out[y * w + x] = count > 0 ? 255 : 0;
    }
  }
  return out;
}

// Two person masks: a snug one for cutting the person out of a frame, and a
// wide one (generous margin, low threshold) that marks where pixels can't be
// trusted as room. Light clothes against a light wall get low confidence, so
// the wide mask errs heavily towards "person".
function toMasks(conf, w, h) {
  const snug = new Uint8Array(w * h);
  const loose = new Uint8Array(w * h);
  for (let i = 0; i < snug.length; i++) {
    snug[i] = conf[i] > 0.25 ? 255 : 0;
    loose[i] = conf[i] > 0.12 ? 255 : 0;
  }
  return { mask: dilate(snug, w, h, 2), wide: dilate(loose, w, h, Math.round(w * WIDE_MARGIN)) };
}

function detect(msg) {
  const image = new ImageData(new Uint8ClampedArray(msg.data), msg.width, msg.height);
  const ts = Math.max(lastTs + 1, performance.now());
  lastTs = ts;
  const out = { type: 'result', id: msg.id, hands: [], faces: null, mask: null };
  const transfer = [];

  const hr = hands.detectForVideo(image, ts);
  out.hands = hr.landmarks.map((lm, i) => ({
    handedness: hr.handedness[i]?.[0]?.categoryName || `hand${i}`,
    landmarks: lm.map((p) => [p.x, p.y]),
  }));

  if (msg.wantFace) {
    const fr = faces.detectForVideo(image, ts);
    out.faces = fr.detections.map((d) => ({
      x: d.boundingBox.originX / msg.width,
      y: d.boundingBox.originY / msg.height,
      w: d.boundingBox.width / msg.width,
      h: d.boundingBox.height / msg.height,
    }));
  }

  if (msg.wantMask) {
    segmenter.segmentForVideo(image, ts, (result) => {
      const m = result.confidenceMasks?.[0];
      if (!m) return;
      const { mask, wide } = toMasks(m.getAsFloat32Array(), m.width, m.height);
      out.mask = { width: m.width, height: m.height, data: mask.buffer, wide: wide.buffer };
      transfer.push(mask.buffer, wide.buffer);
    });
  }

  reply(out, transfer);
}

let inpaintWorker = null;

function inpaint(msg) {
  if (!inpaintWorker) {
    inpaintWorker = new Worker(url('inpaint-worker.js'), { type: 'module' });
    inpaintWorker.onmessage = (e) => {
      const m = e.data;
      reply({ type: 'inpainted', ...m }, m.data ? [m.data] : []);
    };
    inpaintWorker.onerror = (e) => reply({ type: 'inpainted', id: msg.id, error: e.message || 'inpaint worker failed' });
  }
  inpaintWorker.postMessage(msg, [msg.data]);
}

async function init() {
  if (!location.ancestorOrigins?.length || location.ancestorOrigins[0] !== PARENT_ORIGIN) return;
  try {
    try {
      [hands, segmenter, faces] = await createAll('GPU');
      backend = 'GPU';
    } catch (gpuErr) {
      console.warn('[Meet Snap FX] GPU delegate failed, using CPU', gpuErr);
      [hands, segmenter, faces] = await createAll('CPU');
      backend = 'CPU';
    }
  } catch (err) {
    reply({ type: 'error', message: String(err?.message || err) });
    return;
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== PARENT_ORIGIN || e.source !== parent) return;
    if (e.data?.type === 'inpaint') {
      inpaint(e.data);
      return;
    }
    if (e.data?.type !== 'detect') return;
    try {
      detect(e.data);
    } catch (err) {
      reply({ type: 'result', id: e.data.id, hands: [], faces: null, mask: null, error: String(err) });
    }
  });
  reply({ type: 'ready', backend });
}

init();

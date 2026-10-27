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
      minDetectionConfidence: 0.5,
    }, delegate),
  ]);
}

// Binary person mask, dilated so the cut-out fully covers the person's edges.
function toMask(conf, w, h) {
  let a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = conf[i] > 0.25 ? 255 : 0;
  for (let pass = 0; pass < 3; pass++) {
    const b = new Uint8Array(a.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        b[i] = a[i] || (x > 0 && a[i - 1]) || (x < w - 1 && a[i + 1])
          || (y > 0 && a[i - w]) || (y < h - 1 && a[i + w]) ? 255 : 0;
      }
    }
    a = b;
  }
  return a;
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
      const mask = toMask(m.getAsFloat32Array(), m.width, m.height);
      out.mask = { width: m.width, height: m.height, data: mask.buffer };
      transfer.push(mask.buffer);
    });
  }

  reply(out, transfer);
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
    if (e.origin !== PARENT_ORIGIN || e.source !== parent || e.data?.type !== 'detect') return;
    try {
      detect(e.data);
    } catch (err) {
      reply({ type: 'result', id: e.data.id, hands: [], faces: null, mask: null, error: String(err) });
    }
  });
  reply({ type: 'ready', backend });
}

init();

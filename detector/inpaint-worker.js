// Fills in the parts of the room that were hidden behind the person, using the
// MI-GAN inpainting model. Input is RGBA where alpha marks pixels actually seen.
import * as ort from '../vendor/onnx/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = new URL('../vendor/onnx/', import.meta.url).href;
ort.env.wasm.numThreads = 1;

const SEEN_ALPHA = 230;
const HOLE_GROW = 6;

let session = null;

const load = () => (session ??= ort.InferenceSession.create(
  new URL('../models/migan_pipeline_v2.onnx', import.meta.url).href,
  { executionProviders: ['wasm'] },
));

// Grows the unseen area a little so smeared person edges get repainted too.
function keepMask(rgba, w, h) {
  let keep = new Uint8Array(w * h);
  for (let i = 0; i < keep.length; i++) keep[i] = rgba[i * 4 + 3] >= SEEN_ALPHA ? 255 : 0;
  for (let pass = 0; pass < HOLE_GROW; pass++) {
    const next = new Uint8Array(keep);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (keep[i] && ((x > 0 && !keep[i - 1]) || (x < w - 1 && !keep[i + 1])
          || (y > 0 && !keep[i - w]) || (y < h - 1 && !keep[i + w]))) next[i] = 0;
      }
    }
    keep = next;
  }
  return keep;
}

// Box blur of a w×h plane (separable running sums, edges clamped by skipping).
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x < w + r; x++) {
      if (x + r < w) s += src[y * w + x + r] || 0;
      if (x - r - 1 >= 0) s -= src[y * w + x - r - 1];
      if (x >= 0 && x < w) tmp[y * w + x] = s;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y < h + r; y++) {
      if (y + r < h) s += tmp[(y + r) * w + x] || 0;
      if (y - r - 1 >= 0) s -= tmp[(y - r - 1) * w + x];
      if (y >= 0 && y < h) out[y * w + x] = s;
    }
  }
  return out;
}

// Seeds the holes with smoothed colours from the surrounding room so the model
// gets sensible hints and the hole edge doesn't show as a seam.
function prefill(image, keep, w, h) {
  const n = w * h;
  const weight = new Float32Array(n);
  const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    weight[i] = 1;
    for (let c = 0; c < 3; c++) planes[c][i] = image[c * n + i];
  }
  const todo = Uint8Array.from(keep, (k) => (k ? 0 : 1));
  for (const r of [8, 24, 64, 160]) {
    const wsum = boxBlur(weight, w, h, r);
    const sums = planes.map((p) => boxBlur(p, w, h, r));
    for (let i = 0; i < n; i++) {
      if (!todo[i] || wsum[i] < 0.5) continue;
      for (let c = 0; c < 3; c++) image[c * n + i] = sums[c][i] / wsum[i];
      todo[i] = 0;
    }
  }
}

self.onmessage = async (e) => {
  const { id, width: w, height: h, data } = e.data;
  try {
    await load();
    const rgba = new Uint8ClampedArray(data);
    const n = w * h;
    const mask = keepMask(rgba, w, h);
    const image = new Uint8Array(3 * n);
    for (let i = 0; i < n; i++) {
      image[i] = rgba[i * 4];
      image[n + i] = rgba[i * 4 + 1];
      image[2 * n + i] = rgba[i * 4 + 2];
    }
    prefill(image, mask, w, h);
    const { result } = await (await session).run({
      image: new ort.Tensor('uint8', image, [1, 3, h, w]),
      mask: new ort.Tensor('uint8', mask, [1, 1, h, w]),
    });
    const out = new Uint8ClampedArray(4 * n);
    const r = result.data;
    for (let i = 0; i < n; i++) {
      out[i * 4] = r[i];
      out[i * 4 + 1] = r[n + i];
      out[i * 4 + 2] = r[2 * n + i];
      out[i * 4 + 3] = 255;
    }
    self.postMessage({ id, width: w, height: h, data: out.buffer }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};

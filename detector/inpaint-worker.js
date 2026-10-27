// Fills in the parts of the room that were hidden behind the person, using the
// MI-GAN inpainting model. Input is RGBA where alpha marks pixels actually seen.
import * as ort from '../vendor/onnx/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = new URL('../vendor/onnx/', import.meta.url).href;
ort.env.wasm.numThreads = 1;

const SEEN_ALPHA = 230;
const HOLE_GROW = 6;
const MODEL_DEPTH = 0.05;

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

// Smoothly fills holes from the surrounding seen pixels (push-pull pyramid:
// average down until every cell has data, then blend back up bilinearly).
// Gives the model sensible colour hints and a seamless base deep in a hole.
function prefill(image, keep, w, h) {
  const n = w * h;
  const level = { w, h, wt: new Float32Array(n), c: [new Float32Array(n), new Float32Array(n), new Float32Array(n)] };
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    level.wt[i] = 1;
    for (let k = 0; k < 3; k++) level.c[k][i] = image[k * n + i];
  }
  const levels = [level];
  while (levels.at(-1).w > 1 || levels.at(-1).h > 1) {
    const f = levels.at(-1);
    const cw = Math.ceil(f.w / 2), ch = Math.ceil(f.h / 2);
    const next = { w: cw, h: ch, wt: new Float32Array(cw * ch), c: [new Float32Array(cw * ch), new Float32Array(cw * ch), new Float32Array(cw * ch)] };
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x, j = (y >> 1) * cw + (x >> 1);
        next.wt[j] += f.wt[i];
        for (let k = 0; k < 3; k++) next.c[k][j] += f.c[k][i];
      }
    }
    for (let j = 0; j < cw * ch; j++) {
      if (next.wt[j] <= 1) continue;
      const s = 1 / next.wt[j];
      for (let k = 0; k < 3; k++) next.c[k][j] *= s;
      next.wt[j] = 1;
    }
    levels.push(next);
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], c = levels[l + 1];
    for (let y = 0; y < f.h; y++) {
      const cy = Math.min(c.h - 1, Math.max(0, (y - 0.5) / 2)), y0 = Math.floor(cy), y1 = Math.min(c.h - 1, y0 + 1), fy = cy - y0;
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x;
        const missing = 1 - Math.min(1, f.wt[i]);
        if (missing <= 0) continue;
        const cx = Math.min(c.w - 1, Math.max(0, (x - 0.5) / 2)), x0 = Math.floor(cx), x1 = Math.min(c.w - 1, x0 + 1), fx = cx - x0;
        const a = y0 * c.w + x0, b = y0 * c.w + x1, d = y1 * c.w + x0, e = y1 * c.w + x1;
        for (let k = 0; k < 3; k++) {
          const cc = c.c[k];
          const up = (cc[a] * (1 - fx) + cc[b] * fx) * (1 - fy) + (cc[d] * (1 - fx) + cc[e] * fx) * fy;
          f.c[k][i] += up * missing;
        }
        f.wt[i] = 1;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (keep[i]) continue;
    for (let k = 0; k < 3; k++) image[k * n + i] = level.c[k][i];
  }
}

// Distance (in pixels, chamfer approximation) from each hole pixel to the
// nearest seen pixel.
function holeDistance(keep, w, h) {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = keep[i] ? 0 : 1e9;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 1e9 : d[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414);
    }
  }
  return d;
}

// Standard deviation of fine detail (pixel minus its 3x3 neighbourhood) over
// seen pixels, so the smooth fill can be given the same grain as the room.
function grainLevel(image, keep, w, h) {
  const n = w * h;
  let sum = 0, count = 0;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      if (!keep[i] || !keep[i - 1] || !keep[i + 1] || !keep[i - w] || !keep[i + w]) continue;
      for (let k = 0; k < 3; k++) {
        const p = image[k * n + i];
        const avg = (image[k * n + i - 1] + image[k * n + i + 1] + image[k * n + i - w] + image[k * n + i + w]) / 4;
        sum += (p - avg) * (p - avg);
        count++;
      }
    }
  }
  return count ? Math.min(12, Math.sqrt(sum / count)) : 0;
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
    const grain = grainLevel(image, mask, w, h) * 0.8;
    prefill(image, mask, w, h);
    const smooth = image.slice();
    const { result } = await (await session).run({
      image: new ort.Tensor('uint8', image, [1, 3, h, w]),
      mask: new ort.Tensor('uint8', mask, [1, 1, h, w]),
    });
    // The model continues texture well near the hole's edge but invents dark
    // shapes deep inside a person-sized hole, so blend towards the smooth
    // colour interpolation with depth.
    const depth = holeDistance(mask, w, h);
    const reach = Math.max(4, w * MODEL_DEPTH);
    const out = new Uint8ClampedArray(4 * n);
    const r = result.data;
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, depth[i] / reach);
      const k = t * t * (3 - 2 * t);
      const noise = k ? (Math.random() + Math.random() + Math.random() - 1.5) * 2 * grain * k : 0;
      for (let c = 0; c < 3; c++) out[i * 4 + c] = r[c * n + i] * (1 - k) + smooth[c * n + i] * k + noise;
      out[i * 4 + 3] = 255;
    }
    self.postMessage({ id, width: w, height: h, data: out.buffer }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};

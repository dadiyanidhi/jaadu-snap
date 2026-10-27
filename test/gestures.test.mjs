// Run: node test/gestures.test.mjs
import assert from 'node:assert/strict';
import '../src/gestures.js';

const { GestureEngine } = globalThis.__snapFX;
const ASPECT = 16 / 9;

// Builds a 21-point hand. Wrist at (wx, wy); hand size `s` in height units.
function hand({ wx = 0.5, wy = 0.7, s = 0.12, pose }) {
  const lm = Array.from({ length: 21 }, () => [wx, wy]);
  const at = (i, dx, dy) => { lm[i] = [wx + (dx * s) / ASPECT, wy + dy * s]; };
  at(9, 0, -1);
  at(5, -0.3, -0.95); at(13, 0.25, -0.95); at(17, 0.5, -0.85);
  const fingers = { 8: [-0.35, 6], 12: [0, 10], 16: [0.3, 14], 20: [0.55, 18] };
  for (const [tip, [x, pip]] of Object.entries(fingers)) {
    at(pip, x, -1.4);
    at(+tip, x, pose === 'fist' ? -0.9 : -1.95);
  }
  at(4, -0.7, -0.6);
  if (pose === 'pinch') { at(12, -0.3, -1.1); at(4, -0.32, -1.1); }
  if (pose === 'snapped') { at(12, 0, -0.9); at(4, -0.75, -1.3); }
  return lm;
}
const H = (lm, handedness = 'Right') => ({ handedness, landmarks: lm });

function run(engine, seq) {
  const events = [];
  for (const [t, hands, faces = []] of seq) events.push(...engine.update(t, hands, faces, ASPECT));
  return events;
}

{
  const e = new GestureEngine();
  const ev = run(e, [[0, [H(hand({ pose: 'pinch' }))]], [60, [H(hand({ pose: 'pinch' }))]], [120, [H(hand({ pose: 'snapped' }))]], [900, []]]);
  assert.deepEqual(ev, ['snap'], 'single snap');
}
{
  const e = new GestureEngine();
  const ev = run(e, [
    [0, [H(hand({ pose: 'pinch' }))]], [100, [H(hand({ pose: 'snapped' }))]],
    [300, [H(hand({ pose: 'pinch' }))]], [400, [H(hand({ pose: 'snapped' }))]], [1500, []],
  ]);
  assert.deepEqual(ev, ['doubleSnap'], 'double snap');
}
{
  const e = new GestureEngine();
  const ev = run(e, [[0, [H(hand({ pose: 'pinch' }))]], [100, [H(hand({ pose: 'open' }))]], [1000, []]]);
  assert.deepEqual(ev, [], 'opening a pinch with the finger extended is not a snap');
}
{
  const e = new GestureEngine();
  const ev = run(e, [[0, [H(hand({ pose: 'pinch' }))]], [900, [H(hand({ pose: 'snapped' }))]], [2000, []]]);
  assert.deepEqual(ev, [], 'slow release is not a snap');
}
{
  const e = new GestureEngine();
  const up = [H(hand({ wx: 0.2, wy: 0.6, pose: 'open' }), 'Left'), H(hand({ wx: 0.8, wy: 0.6, pose: 'open' }), 'Right')];
  const ev = run(e, [[0, up], [200, up], [500, up], [700, up]]);
  assert.deepEqual(ev, ['cinema'], 'both hands up fires once');
  assert.equal(e.cinemaActive, true);
  run(e, [[800, []]]);
  assert.equal(e.cinemaActive, false);
}
{
  const e = new GestureEngine();
  const face = { x: 0.4, y: 0.2, w: 0.2, h: 0.35 };
  const palm = H(hand({ wx: 0.5, wy: 0.55, s: 0.25, pose: 'open' }));
  const ev = run(e, [[0, [], [face]], [100, [palm]], [400, [palm]], [700, [palm]], [900, [palm]]]);
  assert.deepEqual(ev, ['facepalm'], 'facepalm fires once while held');
}
{
  const e = new GestureEngine();
  const face = { x: 0.4, y: 0.2, w: 0.2, h: 0.35 };
  const far = H(hand({ wx: 0.15, wy: 0.9, pose: 'open' }));
  assert.deepEqual(run(e, [[0, [], [face]], [100, [far]], [800, [far]]]), [], 'hand away from face is not a facepalm');
}
console.log('gesture tests passed');

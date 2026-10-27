// Turns MediaPipe hand/face results into gesture events.
// Landmarks are normalized [x, y] pairs (0..1). `aspect` = width / height,
// used so distances are measured in square units.
(() => {
  const NS = (globalThis.__snapFX ||= {});

  const WRIST = 0, THUMB_TIP = 4, MIDDLE_MCP = 9, MIDDLE_TIP = 12;
  const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]];
  const PALM = [0, 5, 9, 13, 17];

  const SOUND_SYNC_MS = 400;

  const dist = (a, b, aspect) => Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]);

  function palmCenter(lm) {
    let x = 0, y = 0;
    for (const i of PALM) { x += lm[i][0]; y += lm[i][1]; }
    return [x / PALM.length, y / PALM.length];
  }

  function inBox([x, y], box, pad) {
    const px = box.w * pad, py = box.h * pad;
    return x > box.x - px && x < box.x + box.w + px && y > box.y - py && y < box.y + box.h + py;
  }

  function isOpenUp(lm, aspect) {
    let extended = 0;
    for (const [tip, pip] of FINGERS) {
      if (dist(lm[tip], lm[WRIST], aspect) > dist(lm[pip], lm[WRIST], aspect) * 1.1) extended++;
    }
    return extended >= 3 && lm[MIDDLE_TIP][1] < lm[WRIST][1];
  }

  class GestureEngine {
    constructor() {
      this.sensitivity = 0.5;
      this.doubleSnapMs = 650;
      this.hands = new Map();
      this.lastSnapAt = -Infinity;
      this.useSound = false;
      this.clickAt = -Infinity;
      this.releaseAt = -Infinity;
      this.pendingSnapAt = null;
      this.cinemaSince = null;
      this.cinemaFired = false;
      this.cinemaActive = false;
      this.facepalmSince = null;
      this.facepalmFired = false;
      this.lastFace = null;
      this.debug = [];
    }

    // Called on every detection result. Returns gesture events.
    update(now, hands, faces, aspect) {
      const events = [];
      const s = this.sensitivity;
      const touchMax = 0.3 + 0.2 * s;
      const releaseMin = 0.75 - 0.15 * s;
      const curlMax = 1.35 + 0.35 * s;
      const touchWindow = 300 + 200 * s;

      // Only trust a face box seen with no hand on it: the face detector can
      // mistake a hand for a face, which would make every hand a facepalm.
      if (faces.length && !hands.some((h) => inBox(palmCenter(h.landmarks), faces[0], 0.1))) {
        this.lastFace = { box: faces[0], at: now };
      }
      this.debug = [];

      const seen = new Set();
      for (const hand of hands) {
        const lm = hand.landmarks;
        const key = hand.handedness;
        seen.add(key);
        const st = this.hands.get(key) || { touching: false, touchAt: -Infinity };
        st.seenAt = now;
        this.hands.set(key, st);

        const scale = dist(lm[WRIST], lm[MIDDLE_MCP], aspect);
        if (scale < 0.02) continue;
        const pinch = dist(lm[THUMB_TIP], lm[MIDDLE_TIP], aspect) / scale;
        const curl = dist(lm[MIDDLE_TIP], lm[WRIST], aspect) / scale;
        this.debug.push({ key, pinch, curl, touching: st.touching });

        if (pinch < touchMax) {
          st.touching = true;
          st.touchAt = now;
        } else if (st.touching && pinch > releaseMin) {
          st.touching = false;
          if (this.useSound) {
            if (now - st.touchAt < touchWindow) this.onRelease((now + st.touchAt) / 2, events);
          } else if (now - st.touchAt < touchWindow && curl < curlMax && now - this.lastSnapAt > 220) {
            this.lastSnapAt = now;
            this.onSnap(now, events);
          }
        }
      }
      for (const [key, st] of this.hands) {
        if (seen.has(key)) continue;
        // A snapping hand often blurs out of detection mid-snap.
        if (st.touching && now - st.touchAt < touchWindow) {
          st.touching = false;
          if (this.useSound) this.onRelease(st.touchAt, events);
        }
        if (now - st.seenAt > 1000) this.hands.delete(key);
      }

      this.updateCinema(now, hands, aspect, events);
      this.updateFacepalm(now, hands, aspect, events);
      this.tick(now, events);
      return events;
    }

    // With sound available, a snap is a sharp click from the mic within
    // SOUND_SYNC_MS of the camera seeing thumb and middle finger fly apart.
    // Either can arrive first, so each one checks for the other.
    onClick(now) {
      const events = [];
      if (this.useSound) {
        this.clickAt = now;
        this.matchSnap(now, events);
      }
      return events;
    }

    onRelease(at, events) {
      this.releaseAt = at;
      this.matchSnap(at, events);
    }

    matchSnap(now, events) {
      if (Math.abs(this.clickAt - this.releaseAt) > SOUND_SYNC_MS) return;
      if (Math.min(this.clickAt, this.releaseAt) - this.lastSnapAt < 250) return;
      this.lastSnapAt = Math.max(this.clickAt, this.releaseAt);
      this.onSnap(now, events);
    }

    onSnap(now, events) {
      if (this.pendingSnapAt !== null && now - this.pendingSnapAt < this.doubleSnapMs) {
        this.pendingSnapAt = null;
        events.push('doubleSnap');
      } else {
        this.pendingSnapAt = now;
      }
    }

    // Flushes a single snap once the double-snap window has passed.
    tick(now, events = []) {
      if (this.pendingSnapAt !== null && now - this.pendingSnapAt >= this.doubleSnapMs) {
        this.pendingSnapAt = null;
        events.push('snap');
      }
      return events;
    }

    updateCinema(now, hands, aspect, events) {
      let up = false;
      if (hands.length >= 2) {
        const [a, b] = hands;
        const ca = palmCenter(a.landmarks), cb = palmCenter(b.landmarks);
        up = isOpenUp(a.landmarks, aspect) && isOpenUp(b.landmarks, aspect)
          && Math.abs(ca[0] - cb[0]) > 0.25
          && a.landmarks[MIDDLE_TIP][1] < 0.7 && b.landmarks[MIDDLE_TIP][1] < 0.7;
      }
      if (!up) {
        this.cinemaSince = null;
        this.cinemaFired = false;
        this.cinemaActive = false;
        return;
      }
      this.cinemaSince ??= now;
      if (now - this.cinemaSince > 400) {
        this.cinemaActive = true;
        if (!this.cinemaFired) {
          this.cinemaFired = true;
          events.push('cinema');
        }
      }
    }

    updateFacepalm(now, hands, aspect, events) {
      const face = this.lastFace && now - this.lastFace.at < 3000 ? this.lastFace.box : null;
      let covering = false;
      if (face && hands.length >= 1 && !this.cinemaActive) {
        for (const hand of hands) {
          const lm = hand.landmarks;
          const scale = dist(lm[WRIST], lm[MIDDLE_MCP], aspect);
          const inFace = inBox(palmCenter(lm), face, 0.2);
          const snapPose = dist(lm[THUMB_TIP], lm[MIDDLE_TIP], aspect) / scale < 0.6;
          if (inFace && !snapPose && scale > face.w * aspect * 0.3) covering = true;
        }
      }
      if (!covering) {
        this.facepalmSince = null;
        this.facepalmFired = false;
        return;
      }
      this.facepalmSince ??= now;
      if (!this.facepalmFired && now - this.facepalmSince > 500) {
        this.facepalmFired = true;
        events.push('facepalm');
      }
    }
  }

  NS.GestureEngine = GestureEngine;
})();

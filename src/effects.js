// The four effects, drawn straight into the outgoing camera frames.
// Times passed to effects are seconds since the effect started.
(() => {
  const NS = (globalThis.__snapFX ||= {});

  const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const easeOut = (p) => 1 - Math.pow(1 - clamp01(p), 3);
  const canvas = (w, h) => new OffscreenCanvas(Math.max(1, w), Math.max(1, h));

  // Paints the learned empty room over wherever the person currently is.
  function hidePerson(ctx, scene, W, H, alpha) {
    if (alpha <= 0) return;
    const { width: pw, height: ph } = scene.room;
    const layer = (scene._hideLayer ||= canvas(pw, ph));
    const l = layer.getContext('2d');
    l.globalCompositeOperation = 'source-over';
    l.clearRect(0, 0, pw, ph);
    // The wide mask leaves a margin of real wall around the person, so a soft
    // edge there blends into the live frame without showing a seam.
    l.filter = `blur(${Math.round(pw * 0.012)}px)`;
    l.drawImage(scene.wide, 0, 0, pw, ph);
    l.filter = 'none';
    l.globalCompositeOperation = 'source-in';
    l.drawImage(scene.room, 0, 0);
    l.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;
    ctx.drawImage(layer, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  // Snap: the person is frozen and blown away as dust, Endgame style, and
  // stays gone until the next snap brings the dust back together.
  class DustEffect {
    static TILE = 6;
    static FADE_BACK = 0.5;

    static canStart(scene) {
      return scene.hasMask;
    }

    start(scene) {
      const { width: pw, height: ph } = scene.sent;
      this.pw = pw;
      this.ph = ph;
      this.snapshot = canvas(pw, ph);
      const s = this.snapshot.getContext('2d', { willReadFrequently: true });
      s.drawImage(scene.mask, 0, 0, pw, ph);
      s.globalCompositeOperation = 'source-in';
      s.drawImage(scene.sent, 0, 0, pw, ph);

      const T = DustEffect.TILE;
      const alpha = s.getImageData(0, 0, pw, ph).data;
      this.tiles = [];
      this.vanishEnd = 0;
      for (let y = 0; y < ph; y += T) {
        for (let x = 0; x < pw; x += T) {
          const cx = Math.min(pw - 1, x + (T >> 1)), cy = Math.min(ph - 1, y + (T >> 1));
          if (alpha[(cy * pw + cx) * 4 + 3] < 100) continue;
          const tile = {
            x, y,
            delay: 0.15 + (x / pw) * 1.1 + (1 - y / ph) * 0.25 + rand(0, 0.9),
            life: rand(1.4, 2.4),
            vx: rand(25, 90), vy: rand(-70, -20),
            ax: rand(20, 70), ay: rand(-40, -5),
            wobble: rand(6, 18), phase: rand(0, Math.PI * 2),
            back: 0.1 + (1 - x / pw) * 0.5 + rand(0, 0.5),
          };
          this.vanishEnd = Math.max(this.vanishEnd, tile.delay + tile.life);
          this.tiles.push(tile);
        }
      }
      this.returnAt = null;
    }

    reappear(t) {
      if (this.returnAt !== null) return;
      this.returnAt = Math.max(t, this.vanishEnd);
      this.returnEnd = 0;
      for (const p of this.tiles) this.returnEnd = Math.max(this.returnEnd, p.back + p.life * 0.55);
    }

    offset(p, age) {
      return [
        p.vx * age + 0.5 * p.ax * age * age + Math.sin(p.phase + age * 4) * p.wobble * age,
        p.vy * age + 0.5 * p.ay * age * age,
      ];
    }

    draw(ctx, frame, W, H, t, scene) {
      const T = DustEffect.TILE;
      const kx = W / this.pw, ky = H / this.ph;
      const returning = this.returnAt !== null && t >= this.returnAt;
      const tr = returning ? t - this.returnAt : 0;
      const fade = returning ? clamp01((tr - this.returnEnd) / DustEffect.FADE_BACK) : 0;
      if (fade >= 1) return false;

      hidePerson(ctx, scene, W, H, 1 - fade);

      const ash = [[], [], [], []];
      for (const p of this.tiles) {
        if (returning) {
          const life = p.life * 0.55;
          const left = life - (tr - p.back);
          if (left >= life) continue;
          if (left <= 0) {
            ctx.globalAlpha = 1 - fade;
            ctx.drawImage(this.snapshot, p.x, p.y, T, T, p.x * kx, p.y * ky, T * kx + 0.75, T * ky + 0.75);
            continue;
          }
          const q = left / life;
          const [dx, dy] = this.offset(p, q * p.life);
          ctx.globalAlpha = 1 - q;
          const size = T * kx * (1 - 0.5 * q);
          ctx.drawImage(this.snapshot, p.x, p.y, T, T, (p.x + dx) * kx, (p.y + dy) * ky, size, size);
          continue;
        }

        const age = t - p.delay;
        if (age < 0) {
          ctx.drawImage(this.snapshot, p.x, p.y, T, T, p.x * kx, p.y * ky, T * kx + 0.75, T * ky + 0.75);
          continue;
        }
        if (age > p.life) continue;
        const q = age / p.life;
        const [dx, dy] = this.offset(p, age);
        const x = (p.x + dx) * kx, y = (p.y + dy) * ky;
        const size = T * kx * (1 - 0.65 * q);
        if (q < 0.3) {
          ctx.globalAlpha = 1 - q;
          ctx.drawImage(this.snapshot, p.x, p.y, T, T, x, y, size, size);
        } else {
          ash[Math.min(3, Math.floor((1 - q) * 4 / 0.7))].push(x, y, size * 0.7);
        }
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgb(74, 60, 50)';
      for (let b = 0; b < 4; b++) {
        const list = ash[b];
        if (!list.length) continue;
        ctx.globalAlpha = 0.2 + b * 0.2;
        ctx.beginPath();
        for (let i = 0; i < list.length; i += 3) ctx.rect(list[i], list[i + 1], list[i + 2], list[i + 2]);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return true;
    }
  }

  function makeBill(hueShift) {
    const w = 220, h = 96;
    const c = canvas(w, h);
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `hsl(${100 + hueShift}, 38%, 62%)`);
    grad.addColorStop(1, `hsl(${105 + hueShift}, 42%, 42%)`);
    g.fillStyle = grad;
    g.beginPath();
    g.roundRect(0, 0, w, h, 6);
    g.fill();
    g.strokeStyle = 'rgba(30, 70, 25, 0.85)';
    g.lineWidth = 4;
    g.strokeRect(8, 8, w - 16, h - 16);
    g.fillStyle = 'rgba(225, 245, 205, 0.9)';
    g.beginPath();
    g.ellipse(w / 2, h / 2, 30, 34, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1f4d1a';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'bold 44px Georgia, serif';
    g.fillText('$', w / 2, h / 2 + 2);
    g.font = 'bold 18px Georgia, serif';
    g.fillText('100', 32, 26);
    g.fillText('100', w - 32, h - 24);
    return c;
  }

  // Snap twice: it rains cash.
  class CashEffect {
    static DURATION = 6.5;
    static sprites = null;

    start() {
      CashEffect.sprites ||= [makeBill(0), makeBill(-8), makeBill(10)];
      this.bills = Array.from({ length: 85 }, () => {
        const size = rand(0.07, 0.13);
        return {
          x: rand(-0.05, 1.05),
          y: -rand(0, 0.25),
          delay: rand(0, 3),
          speed: rand(0.22, 0.42),
          sway: rand(0.01, 0.04), swaySpeed: rand(1.2, 3), phase: rand(0, 6.3),
          rot: rand(0, Math.PI * 2), rotSpeed: rand(-1.6, 1.6),
          flip: rand(2.5, 7),
          size,
          sprite: CashEffect.sprites[Math.floor(rand(0, 3))],
        };
      });
    }

    draw(ctx, frame, W, H, t) {
      const fade = t > CashEffect.DURATION - 1 ? CashEffect.DURATION - t : 1;
      for (const b of this.bills) {
        const age = t - b.delay;
        if (age < 0) continue;
        const size = b.size * W;
        const y = b.y * H - size + b.speed * H * age;
        if (y > H + size) continue;
        const x = (b.x + Math.sin(b.phase + age * b.swaySpeed) * b.sway) * W;
        const flip = Math.cos(b.phase + age * b.flip);
        ctx.save();
        ctx.globalAlpha = clamp01(fade);
        ctx.translate(x, y);
        ctx.rotate(b.rot + b.rotSpeed * age);
        ctx.scale(1, Math.abs(flip) < 0.08 ? 0.08 : flip);
        if (flip < 0) ctx.filter = 'brightness(0.75)';
        const h = size * (b.sprite.height / b.sprite.width);
        ctx.drawImage(b.sprite, -size / 2, -h / 2, size, h);
        ctx.restore();
      }
      return t < CashEffect.DURATION;
    }
  }

  // Both hands up: black-and-white, letterbox, film grain, ABSOLUTE CINEMA.
  class CinemaEffect {
    static MIN = 4;
    static grain = null;

    start() {
      this.until = CinemaEffect.MIN;
      if (!CinemaEffect.grain) {
        const c = canvas(256, 256);
        const g = c.getContext('2d');
        const img = g.createImageData(256, 256);
        for (let i = 0; i < img.data.length; i += 4) {
          const v = Math.random() * 255;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        CinemaEffect.grain = c;
      }
    }

    keepAlive(t) {
      this.until = Math.max(this.until, t + 1.2);
    }

    intensity(t) {
      return Math.min(easeOut(t / 0.5), clamp01((this.until + 0.6 - t) / 0.6));
    }

    filter(t) {
      const p = this.intensity(t);
      return `grayscale(${p}) contrast(${1 + 0.35 * p}) brightness(${1 - 0.06 * p})`;
    }

    draw(ctx, frame, W, H, t, scene, settings) {
      const p = this.intensity(t);

      const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.7);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, `rgba(0,0,0,${0.7 * p})`);
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);

      const ox = Math.floor(rand(0, 256)), oy = Math.floor(rand(0, 256));
      ctx.save();
      ctx.globalAlpha = 0.13 * p;
      ctx.globalCompositeOperation = 'overlay';
      ctx.translate(-ox, -oy);
      ctx.fillStyle = ctx.createPattern(CinemaEffect.grain, 'repeat');
      ctx.fillRect(0, 0, W + ox, H + oy);
      ctx.restore();

      const bar = H * 0.11 * p;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, bar);
      ctx.fillRect(0, H - bar, W, bar);

      const textP = clamp01((t - 0.4) / 0.6) * p;
      if (textP > 0) {
        const size = Math.round(H * 0.075);
        ctx.save();
        ctx.globalAlpha = textP;
        ctx.font = `600 ${size}px "Times New Roman", Georgia, serif`;
        ctx.letterSpacing = `${Math.round(size * 0.18)}px`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = size * 0.4;
        ctx.fillStyle = '#fff';
        ctx.fillText(settings.cinemaText || 'ABSOLUTE CINEMA', W / 2, H - bar - H * 0.06);
        ctx.restore();
      }
      return t < this.until + 0.6;
    }
  }

  // Facepalm: the room goes gloomy, thunder flashes, and a storm cloud parks
  // over your head and rains on you.
  class RainEffect {
    static DURATION = 5;

    start(scene) {
      const f = scene.faceBox;
      this.cx = f ? f.x + f.w / 2 : 0.5;
      this.top = f ? f.y - f.h * 0.4 : 0.15;
      this.width = Math.min(0.4, Math.max(0.2, f ? f.w * 1.8 : 0.3));
      // Puffs in cloud-width units around a flat bottom at y = 0.
      this.puffs = Array.from({ length: 7 }, (_, i) => {
        const hump = Math.sin((i / 6) * Math.PI);
        const r = 0.11 + hump * 0.09 + rand(-0.015, 0.015);
        return { x: (i / 6 - 0.5) * 0.78, y: -r * (0.55 + hump * 0.5), r };
      });
      // Heavy rain under the cloud, a lighter drizzle across the whole frame.
      this.drops = Array.from({ length: 260 }, (_, i) => ({
        under: i < 140,
        x: rand(), y: rand(),
        speed: rand(1.3, 1.9), len: rand(0.03, 0.06),
      }));
    }

    intensity(t) {
      return Math.min(easeOut(t / 0.5), clamp01((RainEffect.DURATION - t) / 0.6));
    }

    filter(t) {
      const p = this.intensity(t);
      return `saturate(${1 - 0.6 * p}) brightness(${1 - 0.25 * p}) contrast(${1 + 0.08 * p})`;
    }

    draw(ctx, frame, W, H, t, scene, settings) {
      const p = this.intensity(t);
      const f = scene.faceBox;
      if (f) {
        this.cx += (f.x + f.w / 2 - this.cx) * 0.12;
        this.top += (f.y - f.h * 0.4 - this.top) * 0.12;
      }

      ctx.fillStyle = `rgba(30, 45, 70, ${0.28 * p})`;
      ctx.fillRect(0, 0, W, H);

      const cw = this.width * W;
      const cx = this.cx * W;
      const drop = easeOut((t - 0.15) / 0.7);
      // cy is the cloud's bottom: just above the head, or at least peeking in
      // from the top edge when the head fills the frame.
      const cy = Math.max(cw * 0.12, this.top * H - cw * 0.04) - (1 - drop) * H * 0.6 + Math.sin(t * 1.7) * H * 0.006;

      const angle = 0.12;
      ctx.lineCap = 'round';
      for (const d of this.drops) {
        if (d.under && drop < 0.9) continue;
        const travel = (d.y + t * d.speed) % 1;
        let x, y0, span;
        if (d.under) {
          x = cx + (d.x - 0.5) * cw * 0.85;
          y0 = cy;
          span = H - y0;
        } else {
          x = d.x * W;
          y0 = 0;
          span = H;
        }
        const y = y0 + travel * span;
        const len = d.len * H;
        ctx.strokeStyle = `rgba(200, 220, 255, ${(d.under ? 0.75 : 0.35) * p})`;
        ctx.lineWidth = Math.max(1, W * (d.under ? 0.0028 : 0.0018));
        ctx.beginPath();
        ctx.moveTo(x - len * angle, y - len);
        ctx.lineTo(x, y);
        ctx.stroke();
      }

      if (drop > 0) {
        ctx.save();
        ctx.globalAlpha = p;
        const shade = ctx.createLinearGradient(0, cy - cw * 0.4, 0, cy);
        shade.addColorStop(0, '#6b7180');
        shade.addColorStop(1, '#2c303a');
        ctx.fillStyle = shade;
        ctx.beginPath();
        for (const puff of this.puffs) {
          const px = cx + puff.x * cw, py = cy + puff.y * cw, r = puff.r * cw;
          ctx.moveTo(px + r, py);
          ctx.arc(px, py, r, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.restore();
      }

      // One thunder flash as the cloud arrives.
      const flash = Math.max(0, 1 - Math.abs(t - 0.85) / 0.12) + Math.max(0, 1 - Math.abs(t - 1.1) / 0.08) * 0.6;
      if (flash > 0) {
        ctx.fillStyle = `rgba(235, 240, 255, ${0.55 * flash * p})`;
        ctx.fillRect(0, 0, W, H);
      }

      const capP = clamp01((t - 0.9) / 0.25) * clamp01((RainEffect.DURATION - t) / 0.5);
      if (capP > 0 && settings.facepalmText) {
        const size = Math.round(H * 0.1);
        ctx.save();
        ctx.globalAlpha = capP;
        ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
        ctx.textAlign = 'center';
        ctx.lineJoin = 'round';
        ctx.lineWidth = size * 0.14;
        ctx.strokeStyle = '#000';
        ctx.fillStyle = '#fff';
        const y = H - H * 0.07;
        ctx.strokeText(settings.facepalmText, W / 2, y);
        ctx.fillText(settings.facepalmText, W / 2, y);
        ctx.restore();
      }
      return t < RainEffect.DURATION;
    }
  }

  const EFFECTS = { dust: DustEffect, cash: CashEffect, cinema: CinemaEffect, facepalm: RainEffect };

  class FXManager {
    constructor() {
      this.active = null;
    }

    // Returns false if the effect couldn't start (e.g. no person mask yet).
    trigger(name, now, scene, force = false) {
      const Cls = EFFECTS[name];
      if (!Cls) return false;
      const a = this.active;
      if (a?.name === 'dust' && name === 'dust') {
        a.fx.reappear(now - a.startedAt);
        return true;
      }
      if (a && !force) {
        if (a.name === 'cinema' && name === 'cinema') a.fx.keepAlive(now - a.startedAt);
        return false;
      }
      if (Cls.canStart && !Cls.canStart(scene)) return false;
      const fx = new Cls();
      fx.start(scene);
      this.active = { name, fx, startedAt: now };
      return true;
    }

    keepCinema(now) {
      if (this.active?.name === 'cinema') this.active.fx.keepAlive(now - this.active.startedAt);
    }

    frameFilter(now) {
      const a = this.active;
      return a && a.fx.filter ? a.fx.filter(now - a.startedAt) : 'none';
    }

    draw(ctx, frame, W, H, now, scene, settings) {
      const a = this.active;
      if (!a) return;
      const alive = a.fx.draw(ctx, frame, W, H, now - a.startedAt, scene, settings);
      ctx.globalAlpha = 1;
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'source-over';
      if (!alive) this.active = null;
    }
  }

  NS.FXManager = FXManager;
})();

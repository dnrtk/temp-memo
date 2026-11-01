'use strict';
// アバター: 磁器のような球体に、目と口だけのミニマルな顔。
// 周囲の目盛りリングが状態を表す。
//   idle     : ゆっくり呼吸、ときどき瞬き
//   thinking : 目盛りに光が回る、視線が少し上へ
//   speaking : 音量に合わせて口と目盛りが動く
//   error    : 目盛りが静まり、視線が下がる
// setState()/levelProvider さえ合わせれば Live2D や VRM に差し替えられる。
(function (CX) {
  const TAU = Math.PI * 2;

  class Avatar {
    constructor(canvas, { levelProvider } = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.levelProvider = levelProvider || (() => 0);
      this.state = 'idle';
      this.stateSince = performance.now();
      this.level = 0;
      this.gazeX = 0;
      this.gazeY = 0;
      this.nextBlink = performance.now() + 2500;
      this.blinkStart = -1;
      this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.ticks = 72;
      this.seed = Array.from({ length: this.ticks }, () => Math.random() * TAU);
      this._readColors();
      this._resize();
      new ResizeObserver(() => this._resize()).observe(canvas);
      this._frame = this._frame.bind(this);
      requestAnimationFrame(this._frame);
    }

    _readColors() {
      const cs = getComputedStyle(document.documentElement);
      const v = (n, d) => cs.getPropertyValue(n).trim() || d;
      this.c = {
        accent: v('--accent', '#0E7C86'),
        ink: v('--ink', '#14212B'),
        hi: v('--orb-hi', '#FFFFFF'),
        lo: v('--orb-lo', '#CBD6DC'),
        line: v('--line', '#C5D0D7'),
        shadow: v('--orb-shadow', 'rgba(20,33,43,0.18)')
      };
    }

    refreshColors() {
      this._readColors();
    }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.canvas.getBoundingClientRect();
      this.w = Math.max(1, r.width);
      this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    setState(s) {
      if (s === this.state) return;
      this.state = s;
      this.stateSince = performance.now();
    }

    _blink(now) {
      if (this.blinkStart < 0 && now > this.nextBlink) {
        this.blinkStart = now;
        // ときどき二度まばたき
        this.nextBlink = now + (Math.random() < 0.2 ? 260 : 2800 + Math.random() * 3600);
      }
      if (this.blinkStart >= 0) {
        const p = (now - this.blinkStart) / 150;
        if (p >= 1) {
          this.blinkStart = -1;
          return 1;
        }
        return 0.08 + 0.92 * Math.abs(1 - 2 * p);
      }
      return 1;
    }

    _frame(now) {
      const t = now / 1000;
      const { ctx, w, h, c } = this;
      ctx.clearRect(0, 0, w, h);

      const S = Math.min(w, h);
      const cx = w / 2;
      const cy = h / 2;
      const motion = this.reduced ? 0 : 1;
      const breathe = 1 + 0.012 * Math.sin(t * 1.5) * motion;
      const R = S * 0.3 * breathe;

      // 音量(上がるときは速く、下がるときはゆっくり)
      const target = this.state === 'speaking' ? this.levelProvider() : 0;
      this.level += (target - this.level) * (target > this.level ? 0.45 : 0.12);
      const L = this.level;

      // 視線
      let gx = 0;
      let gy = 0;
      if (this.state === 'thinking') {
        gx = 0.06 + 0.03 * Math.sin(t * 0.9) * motion;
        gy = -0.07;
      } else if (this.state === 'error') {
        gy = 0.05;
      } else {
        gx = 0.035 * Math.sin(t * 0.37) * motion;
        gy = 0.02 * Math.sin(t * 0.23 + 1) * motion;
      }
      this.gazeX += (gx - this.gazeX) * 0.06;
      this.gazeY += (gy - this.gazeY) * 0.06;

      this._drawTicks(t, cx, cy, R, L);
      this._drawOrb(cx, cy, R);
      this._drawFace(now, cx, cy, R, L);

      requestAnimationFrame(this._frame);
    }

    _drawTicks(t, cx, cy, R, L) {
      const { ctx, c } = this;
      const n = this.ticks;
      const inner = R * 1.2;
      const base = R * 0.045;
      const sweep = this.reduced ? 0 : t * 2.4;
      const sinceState = (performance.now() - this.stateSince) / 1000;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.5, R * 0.018);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU - Math.PI / 2;
        let len = base;
        let alpha = 0.22;
        let color = c.line;
        if (this.state === 'thinking') {
          let d = Math.abs(((a - sweep) % TAU + TAU) % TAU - Math.PI) - Math.PI;
          d = Math.abs(d);
          const glow = Math.exp(-(d * d) / 0.18);
          alpha = 0.18 + 0.8 * glow * Math.min(1, sinceState * 2);
          len = base * (1 + 0.8 * glow);
          color = glow > 0.12 ? c.accent : c.line;
        } else if (this.state === 'speaking') {
          const wobble = 0.5 + 0.5 * Math.sin(t * 9 + this.seed[i] * 3);
          len = base + R * 0.32 * L * (0.35 + 0.65 * wobble);
          alpha = 0.3 + 0.6 * L;
          color = c.accent;
        } else if (this.state === 'error') {
          alpha = 0.14;
        }
        const x1 = cx + Math.cos(a) * inner;
        const y1 = cy + Math.sin(a) * inner;
        const x2 = cx + Math.cos(a) * (inner + len);
        const y2 = cy + Math.sin(a) * (inner + len);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawOrb(cx, cy, R) {
      const { ctx, c } = this;
      ctx.save();
      // 接地の影
      const sh = ctx.createRadialGradient(cx, cy + R * 1.05, 0, cx, cy + R * 1.05, R * 0.9);
      sh.addColorStop(0, c.shadow);
      sh.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sh;
      ctx.beginPath();
      ctx.ellipse(cx, cy + R * 1.05, R * 0.9, R * 0.16, 0, 0, TAU);
      ctx.fill();

      // 本体
      const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R);
      g.addColorStop(0, c.hi);
      g.addColorStop(0.55, c.hi);
      g.addColorStop(1, c.lo);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.fill();

      // 縁の細いアクセント
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = Math.max(1, R * 0.012);
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.995, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
      ctx.restore();
    }

    _drawFace(now, cx, cy, R, L) {
      const { ctx, c } = this;
      const fx = cx + this.gazeX * R;
      const fy = cy + this.gazeY * R;
      const open = this._blink(now);

      ctx.save();
      ctx.fillStyle = c.ink;
      const ew = R * 0.075;
      const eh = R * 0.19 * open;
      for (const side of [-1, 1]) {
        const ex = fx + side * R * 0.27;
        const ey = fy - R * 0.08;
        roundRect(ctx, ex - ew / 2, ey - eh / 2, ew, Math.max(eh, ew * 0.4), ew / 2);
        ctx.fill();
      }

      // 口
      const my = fy + R * 0.24;
      if (this.state === 'speaking') {
        const mw = R * (0.16 + 0.06 * L);
        const mh = R * 0.025 + R * 0.15 * L;
        roundRect(ctx, fx - mw / 2, my - mh / 2, mw, mh, Math.min(mw, mh) / 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = c.ink;
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(2, R * 0.03);
        ctx.beginPath();
        if (this.state === 'idle') {
          ctx.arc(fx, my - R * 0.1, R * 0.12, Math.PI * 0.3, Math.PI * 0.7); // 軽い笑顔
        } else {
          ctx.moveTo(fx - R * 0.06, my);
          ctx.lineTo(fx + R * 0.06, my);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  CX.Avatar = Avatar;
})((window.CX = window.CX || {}));

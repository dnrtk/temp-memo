'use strict';
// 読み上げキュー。文ごとに合成を先行リクエストし、順番どおりに再生する。
// AnalyserNode で音量を取り、アバターの口と輪の動きに使う。
(function (CX) {
  class Speaker {
    constructor({ synthesize, concurrency = 1, enabled = true, onBusyChange, onError } = {}) {
      this.synthesize = synthesize;
      this.concurrency = Math.max(1, concurrency);
      this.enabled = enabled;
      this.onBusyChange = onBusyChange || (() => {});
      this.onError = onError || (() => {});
      this.cache = new Map(); // 文 → デコード済み音声(直近 cacheLimit 件)
      this.cacheLimit = 40;
      this.queue = [];
      this.inflight = 0;
      this.current = null;
      this.gen = 0;
      this.busy = false;

      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.6;
      this.analyser.connect(this.ctx.destination);
      this.samples = new Float32Array(this.analyser.fftSize);
    }

    resume() {
      if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    async _decode(text) {
      const hit = this.cache.get(text);
      if (hit) {
        this.cache.delete(text);
        this.cache.set(text, hit);
        return hit;
      }
      const data = await this.synthesize(text);
      if (!data || !data.byteLength) throw new Error('empty audio');
      const audio = await this.ctx.decodeAudioData(data);
      this.cache.set(text, audio);
      while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
      return audio;
    }

    // 固定フレーズを先に合成してメモリに置いておく
    async preload(text) {
      if (!this.enabled || !text || this.cache.has(text)) return;
      try {
        await this._decode(text);
      } catch (err) {
        console.warn('[speaker] preload failed', err);
      }
    }

    enqueue(text) {
      if (!this.enabled || !text) return;
      this.queue.push({ text, started: false, buffer: null, failed: false });
      this._setBusy(true);
      this._pump();
    }

    _fetch(item) {
      const gen = this.gen;
      item.started = true;
      this.inflight++;
      this._decode(item.text)
        .then((buf) => {
          if (gen === this.gen) item.buffer = buf;
        })
        .catch((err) => {
          if (gen !== this.gen) return;
          console.warn('[speaker] synth failed:', item.text, err);
          if (err && err.name === 'EncodingError') this.onError(`音声データを再生できません(wav以外の形式?): ${item.text}`);
          item.failed = true;
        })
        .finally(() => {
          if (gen !== this.gen) return;
          this.inflight--;
          this._pump();
        });
    }

    _pump() {
      for (const item of this.queue) {
        if (this.inflight >= this.concurrency) break;
        if (!item.started) this._fetch(item);
      }
      if (this.current) return;
      const head = this.queue[0];
      if (!head) {
        if (this.inflight === 0) this._setBusy(false);
        return;
      }
      if (head.failed) {
        this.queue.shift();
        this._pump();
      } else if (head.buffer) {
        this.queue.shift();
        this._play(head.buffer);
      }
    }

    _play(buffer) {
      this.resume();
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyser);
      src.onended = () => {
        if (this.current !== src) return;
        this.current = null;
        this._pump();
      };
      this.current = src;
      src.start();
    }

    _setBusy(v) {
      if (this.busy === v) return;
      this.busy = v;
      this.onBusyChange(v);
    }

    stop() {
      this.gen++;
      this.queue = [];
      this.inflight = 0;
      if (this.current) {
        this.current.onended = null;
        try {
          this.current.stop();
        } catch {}
        this.current = null;
      }
      this._setBusy(false);
    }

    isBusy() {
      return this.busy;
    }

    isPlaying() {
      return !!this.current;
    }

    // 0..1 の音量
    level() {
      if (!this.current) return 0;
      this.analyser.getFloatTimeDomainData(this.samples);
      let sum = 0;
      for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i];
      const rms = Math.sqrt(sum / this.samples.length);
      return Math.min(1, rms * 5);
    }
  }

  CX.Speaker = Speaker;
})((window.CX = window.CX || {}));

'use strict';
// 読み上げキュー。文ごとに合成を先行リクエストし、順番どおりに再生する。
// TTS がストリーミングで返す場合は、届いた分(サーバ側の1文ごと)から順に鳴らす。
// 無音から鳴り始めるときは prebufferMs だけ待ってから鳴らし、続きの文が間に合うようにする
// (キャッシュから届いた音声は待たない)。
// AnalyserNode で音量を取り、アバターの口と輪の動きに使う。
(function (CX) {
  class Speaker {
    constructor({ synthesize, concurrency = 1, prebufferMs = 0, enabled = true, onBusyChange, onError } = {}) {
      this.synthesize = synthesize; // (text, { signal, onChunk }) => Promise
      this.concurrency = Math.max(1, concurrency);
      this.prebufferMs = prebufferMs;
      this.waiting = null; // prebuffer のタイマー
      this.enabled = enabled;
      this.onBusyChange = onBusyChange || (() => {});
      this.onError = onError || (() => {});
      this.cache = new Map(); // 文 → 合成し終えた音声(AudioBuffer の配列。直近 cacheLimit 件)
      this.cacheLimit = 40;
      this.queue = [];
      this.inflight = 0;
      this.current = null;
      this.gen = 0;
      this.abort = new AbortController();
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

    // TtsClient から届く1かたまり(PCM か WAV)を AudioBuffer にする
    async _toBuffer(chunk) {
      if (chunk instanceof ArrayBuffer) return this.ctx.decodeAudioData(chunk);
      const buf = this.ctx.createBuffer(1, Math.max(1, chunk.samples.length), chunk.sampleRate);
      buf.copyToChannel(chunk.samples, 0);
      return buf;
    }

    _cached(text) {
      const hit = this.cache.get(text);
      if (!hit) return null;
      this.cache.delete(text);
      this.cache.set(text, hit);
      return hit;
    }

    _remember(text, buffers) {
      if (!buffers.length) return;
      this.cache.set(text, buffers);
      while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
    }

    // 合成しながら、AudioBuffer ができるたびに onBuffer を呼ぶ。全部そろったら配列で resolve
    async _synth(text, signal, onBuffer) {
      const buffers = [];
      let decoding = Promise.resolve();
      await this.synthesize(text, {
        signal,
        onChunk: (chunk) => {
          decoding = decoding
            .then(() => this._toBuffer(chunk))
            .then((b) => {
              b.cached = !!chunk.cached;
              buffers.push(b);
              if (onBuffer) onBuffer(b);
            });
        }
      });
      await decoding;
      if (!buffers.length) throw new Error('empty audio');
      this._remember(text, buffers);
      return buffers;
    }

    // 固定フレーズを先に合成してメモリに置いておく
    async preload(text) {
      if (!this.enabled || !text || this.cache.has(text)) return;
      try {
        await this._synth(text);
      } catch (err) {
        console.warn('[speaker] preload failed', err);
      }
    }

    // onStart({ duration }): その文を話し始めたとき(合成に失敗して飛ばしたときも)に呼ぶ
    enqueue(text, { onStart } = {}) {
      if (!this.enabled || !text) return;
      this.queue.push({ text, onStart, started: false, chunks: [], played: 0, done: false, instant: false });
      this._setBusy(true);
      this._pump();
    }

    _fetch(item) {
      const gen = this.gen;
      item.started = true;
      const hit = this._cached(item.text);
      if (hit) {
        item.chunks = hit.slice();
        item.done = true;
        item.instant = true;
        return;
      }
      this.inflight++;
      this._synth(item.text, this.abort.signal, (b) => {
        if (gen !== this.gen) return;
        item.chunks.push(b);
        this._pump();
      })
        .catch((err) => {
          if (gen !== this.gen) return;
          console.warn('[speaker] synth failed:', item.text, err);
          if (err && err.name === 'EncodingError') this.onError(`音声データを再生できません(wav以外の形式?): ${item.text}`);
        })
        .finally(() => {
          if (gen !== this.gen) return;
          item.done = true;
          this.inflight--;
          this._pump();
        });
    }

    // chain: 直前の音声から続けて鳴らす(または prebuffer を待ち終えた)ときは true
    _pump(chain = false) {
      for (const item of this.queue) {
        if (this.inflight >= this.concurrency) break;
        if (!item.started) this._fetch(item);
      }
      if (this.current || this.waiting) return;
      const head = this.queue[0];
      if (!head) {
        if (this.inflight === 0) this._setBusy(false);
        return;
      }
      if (head.played < head.chunks.length) {
        const buf = head.chunks[head.played];
        if (!chain && this.prebufferMs > 0 && !head.instant && !buf.cached) {
          this.waiting = setTimeout(() => {
            this.waiting = null;
            this._pump(true);
          }, this.prebufferMs);
          return;
        }
        if (head.played === 0) this._notifyStart(head);
        head.played++;
        this._play(buf);
      } else if (head.done) {
        this._notifyStart(head);
        this.queue.shift();
        this._pump(chain);
      }
      // それ以外は、続きの音声が届くのを待つ
    }

    // duration: 音声が全部そろっていればその長さ(秒)。まだ届いている途中なら null
    _notifyStart(item) {
      const fn = item.onStart;
      item.onStart = null;
      if (fn) fn({ duration: item.done ? item.chunks.reduce((s, b) => s + b.duration, 0) : null });
    }

    _play(buffer) {
      this.resume();
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyser);
      src.onended = () => {
        if (this.current !== src) return;
        this.current = null;
        this._pump(true);
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
      // 接続を切ると、サーバ側も次の文から合成を止める
      this.abort.abort();
      this.abort = new AbortController();
      clearTimeout(this.waiting);
      this.waiting = null;
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

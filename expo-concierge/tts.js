'use strict';
// AivisSpeech TTS サーバのクライアント。
//   streaming: true  → POST {baseUrl}/v1/audio/speech/events  NDJSON で文ごとに PCM16 が届く
//   streaming: false → POST {baseUrl}/v1/audio/speech         WAV を一括で受け取る
// 文ごとの音声は onChunk に渡す。ストリーミング時は { sampleRate, samples: Float32Array }、
// 一括時は WAV の ArrayBuffer。
(function (CX) {
  const join = (base, path) => String(base || '').replace(/\/+$/, '') + path;

  function pcm16ToFloat(bytes) {
    const n = bytes.length >> 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
    return out;
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function errorDetail(res) {
    const body = await res.text().catch(() => '');
    try {
      return JSON.parse(body).error.message || body;
    } catch {
      return body.slice(0, 120);
    }
  }

  class TtsClient {
    constructor(cfg, log) {
      this.cfg = cfg;
      this.log = log || (() => {});
    }

    async health() {
      try {
        const res = await fetch(join(this.cfg.baseUrl, this.cfg.healthPath), { signal: AbortSignal.timeout(5000) });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.log(`TTS: ${json.engine || '?'} ${json.status || ''}`);
        return true;
      } catch (err) {
        this.log(`TTSサーバに接続できません: ${err.message}`);
        return false;
      }
    }

    // 合成が終わると resolve。signal で中断するとサーバ側も次の文から合成を止める
    async synthesize(text, { signal, onChunk, quiet = false } = {}) {
      const log = quiet ? () => {} : this.log;
      const streaming = this.cfg.streaming !== false;
      const path = streaming ? this.cfg.eventsPath : this.cfg.speechPath;
      const body = { ...(this.cfg.params || {}), input: text };
      if (streaming) {
        body.stream_format = 'ndjson';
        if (this.cfg.split) body.split = this.cfg.split;
      }
      const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
      const t0 = performance.now();
      let res;
      try {
        res = await fetch(join(this.cfg.baseUrl, path), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        });
      } catch (err) {
        if (err.name !== 'AbortError') this.log(`[失敗] TTSに接続できません: ${err.message} (${text})`);
        throw err;
      }
      if (!res.ok) {
        const detail = await errorDetail(res);
        this.log(`[失敗] TTS HTTP ${res.status} ${detail} (${text})`);
        throw new Error(`TTS HTTP ${res.status}`);
      }

      if (!streaming) {
        const buf = await res.arrayBuffer();
        if (!buf.byteLength) throw new Error('empty audio');
        log(`[生成] ${Math.round(performance.now() - t0)}ms ${text}`);
        onChunk && onChunk(buf);
        return;
      }

      let sampleRate = 48000;
      const handle = (ev) => {
        if (ev.type === 'start') {
          sampleRate = ev.sample_rate || sampleRate;
        } else if (ev.type === 'audio') {
          // cached と sample_rate は serve.py のキャッシュ経由のときだけ付く
          const tag = ev.cached === undefined ? '[受信]' : ev.cached ? '[キャッシュ]' : '[生成]';
          log(`${tag} ${Math.round(performance.now() - t0)}ms ${ev.text || text}`);
          onChunk &&
            onChunk({ sampleRate: ev.sample_rate || sampleRate, samples: pcm16ToFloat(base64ToBytes(ev.audio)), cached: !!ev.cached });
        } else if (ev.type === 'error') {
          this.log(`[失敗] TTS ${ev.status} ${ev.message} (${text})`);
          throw new Error(`TTS stream error ${ev.status}`);
        } else if (ev.type === 'done') {
          log(`[完了] ${ev.audio_sec}s 音声 / ${Math.round(performance.now() - t0)}ms (RTF ${ev.rtf})`);
        }
      };

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) handle(JSON.parse(line));
        }
      }
      if (buf.trim()) handle(JSON.parse(buf));
    }
  }

  CX.TtsClient = TtsClient;
})((window.CX = window.CX || {}));

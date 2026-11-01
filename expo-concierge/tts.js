'use strict';
// VoxCPM2 サーバのクライアント。
//   POST {baseUrl}/v1/audio/speech  { input, ...params }  → wav
//   GET  {baseUrl}/cache/texts      → { texts: [...] }
// サーバにキャッシュ済みの文の一覧を持っておき、読み上げたい文と内容が同じなら
// キャッシュ済みの文字列そのものを送る(サーバ側で生成をスキップさせる)。
(function (CX) {
  const join = (base, path) => String(base || '').replace(/\/+$/, '') + path;

  // 比較用のキー。句読点・記号・空白・全角半角・大文字小文字の違いを無視する
  function normKey(s) {
    return String(s || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');
  }

  // 0..1 の類似度(1 - 編集距離/長い方の長さ)
  function similarity(a, b) {
    if (a === b) return 1;
    const m = a.length;
    const n = b.length;
    if (!m || !n) return 0;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
  }

  class TtsClient {
    constructor(cfg, log) {
      this.cfg = cfg;
      this.log = log || (() => {});
      this.byKey = new Map(); // normKey → キャッシュ済みの文字列
    }

    get size() {
      return this.byKey.size;
    }

    async refreshCache() {
      try {
        const res = await fetch(join(this.cfg.baseUrl, this.cfg.cachePath), { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const texts = Array.isArray(json.texts) ? json.texts : [];
        this.byKey.clear();
        for (const t of texts) this._remember(t);
        this.log(`TTSキャッシュ ${this.byKey.size}件を取得`);
        return true;
      } catch (err) {
        this.log(`TTSキャッシュ一覧を取得できません: ${err.message}`);
        return false;
      }
    }

    _remember(text) {
      const k = normKey(text);
      if (k && !this.byKey.has(k)) this.byKey.set(k, text);
    }

    // 内容が同じ(またはfuzzyMatch以上に近い)キャッシュ済みの文。なければ null
    lookup(text) {
      const k = normKey(text);
      if (!k) return null;
      const exact = this.byKey.get(k);
      if (exact) return exact;
      const th = Number(this.cfg.fuzzyMatch) || 0;
      if (th <= 0 || k.length < 8) return null;
      let best = null;
      let bestScore = th;
      for (const [kk, t] of this.byKey) {
        if (Math.abs(kk.length - k.length) > Math.ceil(k.length * (1 - th))) continue;
        const s = similarity(k, kk);
        if (s >= bestScore) {
          bestScore = s;
          best = t;
        }
      }
      return best;
    }

    // key(normKey済み)で始まる、より長いキャッシュ済みの文があるか
    hasLongerPrefix(key) {
      if (!key) return false;
      for (const kk of this.byKey.keys()) {
        if (kk.length > key.length && kk.startsWith(key)) return true;
      }
      return false;
    }

    resolve(text) {
      return this.lookup(text) || text;
    }

    async synthesize(text) {
      const cached = this.byKey.get(normKey(text)) === text;
      const t0 = performance.now();
      let res;
      try {
        res = await fetch(join(this.cfg.baseUrl, this.cfg.speechPath), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(this.cfg.params || {}), input: text }),
          signal: AbortSignal.timeout(this.cfg.timeoutMs)
        });
      } catch (err) {
        this.log(`[失敗] TTSに接続できません: ${err.message} (${text})`);
        throw err;
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 120);
        this.log(`[失敗] TTS HTTP ${res.status} ${detail} (${text})`);
        throw new Error(`TTS HTTP ${res.status}`);
      }
      const buf = await res.arrayBuffer();
      if (!buf.byteLength) {
        this.log(`[失敗] TTSの応答が空です (${text})`);
        throw new Error('empty audio');
      }
      this.log(`${cached ? '[キャッシュ]' : '[生成]'} ${Math.round(performance.now() - t0)}ms ${text}`);
      // 生成した文はサーバ側でキャッシュされる前提で、一覧にも加えておく
      this._remember(text);
      return buf;
    }
  }

  CX.normKey = normKey;
  CX.similarity = similarity;
  CX.TtsClient = TtsClient;
})((window.CX = window.CX || {}));

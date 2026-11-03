'use strict';
// 表示用の軽量Markdownレンダラと、読み上げ用の文分割・整形。
(function (CX) {
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const REF_LINE = /^\s*\[(\d+|\^?\w+)\]:\s*(\S+)(?:\s+"([^"]*)")?\s*$/;

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  // インライン要素。リンクは押せないキオスクなので文字だけ残す
  function inline(s) {
    let h = esc(s);
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    h = h.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1');
    h = h.replace(/\[\^?(\d+)\]/g, '<sup>$1</sup>');
    h = h.replace(/【(\d+)(?:†[^】]*)?】/g, '<sup>$1</sup>');
    h = h.replace(/https?:\/\/[^\s<)]+/g, (u) => `<span class="url">${hostOf(u.replace(/&amp;/g, '&'))}</span>`);
    return h;
  }

  // partial=true のときは、まだ途中かもしれない最終行の参照定義を参照元に数えない
  function renderMarkdown(md, partial) {
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    const out = [];
    const refs = [];
    let para = [];
    let list = null; // { tag, items: [] }

    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    };
    const closeList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };

    lines.forEach((line, idx) => {
      const ref = line.match(REF_LINE) || (/^\s*\[\^?\w+\]:/.test(line) ? [] : null);
      if (ref) {
        if (ref.length && !(partial && idx === lines.length - 1)) refs.push({ title: ref[3] || hostOf(ref[2]) });
        return;
      }
      if (/^\s*$/.test(line)) {
        flushPara();
        closeList();
        return;
      }
      if (/^\s*\|?\s*:?-{3,}/.test(line)) return; // 表の区切り行
      const h = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (h) {
        flushPara();
        closeList();
        out.push(`<p class="md-h">${inline(h[1])}</p>`);
        return;
      }
      const ul = line.match(/^\s*[-*・•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)．]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) {
          closeList();
          list = { tag, items: [] };
        }
        list.items.push((ul || ol)[1]);
        return;
      }
      closeList();
      const row = line.match(/^\s*\|(.*)\|\s*$/);
      para.push(row ? row[1].split('|').map((c) => c.trim()).join(' ／ ') : line);
    });
    flushPara();
    closeList();
    return { html: out.join(''), refs };
  }

  // 読み上げ用の整形
  function cleanForSpeech(s) {
    let t = String(s || '');
    if (REF_LINE.test(t)) return '';
    t = t
      .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\[\^?\d+\]|【\d+(?:†[^】]*)?】/g, '')
      .replace(/[*_`#>]+/g, '')
      .replace(/^\s*(?:[-・•]|\d+[.)．])\s+/gm, '')
      .replace(/\|/g, '、')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[\p{L}\p{N}]/u.test(t)) return '';
    return t;
  }

  // ストリームで届く回答を読み上げ単位に切る。
  //   1. まず文(。！？改行)単位に切る
  //   2. 短い文をまとめ、長い文は読点で切る。firstCut のときは最初のかたまりだけ
  //      読点でも早めに切って、声が出るまでの時間を縮める(文単位のキャッシュには当たらなくなる)
  // 返す { text, end } の end は、push してきた文字列の通算で、そのかたまりがどこまでに当たるか
  // (話し始めたときに画面に出す範囲)
  class SpeechPlanner {
    constructor({ minChars = 12, maxChars = 90, firstCut = false } = {}) {
      this.firstCut = firstCut;
      this.minChars = minChars;
      this.maxChars = maxChars;
      this.reset();
    }

    reset() {
      this.buf = '';
      this.consumed = 0; // buf より前に切り出し済みの文字数
      this.pending = [];
      this.plain = '';
      this.plainEnd = 0;
      this.emitted = 0;
    }

    push(text) {
      this.buf += text;
      this.pending.push(...this._takeSentences(false));
      return this._drain(false);
    }

    flush() {
      this.pending.push(...this._takeSentences(true));
      const out = this._drain(true);
      this.reset();
      return out;
    }

    _takeSentences(final) {
      const raw = [];
      const take = (n) => {
        this.consumed += n;
        raw.push({ text: this.buf.slice(0, n), end: this.consumed });
        this.buf = this.buf.slice(n);
      };
      let i;
      while ((i = this.buf.search(/[。！？!?\n]/)) >= 0) take(i + 1);
      // 句点が来ないまま長くなった場合は読点で区切る
      while (this.buf.length > this.maxChars * 1.5) {
        const j = this.buf.lastIndexOf('、', this.maxChars);
        take((j > 10 ? j : this.maxChars - 1) + 1);
      }
      if (final && this.buf) take(this.buf.length);
      return raw.map((r) => ({ text: cleanForSpeech(r.text), end: r.end })).filter((r) => r.text);
    }

    _drain(final) {
      const out = [];
      while (this.pending.length) this._addPlain(out, this.pending.shift());
      if (final) this._flushPlain(out);
      return out;
    }

    _addPlain(out, sentence) {
      const end = sentence.end;
      for (let piece of splitLong(sentence.text, this.maxChars)) {
        if (this.firstCut && this.emitted === 0 && !this.plain && piece.length > 30) {
          const j = piece.indexOf('、', 8);
          if (j > 0 && j < piece.length - 6) {
            out.push({ text: piece.slice(0, j + 1), end });
            this.emitted++;
            piece = piece.slice(j + 1);
          }
        }
        if (this.plain && this.plain.length + piece.length > this.maxChars) this._flushPlain(out);
        // 箇条書きの項目など句読点のない切れ目には読点を補って、続けて読まないようにする
        if (this.plain && !/[。、！？!?,.]$/.test(this.plain)) this.plain += '、';
        this.plain += piece;
        this.plainEnd = end;
        if (this.plain.length >= this.minChars) this._flushPlain(out);
      }
    }

    _flushPlain(out) {
      if (!this.plain) return;
      out.push({ text: this.plain, end: this.plainEnd });
      this.emitted++;
      this.plain = '';
    }
  }

  function splitLong(s, max) {
    const out = [];
    let rest = s;
    while (rest.length > max) {
      const j = rest.lastIndexOf('、', max);
      const k = j > 10 ? j : max - 1;
      out.push(rest.slice(0, k + 1));
      rest = rest.slice(k + 1);
    }
    if (rest) out.push(rest);
    return out;
  }

  // 推論(Thinking)モデルの「考えている途中」の出力を取り除く。ストリームの途中でタグが切れていても扱える。
  //   <think>…</think> / <thinking>…</thinking> / <reasoning>…</reasoning>
  //   Dify系が出す <details …><summary>Thinking…</summary> … </details>
  //   開始タグなしで </think> だけが来る場合(チャットテンプレート側で <think> を付けるモデル)は、
  //   それまでに出した分も考え中だったとみなして discard: true を返す
  const THINK_OPEN = /<(think|thinking|reasoning)>|<details\b[^>]*>\s*<summary>[^<]*(?:think|reason|思考|考え)[^<]*<\/summary>/i;
  const THINK_ORPHAN_CLOSE = /<\/(think|thinking|reasoning)>/i;
  const THINK_TAGS = ['<think>', '<thinking>', '<reasoning>', '</think>', '</thinking>', '</reasoning>'];

  function maybePartialTag(tail) {
    const t = tail.toLowerCase();
    if (THINK_TAGS.some((x) => x.startsWith(t))) return true;
    if ('<details'.startsWith(t)) return true;
    return t.startsWith('<details') && !/<\/summary>/.test(t) && t.length < 400;
  }

  class ThinkFilter {
    constructor() {
      this.reset();
    }
    reset() {
      this.buf = '';
      this.inside = null; // 閉じタグの正規表現
      this.sawOpen = false;
    }
    push(chunk) {
      this.buf += chunk;
      return this._run(false);
    }
    flush() {
      const r = this._run(true);
      this.reset();
      return r;
    }
    _run(final) {
      let out = '';
      let discard = false;
      for (;;) {
        if (this.inside) {
          const m = this.buf.match(this.inside);
          if (!m) {
            this.buf = final ? '' : this.buf.slice(-16); // 閉じタグの書きかけだけ残す
            break;
          }
          this.buf = this.buf.slice(m.index + m[0].length).replace(/^\s+/, '');
          this.inside = null;
          continue;
        }
        const open = this.buf.match(THINK_OPEN);
        const close = this.sawOpen ? null : this.buf.match(THINK_ORPHAN_CLOSE);
        if (close && (!open || close.index < open.index)) {
          out = '';
          discard = true;
          this.buf = this.buf.slice(close.index + close[0].length).replace(/^\s+/, '');
          continue;
        }
        if (open) {
          out += this.buf.slice(0, open.index);
          this.buf = this.buf.slice(open.index + open[0].length);
          this.inside = open[1] ? new RegExp(`</${open[1]}>`, 'i') : /<\/details>/i;
          this.sawOpen = true;
          continue;
        }
        // <details…><summary>… が書きかけの間は、思考ブロックかどうか判断できるまで出さない
        const det = this.buf.toLowerCase().lastIndexOf('<details');
        const lt = det >= 0 && maybePartialTag(this.buf.slice(det)) ? det : this.buf.lastIndexOf('<');
        if (!final && lt >= 0 && maybePartialTag(this.buf.slice(lt))) {
          out += this.buf.slice(0, lt);
          this.buf = this.buf.slice(lt);
        } else {
          out += this.buf;
          this.buf = '';
        }
        break;
      }
      return { text: out, discard };
    }
  }

  function stripThinking(text) {
    const f = new ThinkFilter();
    const a = f.push(String(text || ''));
    const b = f.flush();
    return (b.discard ? '' : a.text) + b.text;
  }

  CX.renderMarkdown = renderMarkdown;
  CX.cleanForSpeech = cleanForSpeech;
  CX.SpeechPlanner = SpeechPlanner;
  CX.ThinkFilter = ThinkFilter;
  CX.stripThinking = stripThinking;
})((window.CX = window.CX || {}));

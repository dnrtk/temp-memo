'use strict';
(function () {
  const CX = window.CX;
  const $ = (id) => document.getElementById(id);

  // ---------- 設定 ----------
  const DEFAULTS = {
    gryphon: {
      baseUrl: '/gryphon',
      apiKey: '',
      userPrefix: 'expo-booth',
      inputs: {},
      timeoutMs: 120000,
      // 回答を短く・端的・丁寧にするための指示(prompts/answer-rules.txt と同じ内容)
      //   'append' : 質問文の末尾に付けて送る(GRYPHON/Copilot Studio 側を触らずに効く)
      //   'inputs' : inputs[answerRulesInput] として渡す(チャットフロー側でプロンプトに差し込む)
      //   'off'    : 送らない(システムプロンプトに入れ終わったらこれ)
      answerRulesMode: 'append',
      answerRulesInput: 'answer_rules',
      answerRules: [
        '【回答ルール】展示会ブースの来場者に、音声で案内する回答として答えてください。',
        '・です・ます調で丁寧に。最初の一文で結論を言う。',
        '・全体で2〜3文、100字程度までに収める。前置き・質問の繰り返し・締めの挨拶は書かない。',
        '・箇条書き、表、見出し、URL、脚注、絵文字、記号は使わない。読み上げてそのまま伝わる文にする。',
        '・英字の略語は必要なものだけにする。',
        '・分からないこと、確認が必要なことは推測せず「詳しくはブーススタッフにお尋ねください。」と答える。'
      ].join('\n')
    },
    tts: {
      enabled: true,
      baseUrl: '/tts',
      // true: /events で文ごとに受け取り、届いた分から鳴らす / false: /v1/audio/speech で一括
      streaming: true,
      speechPath: '/v1/audio/speech',
      eventsPath: '/v1/audio/speech/events',
      healthPath: '/health',
      // サーバ側の区切り方 'sentence' / 'clause'(読点でも区切る。先頭は早いが抑揚が不自然になりやすい)
      split: 'sentence',
      // speaker / style / speed / intonation_scale / pitch_scale など。省略するとサーバの既定値
      params: {},
      timeoutMs: 120000,
      concurrency: 1,
      // 無音から鳴り始めるとき、これだけ待ってから鳴らす(続きの文の合成が間に合うように)。
      // キャッシュから届いた音声は待たない
      prebufferMs: 800
    },
    voice: {
      ackPhrase: '確認しますので、少々お待ちください。',
      // 質問してからこの時間内に回答の最初の文を読み上げに回せたら、ackPhrase は言わない
      ackDelayMs: 1500,
      cutoffPhrase: '続きは画面でご覧ください。',
      maxSpeechChars: 400,
      // 起動時に合成しておく決まり文句(回答ルールで使わせている締めの一文など)
      warmPhrases: ['詳しくはブーススタッフにお尋ねください。'],
      // 待機中に1行ずつ合成させて serve.py のキャッシュに入れておく文の一覧(空文字で無効)
      warmFile: 'tts-phrases.txt',
      minSegmentChars: 12,
      maxSegmentChars: 90,
      // 回答の最初の文を読点で早めに切って先に鳴らす。速くなるが、その文はキャッシュに当たらなくなる
      firstSegmentCut: false,
      // 回答のテキストを、その部分を話し始めたときに画面に出す(false で届いたらすぐ出す)
      syncText: true
    },
    ui: {
      layout: 'bubble',
      brandName: 'Your Company',
      boothTitle: 'AI Platform Showcase',
      assistantName: 'ご案内AI',
      accent: '#0E7C86',
      greetingTitle: 'ようこそ。\n気になることを、そのまま聞いてください。',
      greetingBody: '下の質問をタッチするか、文章で入力してください。答えは画面と音声でお伝えします。',
      footnote: 'AIによる自動回答です。詳しくはブーススタッフにお声がけください。',
      inputPlaceholder: 'ご質問を入力してください',
      idleResetSec: 90,
      thinkingMessages: ['ご質問を確認しています', '社内の資料とWebを調べています', '回答をまとめています'],
      showProgressTitles: false,
      // 回答の文字をふわっと出す時間(ms。0 でなし)と、1文字ずつ出す速さ(文字/秒)
      fadeMs: 700,
      typeCharsPerSec: 40,
      errorMessage: '回答を取得できませんでした。少し時間をおいてもう一度お試しいただくか、近くのスタッフにお声がけください。'
    },
    presets: []
  };

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  function merge(base, over) {
    if (!isObj(over)) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
    return out;
  }

  const cfg = merge(DEFAULTS, window.CONCIERGE_CONFIG || {});
  const ui = cfg.ui;
  const voice = cfg.voice;

  // ---------- デバッグ表示 (?debug) ----------
  const debugEl = $('debug');
  const debugOn = new URLSearchParams(location.search).has('debug');
  const debugLines = [];
  function log(msg) {
    console.log('[concierge]', msg);
    if (!debugOn) return;
    const t = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    debugLines.push(`${t} ${msg}`);
    while (debugLines.length > 14) debugLines.shift();
    debugEl.textContent = debugLines.join('\n');
  }
  debugEl.hidden = !debugOn;

  // ---------- 要素 ----------
  const el = {
    app: document.querySelector('.app'),
    status: $('status-text'),
    welcome: $('welcome'),
    qa: $('qa'),
    question: $('question'),
    questionInline: $('question-inline'),
    thinking: $('thinking'),
    thinkingText: $('thinking-text'),
    answer: $('answer'),
    sources: $('sources'),
    area: $('answer-area'),
    bubble: $('bubble'),
    presets: $('presets'),
    form: $('ask-form'),
    input: $('ask-input'),
    send: $('ask-send'),
    stop: $('stop-btn'),
    home: $('home-btn')
  };

  if (ui.accent) document.documentElement.style.setProperty('--accent', ui.accent);
  el.app.classList.add(`layout-${ui.layout === 'panel' ? 'panel' : 'bubble'}`);
  $('brand').textContent = ui.brandName || '';
  $('booth').textContent = ui.boothTitle || '';
  $('assistant-name').textContent = ui.assistantName || '';
  $('footnote').textContent = ui.footnote || '';
  $('greeting-title').textContent = ui.greetingTitle || '';
  $('greeting-body').textContent = ui.greetingBody || '';
  el.input.placeholder = ui.inputPlaceholder || '';

  for (const q of cfg.presets || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.textContent = q;
    b.addEventListener('click', () => ask(q, b));
    el.presets.appendChild(b);
  }

  // ---------- 音声 ----------
  const tts = new CX.TtsClient(cfg.tts, log);
  const speaker = new CX.Speaker({
    synthesize: (text, opts) => tts.synthesize(text, opts),
    concurrency: cfg.tts.concurrency,
    prebufferMs: cfg.tts.prebufferMs,
    enabled: cfg.tts.enabled,
    onError: (msg) => log(`[失敗] ${msg}`),
    onBusyChange: () => {
      updateStopButton();
      maybeFinish();
    }
  });
  const thinkFilter = new CX.ThinkFilter();
  const planner = new CX.SpeechPlanner({
    minChars: voice.minSegmentChars,
    maxChars: voice.maxSegmentChars,
    firstCut: voice.firstSegmentCut
  });

  // 起動時: 決まり文句を先に合成してメモリに置いておく
  async function warmUp() {
    if (debugOn) {
      try {
        const info = await (await fetch('/__serve', { signal: AbortSignal.timeout(3000) })).json();
        log(`serve.py ${info.version}${info.mock ? ' (モック)' : ''}  TTS: ${info.tts}`);
      } catch {
        log('serve.py のバージョンが分かりません(古い serve.py か、serve.py を通さずに開いています)');
      }
    }
    if (!cfg.tts.enabled) return;
    await tts.health();
    for (const p of [voice.ackPhrase, voice.cutoffPhrase, ui.errorMessage, ...(voice.warmPhrases || [])]) {
      if (p) await speaker.preload(p);
    }
    log('決まり文句の準備完了');
    await warmCache();
  }
  warmUp();

  // tts-phrases.txt の文を、読み上げていない間に1つずつ合成させる(キャッシュ済みならすぐ終わる)
  // 質問を受けてから答え終わるまでは TTS サーバを空けておく
  const ttsIdle = () => !speaker.isBusy() && state !== 'thinking' && state !== 'answering';
  async function warmCache() {
    if (!voice.warmFile) return;
    let lines;
    try {
      const res = await fetch(voice.warmFile, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      lines = (await res.text())
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    } catch {
      return;
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let failed = 0;
    for (let i = 0; i < lines.length; ) {
      while (!ttsIdle()) await sleep(1000);
      // 来場者への読み上げが始まったら切って、TTS サーバを空ける(この行は後でやり直す)
      const ctrl = new AbortController();
      const watch = setInterval(() => !ttsIdle() && ctrl.abort(), 200);
      try {
        await tts.synthesize(lines[i], { signal: ctrl.signal, quiet: true });
      } catch (err) {
        if (err.name !== 'AbortError') failed++;
      } finally {
        clearInterval(watch);
      }
      if (ctrl.signal.aborted) continue;
      i++;
      if (i % 10 === 0) log(`事前合成 ${i}/${lines.length}`);
    }
    log(`事前合成 完了 ${lines.length}件${failed ? ` (失敗 ${failed}件)` : ''}`);
  }

  // ---------- アバター ----------
  const avatarCanvas = $('avatar');
  const avatar = new CX.Avatar(avatarCanvas, { levelProvider: () => speaker.level() });

  function aimTail() {
    const a = avatarCanvas.getBoundingClientRect();
    const b = el.bubble.getBoundingClientRect();
    const y = Math.max(48, Math.min(b.height - 48, a.top + a.height / 2 - b.top));
    const x = Math.max(48, Math.min(b.width - 48, a.left + a.width / 2 - b.left));
    el.bubble.style.setProperty('--tail-y', `${y}px`);
    el.bubble.style.setProperty('--tail-x', `${x}px`);
  }
  new ResizeObserver(aimTail).observe(document.body);
  new ResizeObserver(aimTail).observe(el.bubble);

  // ---------- GRYPHON ----------
  function withAnswerRules(query) {
    const g = cfg.gryphon;
    const rules = String(g.answerRules || '').trim();
    if (!rules || g.answerRulesMode === 'off') return { query, inputs: g.inputs };
    if (g.answerRulesMode === 'inputs') {
      return { query, inputs: { ...(g.inputs || {}), [g.answerRulesInput || 'answer_rules']: rules } };
    }
    return { query: `${query}\n\n${rules}`, inputs: g.inputs };
  }

  const newUserId = () => `${cfg.gryphon.userPrefix}-${Date.now().toString(36)}`;
  const chat = {
    conversationId: '',
    userId: newUserId(),
    current: null,

    ask(query, onEvent) {
      this.cancel();
      const st = { controller: new AbortController(), taskId: null, timedOut: false, t0: performance.now(), first: 0 };
      st.timer = setTimeout(() => {
        st.timedOut = true;
        st.controller.abort();
      }, cfg.gryphon.timeoutMs);
      this.current = st;

      (async () => {
        try {
          for await (const ev of CX.gryphon.streamChat({
            ...cfg.gryphon,
            ...withAnswerRules(query),
            conversationId: this.conversationId,
            user: this.userId,
            signal: st.controller.signal
          })) {
            if (this.current !== st) return;
            if (ev.taskId) st.taskId = ev.taskId;
            if (ev.conversationId) this.conversationId = ev.conversationId;
            if (ev.type === 'delta' && !st.first) {
              st.first = performance.now() - st.t0;
              log(`GRYPHON 最初の文字まで ${Math.round(st.first)}ms`);
            }
            onEvent(ev);
            if (ev.type === 'error') return;
          }
          if (this.current === st) {
            log(`GRYPHON 完了 ${Math.round(performance.now() - st.t0)}ms`);
            onEvent({ type: 'done' });
          }
        } catch (err) {
          if (this.current !== st) return;
          const code = st.timedOut ? 'timeout' : err.code || 'network';
          log(`GRYPHON 失敗 (${code}) ${err.message}`);
          onEvent({ type: 'error', code, message: String(err.message || err) });
        } finally {
          clearTimeout(st.timer);
          if (this.current === st) this.current = null;
        }
      })();
    },

    cancel() {
      const st = this.current;
      if (!st) return;
      this.current = null;
      clearTimeout(st.timer);
      st.controller.abort();
      if (st.taskId) CX.gryphon.stopTask({ ...cfg.gryphon, taskId: st.taskId, user: this.userId });
    },

    reset() {
      this.cancel();
      this.conversationId = '';
      this.userId = newUserId();
    }
  };

  // ---------- 状態 ----------
  let state = 'welcome';
  let answerText = '';
  // 読み上げに合わせて表示するとき、answerText のどこまでを出しているか
  const syncText = !!cfg.tts.enabled && voice.syncText !== false;
  let shownEnd = 0;
  let showAll = false;
  let spokenChars = 0;
  let speechCut = false;
  let streamDone = false;
  let thinkingTimer = null;
  let ackTimer = null;
  function cancelAck() {
    clearTimeout(ackTimer);
    ackTimer = null;
  }
  let idleTimer = null;
  let stickToBottom = true;

  const STATUS = {
    welcome: 'ご質問をどうぞ',
    answering: 'お答えしています',
    answered: 'ほかにも気になることがあればどうぞ',
    error: 'うまくお答えできませんでした'
  };

  function setState(s) {
    state = s;
    el.app.dataset.state = s;
    if (s !== 'thinking') el.status.textContent = STATUS[s] || '';
    el.home.hidden = s === 'welcome';
    el.thinking.hidden = s !== 'thinking';
    el.answer.classList.toggle('streaming', s === 'answering' && !streamDone);
    updateStopButton();
    armIdle();
  }

  // アバターは「音が出ているか」を最優先にする。
  // 回答中でも次の文の音声を生成している間は、考え中の見た目(リングが回る)にする
  function syncAvatar() {
    el.app.classList.toggle('is-speaking', speaker.isPlaying());
    if (speaker.isPlaying()) avatar.setState('speaking');
    else if (state === 'thinking' || (state === 'answering' && speaker.isBusy())) avatar.setState('thinking');
    else if (state === 'error') avatar.setState('error');
    else avatar.setState('idle');
  }
  setInterval(syncAvatar, 100);

  function updateStopButton() {
    el.stop.hidden = !speaker.isBusy();
    syncAvatar();
  }

  function startThinkingTicker() {
    stopThinkingTicker();
    const msgs = (ui.thinkingMessages || []).filter(Boolean);
    let i = 0;
    const show = () => {
      const m = msgs[Math.min(i, msgs.length - 1)] || '';
      el.status.textContent = m;
      el.thinkingText.textContent = m;
      i++;
    };
    show();
    thinkingTimer = setInterval(show, 3500);
  }
  function stopThinkingTicker() {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }

  // ---------- 描画 ----------
  // 書きかけの強調・コードを閉じて、途中まででも記号がちらつかないようにする
  function closeMarks(md) {
    let s = md;
    for (const m of ['**', '__', '`']) if (s.split(m).length % 2 === 0) s += m;
    return s;
  }

  let rendered = -1; // 前回描画した answerText の文字数
  function renderAnswer() {
    const end = syncText ? Math.min(Math.floor(shownEnd), answerText.length) : answerText.length;
    const done = streamDone && end >= answerText.length;
    const { html, refs } = CX.renderMarkdown(done ? answerText : closeMarks(answerText.slice(0, end)), !done);
    rendered = end;
    el.answer.innerHTML = html;
    applyFade();
    el.answer.classList.toggle('streaming', state === 'answering' && !done);
    if (refs.length) showSources(refs);
    if (stickToBottom) el.area.scrollTop = el.area.scrollHeight;
  }

  // 新しく出た文字を span.fx で包んでふわっと出す。描画し直しても続きから動くように、
  // 文字ごとに出た時刻を覚えておき、その分だけ animation-delay を負にする
  const fadeMs = Math.max(0, Number(ui.fadeMs) || 0);
  el.answer.style.setProperty('--fx-ms', `${fadeMs}ms`);
  let charTimes = []; // 表示上の文字の位置 → 最初に出た時刻
  function applyFade() {
    if (!fadeMs) return;
    const now = performance.now();
    const walker = document.createTreeWalker(el.answer, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let idx = 0;
    for (const node of nodes) {
      const chars = Array.from(node.nodeValue);
      let first = -1;
      for (let k = 0; k < chars.length; k++) {
        if (charTimes[idx + k] === undefined) charTimes[idx + k] = now;
        if (first < 0 && now - charTimes[idx + k] < fadeMs) first = k;
      }
      if (first >= 0) {
        const frag = document.createDocumentFragment();
        if (first) frag.append(chars.slice(0, first).join(''));
        for (let k = first; k < chars.length; k++) {
          const age = now - charTimes[idx + k];
          if (age >= fadeMs) {
            frag.append(chars[k]);
            continue;
          }
          const sp = document.createElement('span');
          sp.className = 'fx';
          sp.textContent = chars[k];
          sp.style.animationDelay = `${-Math.round(age)}ms`;
          frag.append(sp);
        }
        node.replaceWith(frag);
      }
      idx += chars.length;
    }
    charTimes.length = Math.min(charTimes.length, idx);
  }

  // shownEnd を targetEnd まで少しずつ進める(全文が届いていても1文字ずつ出す)
  let targetEnd = 0;
  const typeRate = Math.max(1, Number(ui.typeCharsPerSec) || 40); // 文字/秒
  let rafId = 0;
  let lastTs = 0;
  function tick(now) {
    rafId = 0;
    const dt = Math.min(0.1, (now - lastTs) / 1000);
    lastTs = now;
    const target = Math.min(targetEnd, answerText.length);
    if (shownEnd < target) shownEnd = Math.min(target, shownEnd + typeRate * dt);
    if (Math.floor(shownEnd) !== rendered) renderAnswer();
    if (shownEnd < target) rafId = requestAnimationFrame(tick);
  }
  function kickTyping() {
    if (rafId) return;
    lastTs = performance.now();
    rafId = requestAnimationFrame(tick);
  }
  function resetReveal() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    shownEnd = 0;
    targetEnd = 0;
    showAll = false;
    rendered = -1;
    charTimes = [];
  }

  // 読み上げが answerText の end 文字目までに当たる部分を話し始めたので、そこまでを
  // ui.typeCharsPerSec の速さで出していく(発話の速さには合わせない)
  function reveal(end) {
    if (state !== 'thinking' && state !== 'answering') return;
    targetEnd = Math.max(targetEnd, end);
    if (state === 'thinking') {
      stopThinkingTicker();
      setState('answering');
    }
    kickTyping();
  }

  // 残りを全部出す(読み上げを止めた・打ち切った・読み上げ終わった)
  function revealAll() {
    showAll = true;
    reveal(Infinity);
  }

  function showSources(list) {
    const seen = new Set();
    const items = list.map((s) => s.title).filter((t) => t && !seen.has(t) && seen.add(t));
    el.sources.innerHTML = '';
    for (const t of items.slice(0, 6)) {
      const li = document.createElement('li');
      li.textContent = t;
      el.sources.appendChild(li);
    }
    el.sources.hidden = items.length === 0;
  }

  el.area.addEventListener('scroll', () => {
    stickToBottom = el.area.scrollTop + el.area.clientHeight >= el.area.scrollHeight - 24;
  });

  // ---------- 読み上げ ----------
  function speak(segments) {
    for (const seg of segments) {
      if (speechCut) return;
      if (spokenChars + seg.text.length > voice.maxSpeechChars) {
        speechCut = true;
        // 読み上げはここまで。残りは「続きは画面で」を話し始めたときにまとめて出す
        if (voice.cutoffPhrase) speaker.enqueue(voice.cutoffPhrase, { onStart: revealAll });
        else revealAll();
        return;
      }
      spokenChars += seg.text.length;
      if (ackTimer) cancelAck(); // 回答がすぐ来たので「確認しますので…」は言わない
      speaker.enqueue(seg.text, { onStart: () => reveal(seg.end) });
    }
  }

  // ---------- 質問 ----------
  function ask(text, presetButton) {
    const query = String(text || '').trim().slice(0, 500);
    if (!query) return;
    speaker.resume();
    speaker.stop();
    planner.reset();
    thinkFilter.reset();

    answerText = '';
    resetReveal();
    spokenChars = 0;
    speechCut = false;
    streamDone = false;
    stickToBottom = true;

    for (const b of el.presets.children) b.removeAttribute('aria-current');
    if (presetButton) presetButton.setAttribute('aria-current', 'true');

    el.welcome.hidden = true;
    el.qa.hidden = false;
    el.question.textContent = query;
    el.question.hidden = false;
    el.questionInline.textContent = query;
    el.answer.innerHTML = '';
    el.answer.classList.remove('error');
    el.sources.hidden = true;
    el.sources.innerHTML = '';
    el.input.value = '';
    el.input.blur();
    updateSend();
    el.area.scrollTop = 0;

    setState('thinking');
    startThinkingTicker();
    cancelAck();
    if (voice.ackPhrase) {
      ackTimer = setTimeout(() => {
        ackTimer = null;
        speaker.enqueue(voice.ackPhrase);
      }, Math.max(0, Number(voice.ackDelayMs) || 0));
    }

    log(`質問: ${query}`);
    chat.ask(query, onEvent);
  }

  function onEvent(ev) {
    switch (ev.type) {
      case 'delta':
        appendVisible(thinkFilter.push(ev.text));
        break;
      case 'replace':
        thinkFilter.reset();
        answerText = CX.stripThinking(ev.text);
        // 全体が差し替わると読み上げとの対応が取れないので、表示は全部出す
        if (syncText) revealAll();
        else renderAnswer();
        break;
      case 'progress':
        if (ui.showProgressTitles && ev.title && state === 'thinking') el.thinkingText.textContent = ev.title;
        break;
      case 'end':
        if (ev.sources && ev.sources.length) showSources(ev.sources);
        break;
      case 'done':
        appendVisible(thinkFilter.flush());
        streamDone = true;
        if (!answerText.trim()) return fail();
        speak(planner.flush());
        if (!syncText) {
          stopThinkingTicker();
          renderAnswer();
          if (state === 'thinking') setState('answering');
        }
        maybeFinish();
        break;
      case 'error':
        fail();
        break;
    }
  }

  // 考え中(Thinking)の部分を除いたテキストだけを画面と読み上げに回す
  function appendVisible({ text, discard }) {
    if (discard) {
      // それまでの出力も考え中だった(開始タグなしで </think> が来た)ので、なかったことにする
      log('Thinking部分を検出したので、それまでの表示を消しました');
      answerText = '';
      resetReveal();
      spokenChars = 0;
      speechCut = false;
      planner.reset();
      speaker.stop();
      el.answer.innerHTML = '';
      if (state === 'answering') {
        setState('thinking');
        startThinkingTicker();
      }
    }
    if (!text) return;
    if (!answerText && !text.trim()) return; // 考え中ブロック直後の空行は捨てる
    if (!answerText) text = text.replace(/^\s+/, '');
    if (state === 'thinking' && !syncText) {
      stopThinkingTicker();
      setState('answering');
    }
    // planner に渡す文字列と answerText を同じにしておく(seg.end が answerText の位置になる)
    answerText += text;
    if (!syncText) renderAnswer();
    else if (showAll) revealAll();
    speak(planner.push(text));
  }

  function fail() {
    stopThinkingTicker();
    cancelAck();
    streamDone = true;
    speaker.stop();
    planner.reset();
    thinkFilter.reset();
    resetReveal();
    el.answer.classList.remove('streaming');
    el.answer.classList.add('error');
    el.answer.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = ui.errorMessage;
    el.answer.appendChild(p);
    setState('error');
    speaker.enqueue(ui.errorMessage);
  }

  function maybeFinish() {
    if (!streamDone || speaker.isBusy()) return;
    if (state !== 'answering' && !(syncText && state === 'thinking')) return;
    // 読み上げなかった部分(参照リンクの行や、合成に失敗した文)も含めて全部出す
    if (syncText) revealAll();
    setState('answered');
  }

  // ---------- 操作 ----------
  function updateSend() {
    el.send.disabled = !el.input.value.trim();
  }
  el.input.addEventListener('input', () => {
    updateSend();
    armIdle();
  });
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    ask(el.input.value);
  });
  el.stop.addEventListener('click', () => {
    cancelAck();
    speaker.stop();
    speechCut = true;
    // 読み上げを止めたら、まだ出していないテキストは全部出す(以後届く分もすぐ出る)
    if (syncText) {
      if (answerText) revealAll();
      else showAll = true;
    }
  });
  el.home.addEventListener('click', () => resetToWelcome());

  function resetToWelcome() {
    chat.reset();
    stopThinkingTicker();
    cancelAck();
    speaker.stop();
    planner.reset();
    thinkFilter.reset();
    answerText = '';
    resetReveal();
    el.qa.hidden = true;
    el.question.hidden = true;
    el.welcome.hidden = false;
    el.answer.innerHTML = '';
    el.input.value = '';
    el.input.blur();
    updateSend();
    for (const b of el.presets.children) b.removeAttribute('aria-current');
    el.area.scrollTop = 0;
    setState('welcome');
    log('最初の画面に戻りました(会話をリセット)');
  }

  // 一定時間操作がなければ次の来場者向けに最初の画面へ戻す(会話履歴も破棄)
  function armIdle() {
    clearTimeout(idleTimer);
    const sec = Number(ui.idleResetSec) || 0;
    if (!sec) return;
    if (state === 'thinking' || state === 'answering') return;
    if (state === 'welcome' && !el.input.value) return;
    idleTimer = setTimeout(() => {
      if (speaker.isBusy()) return armIdle();
      resetToWelcome();
    }, sec * 1000);
  }

  // ブラウザの音声は最初のタッチまで止められているので、触れたら解除する
  for (const evName of ['pointerdown', 'keydown']) {
    window.addEventListener(evName, () => {
      speaker.resume();
      armIdle();
    }, { passive: true });
  }
  // キオスク向け: 右クリックメニュー・Ctrl+ホイール/Ctrl+±での拡大を止める
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && ['+', '-', '=', '0', ';'].includes(e.key)) e.preventDefault();
  });

  updateSend();
  setState('welcome');
})();

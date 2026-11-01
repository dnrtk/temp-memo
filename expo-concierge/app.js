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
      speechPath: '/v1/audio/speech',
      cachePath: '/cache/texts',
      params: { inference_timesteps: 5 },
      timeoutMs: 60000,
      concurrency: 1,
      cacheRefreshSec: 300,
      fuzzyMatch: 0
    },
    voice: {
      ackPhrase: '確認しますので、少々お待ちください。',
      cutoffPhrase: '続きは画面でご覧ください。',
      maxSpeechChars: 400,
      // 起動時に合成しておく決まり文句(回答ルールで使わせている締めの一文など)
      warmPhrases: ['詳しくはブーススタッフにお尋ねください。'],
      minSegmentChars: 12,
      maxSegmentChars: 90
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
    synthesize: (text) => tts.synthesize(text),
    concurrency: cfg.tts.concurrency,
    enabled: cfg.tts.enabled,
    onError: (msg) => log(`[失敗] ${msg}`),
    onBusyChange: () => {
      updateStopButton();
      maybeFinish();
    }
  });
  const thinkFilter = new CX.ThinkFilter();
  const planner = new CX.SpeechPlanner({
    cache: tts,
    minChars: voice.minSegmentChars,
    maxChars: voice.maxSegmentChars
  });

  // 起動時: キャッシュ一覧を取り、決まり文句を先に用意しておく(未キャッシュならここで生成される)
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
    await tts.refreshCache();
    for (const p of [voice.ackPhrase, voice.cutoffPhrase, ui.errorMessage, ...(voice.warmPhrases || [])]) {
      if (p) await speaker.preload(tts.resolve(p));
    }
    log('決まり文句の準備完了');
  }
  warmUp();
  if (cfg.tts.enabled && cfg.tts.cacheRefreshSec > 0) {
    setInterval(() => tts.refreshCache(), cfg.tts.cacheRefreshSec * 1000);
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
  let spokenChars = 0;
  let speechCut = false;
  let streamDone = false;
  let thinkingTimer = null;
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
  function renderAnswer() {
    const { html, refs } = CX.renderMarkdown(answerText, !streamDone);
    el.answer.innerHTML = html;
    if (refs.length) showSources(refs);
    if (stickToBottom) el.area.scrollTop = el.area.scrollHeight;
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
        if (voice.cutoffPhrase) speaker.enqueue(tts.resolve(voice.cutoffPhrase));
        return;
      }
      spokenChars += seg.text.length;
      speaker.enqueue(seg.text);
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
    if (voice.ackPhrase) speaker.enqueue(tts.resolve(voice.ackPhrase));

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
        renderAnswer();
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
        stopThinkingTicker();
        if (!answerText.trim()) return fail();
        renderAnswer();
        speak(planner.flush());
        if (state === 'thinking') setState('answering');
        el.answer.classList.remove('streaming');
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
    if (state === 'thinking') {
      stopThinkingTicker();
      setState('answering');
    }
    answerText += text;
    renderAnswer();
    speak(planner.push(text));
  }

  function fail() {
    stopThinkingTicker();
    streamDone = true;
    speaker.stop();
    planner.reset();
    thinkFilter.reset();
    el.answer.classList.remove('streaming');
    el.answer.classList.add('error');
    el.answer.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = ui.errorMessage;
    el.answer.appendChild(p);
    setState('error');
    speaker.enqueue(tts.resolve(ui.errorMessage));
  }

  function maybeFinish() {
    if (state === 'answering' && streamDone && !speaker.isBusy()) setState('answered');
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
    speaker.stop();
    speechCut = true;
  });
  el.home.addEventListener('click', () => resetToWelcome());

  function resetToWelcome() {
    chat.reset();
    stopThinkingTicker();
    speaker.stop();
    planner.reset();
    thinkFilter.reset();
    answerText = '';
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

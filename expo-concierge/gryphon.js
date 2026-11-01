'use strict';
// GRYPHON (Dify互換) の chat-messages API をブラウザから直接ストリーミングで呼ぶ。
// SSEイベントを次の単純なイベントにそろえて返す。
//   delta    : 回答テキストの追加分
//   replace  : 回答全体の差し替え(モデレーション等)
//   progress : ワークフローのノード開始(タイトル)
//   end      : 回答完了(参照元)
//   error    : エラー
(function (CX) {
  const trim = (s) => String(s || '').replace(/\/+$/, '');

  function parseBlock(raw) {
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  function toSources(metadata) {
    const res = (metadata && metadata.retriever_resources) || [];
    return res.map((r) => ({ title: r.document_name || r.dataset_name || '' })).filter((r) => r.title);
  }

  function normalize(ev) {
    const base = { taskId: ev.task_id || null, conversationId: ev.conversation_id || null };
    switch (ev.event) {
      case 'message':
      case 'agent_message':
        return ev.answer ? { ...base, type: 'delta', text: ev.answer } : null;
      case 'message_replace':
        return { ...base, type: 'replace', text: ev.answer || '' };
      case 'node_started':
        return { ...base, type: 'progress', title: (ev.data && ev.data.title) || '' };
      case 'message_end':
        return { ...base, type: 'end', sources: toSources(ev.metadata) };
      case 'workflow_finished':
        if (ev.data && ev.data.status === 'failed') {
          return { ...base, type: 'error', code: 'workflow', message: ev.data.error || 'workflow failed' };
        }
        return null;
      case 'error':
        return { ...base, type: 'error', code: 'stream', message: ev.message || ev.code || 'stream error' };
      default:
        return null;
    }
  }

  function headers(apiKey, extra) {
    return { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...extra };
  }

  async function* streamChat({ baseUrl, apiKey, query, conversationId, user, inputs, signal }) {
    const res = await fetch(`${trim(baseUrl)}/chat-messages`, {
      method: 'POST',
      headers: headers(apiKey, { Accept: 'text/event-stream' }),
      body: JSON.stringify({
        inputs: inputs || {},
        query,
        response_mode: 'streaming',
        conversation_id: conversationId || '',
        user
      }),
      signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`GRYPHON HTTP ${res.status} ${body.slice(0, 300)}`);
      err.code = 'http';
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let ended = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n?/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const ev = parseBlock(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        const out = ev && normalize(ev);
        if (!out) continue;
        if (out.type === 'end') ended = true;
        yield out;
        if (out.type === 'error') return;
      }
    }
    if (!ended) yield { type: 'end', taskId: null, conversationId: null, sources: [] };
  }

  function stopTask({ baseUrl, apiKey, taskId, user }) {
    if (!taskId) return;
    fetch(`${trim(baseUrl)}/chat-messages/${encodeURIComponent(taskId)}/stop`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ user }),
      signal: AbortSignal.timeout(5000)
    }).catch(() => {});
  }

  CX.gryphon = { streamChat, stopTask };
})((window.CX = window.CX || {}));

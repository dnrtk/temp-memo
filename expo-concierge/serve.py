#!/usr/bin/env python3
"""展示会コンシェルジュ用の小さなWebサーバ(Python標準ライブラリのみ・インストール不要)

  - このフォルダの index.html などをそのまま配信する
  - /gryphon/... を GRYPHON (Dify互換API) へ、/tts/... を AivisSpeech TTS サーバへ中継する
    → ブラウザからは同じ http://localhost:8000 に見えるので CORS の設定がいらない
    → GRYPHON の APIキーはここで付けるので、ブラウザ側に置かなくてよい
  - TTS の音声を文ごとに tts-cache/ に保存し、同じ文(と同じ声の設定)は合成せずに返す

使い方:
  python serve.py --gryphon http://gryphon.example.local/v1 --gryphon-key app-xxxx --tts http://127.0.0.1:8082
  python serve.py --mock      # GRYPHON も TTS もない状態で画面と動きを確認する

環境変数 GRYPHON_URL / GRYPHON_KEY / TTS_URL / PORT でも指定できる(start.bat はこちらを使う)。
"""
import argparse
import base64
import hashlib
import http.client
import http.server
import io
import json
import math
import os
import random
import re
import struct
import threading
import time
import urllib.parse
import wave
from pathlib import Path

ROOT = os.path.dirname(os.path.abspath(__file__))
ARGS = None


def proxy(h, base, sub, method, auth=None):
    """リクエストを base+sub に中継し、レスポンスを少しずつ流す(SSEもそのまま通る)"""
    u = urllib.parse.urlsplit(base)
    path = u.path.rstrip('/') + sub
    length = int(h.headers.get('Content-Length') or 0)
    body = h.rfile.read(length) if length else None
    headers = {
        'Content-Type': h.headers.get('Content-Type', 'application/json'),
        'Accept': h.headers.get('Accept', '*/*'),
    }
    key = auth or h.headers.get('Authorization')
    if key:
        headers['Authorization'] = key if key.lower().startswith('bearer ') else f'Bearer {key}'

    conn_cls = http.client.HTTPSConnection if u.scheme == 'https' else http.client.HTTPConnection
    conn = conn_cls(u.hostname, u.port, timeout=ARGS.timeout)
    try:
        conn.request(method, path, body=body, headers=headers)
        res = conn.getresponse()
    except Exception as e:  # 接続できない
        conn.close()
        msg = json.dumps({'error': f'upstream unreachable: {base} ({e})'}).encode()
        h.send_response(502)
        h.send_header('Content-Type', 'application/json')
        h.send_header('Content-Length', str(len(msg)))
        h.end_headers()
        h.wfile.write(msg)
        print(f'[proxy] {method} {base}{sub} -> 接続できません: {e}')
        return

    h.send_response(res.status)
    for k, v in res.getheaders():
        if k.lower() in ('transfer-encoding', 'connection', 'content-length', 'keep-alive') or k.lower().startswith('access-control-'):
            continue
        h.send_header(k, v)
    h.send_header('Connection', 'close')
    h.end_headers()
    try:
        while True:
            chunk = res.read1(8192)
            if not chunk:
                break
            h.wfile.write(chunk)
            h.wfile.flush()
    except ConnectionError:  # BrokenPipe / Reset / Aborted(Windows)
        pass  # ブラウザ側が中断(次の質問・リセット)
    finally:
        conn.close()


# ---------------------------------------------------------------- モック
MOCK_ANSWERS = [
    (r'展示|ブース',
     '本ブースでは、**お客様の環境の中で動くLLM基盤**をご紹介しています。\n\n'
     '- オンプレミスやプライベートクラウドで動く生成AI基盤\n'
     '- 社内文書を安全に検索して答えるRAG\n'
     '- Microsoft Copilot Studioとの連携デモ\n\n'
     '気になるものがあれば、ブース奥のデモ機で実際にお試しいただけます。[1]\n\n'
     '[1]: https://example.com/expo/2026 "出展概要"'),
    (r'オンプレ|メリット',
     'オンプレミスでLLMを動かす主なメリットは三つあります。\n\n'
     '1. ソースコードや設計書などの機密データを社外に出さずに使える\n'
     '2. 利用量が増えても、従量課金のように費用が膨らみにくい\n'
     '3. 業務に合わせてモデルや検索の仕組みを調整しやすい\n\n'
     '一方で、GPUなどの設備と運用体制が必要になるため、私たちは構築から運用までまとめてご支援しています。'),
    (r'導入|期間',
     '<think>\nユーザーは導入期間を聞いている。一般的には要件定義から本番まで数か月。'
     '<b>具体的な数字</b>はケースによるので幅を持たせて答える。\n</think>\n\n'
     '小さく始める場合は、ご相談から試験導入までおよそ二か月が目安です。'
     '詳しくはブーススタッフにお尋ねください。'),
    (r'(?i)copilot',
     'はい、連携できます。今お話ししているこの案内も、社内のAI基盤からCopilot Studioのエージェントを呼び出し、'
     'Web検索とSharePointの情報をもとにお答えしています。\n\n'
     '社内の閉じた環境で動くLLMと、Microsoft 365の情報を組み合わせられるのが特長です。'),
]
MOCK_DEFAULT = ('ご質問ありがとうございます。こちらはデモ用の回答です。'
                '実際の運用では、社内のSharePointとWebの情報をもとに、最新の内容でお答えします。\n\n'
                '詳しい内容は、ブースのスタッフが直接ご説明します。お気軽にお声がけください。')
MOCK_LOCK = threading.Lock()
MOCK_SEQ = [0]


MOCK_RATE = 24000


def mock_pcm(text):
    """しゃべっているように聞こえる擬似音声(PCM16 LE モノ)"""
    rate = MOCK_RATE
    dur = min(14.0, max(0.6, len(text) * 0.12))
    n = int(rate * dur)
    syl = 0.12
    amps = [0.35 + random.random() * 0.65 for _ in range(int(dur / syl) + 2)]
    phase = 0.0
    frames = bytearray()
    for i in range(n):
        t = i / rate
        k = int(t / syl)
        p = (t % syl) / syl
        env = math.sin(math.pi * p) ** 2 * amps[k]
        f0 = 170 + 25 * math.sin(t * 3.1) + 15 * amps[k]
        phase += 2 * math.pi * f0 / rate
        v = (math.sin(phase) + 0.5 * math.sin(2 * phase) + 0.25 * math.sin(3 * phase)) * 0.22 * env
        v *= min(1.0, t / 0.03, (dur - t) / 0.05)
        frames += struct.pack('<h', int(max(-1, min(1, v)) * 32767))
    return bytes(frames)


def mock_wav(text):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(MOCK_RATE)
        w.writeframes(mock_pcm(text))
    return buf.getvalue()


# ---------------------------------------------------------------- TTS キャッシュ
# /tts/v1/audio/speech/events はここで受ける。入力を文に分け、文ごとに
#   キャッシュにあれば即座に返し、なければ TTS サーバに1文ずつ合成させて保存してから返す。
# キャッシュのキーは「文 + 声のパラメータ(speaker / style / speed など)」。
SENTENCE_RE = re.compile(r'[^。！？!?\n]*(?:[。！？!?]+[」』）)"]*|\n|$)')
EVENTS_IGNORED_KEYS = ('input', 'stream_format', 'split')


def split_sentences(text: str) -> list[str]:
    out: list[str] = []
    for m in SENTENCE_RE.finditer(text):
        s = m.group(0).strip()
        if not s:
            continue
        if out and not re.search(r'\w', s):  # 「。」の後ろに残った閉じ括弧などは前の文に付ける
            out[-1] += s
        else:
            out.append(s)
    return out


class TtsError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class TtsCache:
    """文ごとの音声を <dir>/<hash>.wav に保存する。index.jsonl は人が中身を見る用"""

    def __init__(self, root: Path | None) -> None:
        self.root = root
        self.lock = threading.Lock()
        if root:
            root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def key(text: str, params: dict) -> str:
        raw = json.dumps({'text': text, 'params': params}, ensure_ascii=False, sort_keys=True)
        return hashlib.sha256(raw.encode()).hexdigest()[:32]

    def get(self, text: str, params: dict) -> tuple[int, bytes] | None:
        if not self.root:
            return None
        path = self.root / f'{self.key(text, params)}.wav'
        try:
            with wave.open(str(path), 'rb') as w:
                return w.getframerate(), w.readframes(w.getnframes())
        except FileNotFoundError:
            return None
        except (wave.Error, EOFError) as e:
            print(f'[tts cache] 壊れたキャッシュを無視します: {path.name} ({e})')
            return None

    def put(self, text: str, params: dict, rate: int, pcm: bytes) -> None:
        if not self.root or not pcm:
            return
        k = self.key(text, params)
        tmp = self.root / f'{k}.{threading.get_ident()}.tmp'
        with wave.open(str(tmp), 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(pcm)
        os.replace(tmp, self.root / f'{k}.wav')
        line = json.dumps({'key': k, 'text': text, 'params': params, 'sec': round(len(pcm) / 2 / rate, 3)}, ensure_ascii=False)
        with self.lock, (self.root / 'index.jsonl').open('a', encoding='utf-8') as f:
            f.write(line + '\n')


CACHE = TtsCache(None)


def synth_sentence(text: str, params: dict) -> tuple[int, bytes]:
    """1文を合成して (sample_rate, PCM16 LE モノ) を返す"""
    if ARGS.mock:
        pcm = mock_pcm(text)
        time.sleep(len(pcm) / 2 / MOCK_RATE * 0.9)  # 実機の RTF に合わせて遅くしておく
        return MOCK_RATE, pcm
    u = urllib.parse.urlsplit(ARGS.tts)
    conn_cls = http.client.HTTPSConnection if u.scheme == 'https' else http.client.HTTPConnection
    conn = conn_cls(u.hostname, u.port, timeout=ARGS.timeout)
    body = json.dumps({**params, 'input': text, 'stream_format': 'ndjson'}, ensure_ascii=False).encode()
    try:
        conn.request('POST', '/v1/audio/speech/events', body=body, headers={'Content-Type': 'application/json'})
        res = conn.getresponse()
        if res.status != 200:
            raise TtsError(res.status, res.read().decode('utf-8', 'replace')[:300])
        rate, pcm = 48000, bytearray()
        for line in res:
            if not line.strip():
                continue
            ev = json.loads(line)
            if ev['type'] == 'start':
                rate = ev.get('sample_rate', rate)
            elif ev['type'] == 'audio':
                pcm += base64.b64decode(ev['audio'])
            elif ev['type'] == 'error':
                raise TtsError(ev.get('status', 502), ev.get('message', ''))
        return rate, bytes(pcm)
    except (OSError, http.client.HTTPException, ValueError) as e:
        raise TtsError(502, f'upstream unreachable: {ARGS.tts} ({e})') from e
    finally:
        conn.close()


def tts_events(h):
    """AivisSpeech の /v1/audio/speech/events と同じ NDJSON を、キャッシュを挟んで返す"""
    length = int(h.headers.get('Content-Length') or 0)
    try:
        body = json.loads(h.rfile.read(length) or b'{}') if length else {}
        if not isinstance(body, dict):
            raise ValueError('body must be an object')
    except ValueError as e:
        return send_json(h, {'error': {'message': f'invalid JSON: {e}', 'type': 'invalid_request_error'}}, 400)
    params = {k: v for k, v in body.items() if k not in EVENTS_IGNORED_KEYS}
    sentences = split_sentences(str(body.get('input', '')))
    if not sentences:
        return send_json(h, {'error': {'message': 'input is empty', 'type': 'invalid_request_error'}}, 400)

    started = False

    def send(obj):
        h.wfile.write((json.dumps(obj, ensure_ascii=False) + '\n').encode())
        h.wfile.flush()

    t_start = time.time()
    offset = 0.0
    gen_total = 0.0
    try:
        for i, sentence in enumerate(sentences):
            t0 = time.time()
            hit = CACHE.get(sentence, params)
            if hit:
                rate, pcm = hit
            else:
                try:
                    rate, pcm = synth_sentence(sentence, params)
                except TtsError as e:
                    print(f'[tts] 失敗 {e.status}: {e.message} ({sentence})')
                    if not started:
                        return send_json(h, {'error': {'message': e.message, 'type': 'upstream_error'}}, e.status)
                    return send({'type': 'error', 'status': e.status, 'message': e.message})
                CACHE.put(sentence, params, rate, pcm)
            gen = time.time() - t0
            gen_total += gen
            dur = len(pcm) / 2 / rate
            print(f'[tts] {"キャッシュ" if hit else f"生成 {gen:.1f}s"} {dur:.1f}s音声: {sentence}')
            if not started:
                h.send_response(200)
                h.send_header('Content-Type', 'application/x-ndjson')
                h.end_headers()
                send({'type': 'start', 'sample_rate': rate, 'encoding': 'pcm_s16le', 'channels': 1, 'sentences': len(sentences)})
                started = True
            send({'type': 'audio', 'index': i, 'text': sentence, 'audio': base64.b64encode(pcm).decode(),
                  'sample_rate': rate, 'cached': bool(hit), 'duration_sec': round(dur, 3),
                  'offset_sec': round(offset, 3), 'gen_sec': round(gen, 3), 'elapsed_sec': round(time.time() - t_start, 3)})
            offset += dur
        send({'type': 'done', 'sentences': len(sentences), 'audio_sec': round(offset, 3),
              'gen_sec': round(gen_total, 3), 'rtf': round(gen_total / offset, 3) if offset else 0})
    except ConnectionError:  # BrokenPipe / Reset / Aborted(Windows)
        pass  # ブラウザ側が中断(次の質問・リセット)。残りの文は合成しない


def send_json(h, obj, status=200):
    data = json.dumps(obj, ensure_ascii=False).encode()
    h.send_response(status)
    h.send_header('Content-Type', 'application/json; charset=utf-8')
    h.send_header('Content-Length', str(len(data)))
    h.end_headers()
    h.wfile.write(data)


def mock(h, method):
    path = urllib.parse.urlsplit(h.path).path
    length = int(h.headers.get('Content-Length') or 0)
    body = json.loads(h.rfile.read(length) or b'{}') if length else {}

    if method == 'GET' and path == '/tts/health':
        return send_json(h, {'engine': 'mock', 'status': 'ok'})

    if method == 'POST' and path == '/tts/v1/audio/speech':
        text = str(body.get('input', ''))
        time.sleep(0.2 + len(text) * 0.03)
        print(f'[mock tts] 一括: {text}')
        wav = mock_wav(text)
        h.send_response(200)
        h.send_header('Content-Type', 'audio/wav')
        h.send_header('Content-Length', str(len(wav)))
        h.end_headers()
        h.wfile.write(wav)
        return

    if method == 'POST' and re.fullmatch(r'/gryphon/chat-messages/[^/]+/stop', path):
        return send_json(h, {'result': 'success'})

    if method == 'POST' and path == '/gryphon/chat-messages':
        query = str(body.get('query', ''))
        with MOCK_LOCK:
            MOCK_SEQ[0] += 1
            seq = MOCK_SEQ[0]
        task, msg = f'task-{seq}', f'msg-{seq}'
        conv = body.get('conversation_id') or f'conv-{int(time.time())}'
        print(f'[mock chat] user={body.get("user")} inputs={body.get("inputs")}\n  q={query!r}')
        h.send_response(200)
        h.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        h.send_header('Cache-Control', 'no-cache')
        h.end_headers()

        def send(obj):
            h.wfile.write(f'data: {json.dumps(obj, ensure_ascii=False)}\n\n'.encode())
            h.wfile.flush()

        try:
            if re.search(r'エラー|(?i:error)', query):
                time.sleep(0.8)
                return send({'event': 'error', 'task_id': task, 'message': 'mock error', 'code': 'mock'})
            send({'event': 'workflow_started', 'task_id': task, 'conversation_id': conv, 'data': {}})
            send({'event': 'node_started', 'task_id': task, 'conversation_id': conv, 'data': {'title': '開始'}})
            time.sleep(0.9)
            send({'event': 'node_started', 'task_id': task, 'conversation_id': conv, 'data': {'title': 'Copilot Studio エージェント'}})
            time.sleep(0.9)
            question = query.split('【回答ルール】')[0]  # 末尾に付いた回答ルールは照合に使わない
            text = next((a for p, a in MOCK_ANSWERS if re.search(p, question)), MOCK_DEFAULT)
            i = 0
            while i < len(text):
                k = random.randint(2, 6)
                send({'event': 'message', 'task_id': task, 'message_id': msg, 'conversation_id': conv, 'answer': text[i:i + k]})
                i += k
                time.sleep(0.035 + random.random() * 0.04)
            send({'event': 'message_end', 'task_id': task, 'message_id': msg, 'conversation_id': conv, 'metadata': {}})
            send({'event': 'workflow_finished', 'task_id': task, 'conversation_id': conv, 'data': {'status': 'succeeded'}})
        except ConnectionError:  # BrokenPipe / Reset / Aborted(Windows)
            pass
        return

    h.send_error(404)


# ---------------------------------------------------------------- サーバ
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _route(self, method):
        p = self.path
        if not (p.startswith('/gryphon/') or p.startswith('/tts/')):
            return False
        if method == 'POST' and urllib.parse.urlsplit(p).path == '/tts/v1/audio/speech/events':
            tts_events(self)
        elif ARGS.mock:
            mock(self, method)
        elif p.startswith('/gryphon/'):
            if not ARGS.gryphon:
                self.send_error(502, 'GRYPHON_URL is not set')
            else:
                proxy(self, ARGS.gryphon, p[len('/gryphon'):], method, auth=ARGS.gryphon_key)
        else:
            if not ARGS.tts:
                self.send_error(502, 'TTS_URL is not set')
            else:
                proxy(self, ARGS.tts, p[len('/tts'):], method)
        return True

    def do_GET(self):
        if not self._route('GET'):
            super().do_GET()

    def do_POST(self):
        if not self._route('POST'):
            self.send_error(404)

    def log_message(self, fmt, *args):
        if ARGS.verbose:
            super().log_message(fmt, *args)


def main():
    global ARGS
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=int(os.environ.get('PORT', 8000)))
    ap.add_argument('--host', default='127.0.0.1', help='他のPCから見せるなら 0.0.0.0')
    ap.add_argument('--gryphon', default=os.environ.get('GRYPHON_URL', ''), help='例: http://gryphon.example.local/v1')
    ap.add_argument('--gryphon-key', default=os.environ.get('GRYPHON_KEY', ''))
    ap.add_argument('--tts', default=os.environ.get('TTS_URL', 'http://127.0.0.1:8082'))
    ap.add_argument('--timeout', type=float, default=180, help='中継先への接続・無応答のタイムアウト秒')
    ap.add_argument('--mock', action='store_true', help='GRYPHON と TTS をモックで代用する')
    ap.add_argument('--cache-dir', default=os.environ.get('TTS_CACHE_DIR', ''),
                    help='文ごとの音声の保存先(既定: このフォルダの tts-cache/。モック時は tts-cache-mock/)')
    ap.add_argument('--no-cache', action='store_true', help='TTS の音声を保存・再利用しない')
    ap.add_argument('-v', '--verbose', action='store_true')
    ARGS = ap.parse_args()
    global CACHE
    if not ARGS.no_cache:
        default_dir = 'tts-cache-mock' if ARGS.mock else 'tts-cache'
        CACHE = TtsCache(Path(ARGS.cache_dir) if ARGS.cache_dir else Path(ROOT) / default_dir)
    # TTS サーバは /v1/audio/speech と /health がルートにあるので、ホストとポートだけを使う
    # (TTS_URL=http://localhost:8082/v1 のように書かれていても /v1/v1/... にならないように)
    if ARGS.tts:
        t = urllib.parse.urlsplit(ARGS.tts)
        if t.path.strip('/'):
            print(f'  ※ TTS_URL のパス部分 ({t.path}) は使いません')
        ARGS.tts = f'{t.scheme}://{t.netloc}'

    srv = http.server.ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    srv.daemon_threads = True
    print(f'展示会コンシェルジュ: http://localhost:{ARGS.port}/   (Ctrl+C で終了)')
    if ARGS.mock:
        print('  モード: モック(GRYPHON・TTSとも擬似応答)')
    else:
        print(f'  GRYPHON: {ARGS.gryphon or "(未設定)"}   APIキー: {"あり" if ARGS.gryphon_key else "なし"}')
        print(f'  TTS    : {ARGS.tts}')
    print(f'  TTSキャッシュ: {CACHE.root or "なし"}')
    print(f'  動作ログ付きで開く: http://localhost:{ARGS.port}/?debug')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()

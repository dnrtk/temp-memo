#!/usr/bin/env python3
"""AivisSpeech Engine を VoxCPM2_server と同じ HTTP I/F で公開するアダプタ(標準ライブラリのみ)。

- POST /v1/audio/speech        : {"input": ...} → WAV(PCM16 モノ)。AivisSpeech の audio_query → synthesis に変換する
- POST /v1/audio/speech/stream : 文ごとに合成して WAV をチャンク転送する(上流自体はストリーミング非対応)
- GET  /health, /v1/audio/speech/models, /license
- キャッシュは持たない(/cache/* は 404)。

商用利用のためのライセンスゲート: 合成に使う声モデルの license(AIVM マニフェスト)が
LICENSE_ALLOW の接頭辞に一致しない場合、合成を拒否する(fail-closed)。
"""
from __future__ import annotations

import array
import base64
import http.client
import io
import json
import math
import os
import re
import struct
import sys
import threading
import time
import wave
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import quote, urlsplit

UPSTREAM_HOST: str = os.environ.get("UPSTREAM_HOST") or "aivisspeech"
UPSTREAM_PORT: int = int(os.environ.get("UPSTREAM_PORT") or "10101")
LISTEN_PORT: int = int(os.environ.get("PORT") or "8080")

DEFAULT_SPEAKER: str = (os.environ.get("DEFAULT_SPEAKER") or "").strip()
DEFAULT_STYLE: str = (os.environ.get("DEFAULT_STYLE") or "ノーマル").strip()
_rate_raw = (os.environ.get("OUTPUT_SAMPLE_RATE") or "").strip()
OUTPUT_SAMPLE_RATE: int | None = int(_rate_raw) if _rate_raw else None  # None = エンジンのネイティブ(44100)
_rms_raw = (os.environ.get("OUTPUT_RMS_DBFS") or "").strip()
OUTPUT_RMS_DBFS: float | None = float(_rms_raw) if _rms_raw else None
PEAK_LIMIT_DBFS = -1.0
# 区切りは ; 。ACML-NC など非営利ライセンスは接頭辞が一致しないため拒否される
LICENSE_ALLOW: list[str] = [s.strip() for s in (os.environ.get("LICENSE_ALLOW") or "# Aivis Common Model License (ACML)").split(";") if s.strip()]

SPEECH_PATH = "/v1/audio/speech"
STREAM_PATH = "/v1/audio/speech/stream"
MODELS_PATH = "/v1/audio/speech/models"
META_TTL_SEC = 30.0
# VoxCPM2 版にあって、こちらでは意味を持たないパラメータ(エラーにせず無視して X-TTS-Ignored-Params で通知)
IGNORED_PARAMS = ("inference_timesteps", "cfg_value", "seed", "temperature", "max_steps",
                  "reference_audio", "prompt_text")
# リクエストのキー → audio_query のキー
QUERY_PARAMS = {
    "speed": "speedScale", "intonation_scale": "intonationScale", "tempo_dynamics_scale": "tempoDynamicsScale",
    "pitch_scale": "pitchScale", "volume_scale": "volumeScale",
    "pre_phoneme_length": "prePhonemeLength", "post_phoneme_length": "postPhonemeLength",
}
SENTENCE_SPLIT = re.compile(r"(?<=[。！？!?\n])")
CLAUSE_SPLIT = re.compile(r"(?<=[。！？!?\n、，,])")  # 読点でも区切る(先頭が早く出る代わりに抑揚は不自然になりやすい)
EVENTS_PATH = "/v1/audio/speech/events"
VOICE_PROMPT = re.compile(r"^\s*[(（][^)）]*[)）]\s*")


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


class ApiError(Exception):
    def __init__(self, status: int, message: str, etype: str = "invalid_request_error") -> None:
        super().__init__(message)
        self.status, self.message, self.etype = status, message, etype


# --- 上流(AivisSpeech Engine)呼び出し ---
def upstream(method: str, path: str, body: bytes | None = None, timeout: float | None = None) -> tuple[int, bytes]:
    conn = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=timeout)
    try:
        headers = {"Content-Type": "application/json"} if body is not None else {}
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        return resp.status, resp.read()
    except OSError as e:
        raise ApiError(502, f"upstream {UPSTREAM_HOST}:{UPSTREAM_PORT} unreachable: {e}", "upstream_error") from e
    finally:
        conn.close()


def upstream_json(path: str) -> Any:
    status, data = upstream("GET", path, timeout=30)
    if status != 200:
        raise ApiError(502, f"upstream GET {path} returned {status}", "upstream_error")
    return json.loads(data)


class Meta:
    """話者一覧と声モデルのライセンスを短時間キャッシュする(モデル追加・削除に追従するため TTL つき)。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._at = 0.0
        self.styles: dict[int, dict[str, Any]] = {}
        self.speakers: list[dict[str, Any]] = []

    def refresh(self, force: bool = False) -> None:
        with self._lock:
            if not force and time.monotonic() - self._at < META_TTL_SEC and self.styles:
                return
            speakers = upstream_json("/speakers")
            models = upstream_json("/aivm_models")
            # AIVM マニフェストの speaker uuid → モデル情報
            by_speaker: dict[str, tuple[str, dict[str, Any]]] = {}
            for model_uuid, info in models.items():
                for sp in info.get("manifest", {}).get("speakers", []):
                    by_speaker[sp["uuid"]] = (model_uuid, info["manifest"])
            styles: dict[int, dict[str, Any]] = {}
            out: list[dict[str, Any]] = []
            for sp in speakers:
                model_uuid, manifest = by_speaker.get(sp["speaker_uuid"], ("", {}))
                lic = str(manifest.get("license") or "")
                allowed, reason = license_verdict(lic)
                entry = {"name": sp["name"], "model_uuid": model_uuid, "model_version": manifest.get("version"),
                         "license_title": first_line(lic), "license_allowed": allowed, "license_reason": reason,
                         "styles": [{"name": st["name"], "id": st["id"]} for st in sp["styles"] if st.get("type", "talk") == "talk"]}
                out.append(entry)
                for st in entry["styles"]:
                    styles[st["id"]] = {"speaker": sp["name"], "style": st["name"], **{k: entry[k] for k in
                                        ("model_uuid", "license_title", "license_allowed", "license_reason")}}
            self.styles, self.speakers, self._at = styles, out, time.monotonic()


def first_line(text: str) -> str:
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return ""


def license_verdict(text: str) -> tuple[bool, str]:
    title = first_line(text)
    if not title:
        return False, "license text is empty"
    if "NC" in title.upper().replace("(ACML)", ""):
        return False, f"non-commercial license: {title}"
    if not any(title.startswith(p) for p in LICENSE_ALLOW):
        return False, f"license '{title}' is not in LICENSE_ALLOW"
    return True, "ok"


META = Meta()
SYNTH_LOCK = threading.Lock()  # 推論は CPU を使い切るので 1 件ずつ処理する


def resolve_style(req: dict[str, Any]) -> int:
    """リクエストの speaker / voice / style から style id を決める。既定は DEFAULT_SPEAKER / DEFAULT_STYLE。"""
    META.refresh()
    speaker = req.get("speaker", req.get("voice"))
    style = req.get("style")
    if isinstance(speaker, int) and not isinstance(speaker, bool):
        sid = speaker
    elif isinstance(speaker, str) and speaker.strip().lstrip("-").isdigit():
        sid = int(speaker)
    else:
        name = (speaker if isinstance(speaker, str) and speaker.strip() else DEFAULT_SPEAKER)
        if not name:
            raise ApiError(400, "no speaker specified and DEFAULT_SPEAKER is not set; "
                                "see GET /v1/audio/speech/models for available speakers")
        want_style = style if isinstance(style, str) and style.strip() else DEFAULT_STYLE
        sid_or_none = next((st["id"] for sp in META.speakers if sp["name"] == name
                            for st in sp["styles"] if st["name"] == want_style), None)
        if sid_or_none is None:
            raise ApiError(400, f"speaker/style not found: {name}/{want_style}")
        sid = sid_or_none
    info = META.styles.get(sid)
    if info is None:
        raise ApiError(400, f"unknown style id: {sid}")
    if not info["license_allowed"]:
        raise ApiError(403, f"voice model '{info['speaker']}' is blocked by the license gate: {info['license_reason']}",
                       "license_error")
    return sid


# --- 音声処理 ---
def wav_pcm(data: bytes) -> tuple[bytes, int]:
    """WAV(PCM16 モノ)から (PCM バイト列, サンプルレート) を取り出す。"""
    with wave.open(io.BytesIO(data)) as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ApiError(502, f"unexpected WAV format from upstream: {w.getnchannels()}ch {w.getsampwidth() * 8}bit",
                           "upstream_error")
        return w.readframes(w.getnframes()), w.getframerate()


def make_wav(pcm: bytes, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def normalize_pcm(pcm: bytes, target_rms_dbfs: float) -> tuple[bytes, float]:
    """PCM16 モノを RMS 基準で目標音量に揃える。(新しい PCM, 適用したゲイン dB)。ピークは PEAK_LIMIT_DBFS まで。"""
    samples = array.array("h")
    samples.frombytes(pcm)
    if sys.byteorder == "big":
        samples.byteswap()
    if not samples:
        return pcm, 0.0
    rms = math.sqrt(sum(x * x for x in samples) / len(samples))
    peak = max(abs(x) for x in samples)
    if rms < 1 or peak == 0:
        return pcm, 0.0
    gain = min(10 ** (target_rms_dbfs / 20) * 32768 / rms, 10 ** (PEAK_LIMIT_DBFS / 20) * 32768 / peak)
    if abs(gain - 1) < 0.01:
        return pcm, 0.0
    out = array.array("h", (max(-32768, min(32767, round(x * gain))) for x in samples))
    if sys.byteorder == "big":
        out.byteswap()
    return out.tobytes(), 20 * math.log10(gain)


def pcm16_to_f32le(pcm: bytes) -> bytes:
    s = array.array("h")
    s.frombytes(pcm)
    if sys.byteorder == "big":
        s.byteswap()
    f = array.array("f", (x / 32768.0 for x in s))
    if sys.byteorder == "big":
        f.byteswap()
    return f.tobytes()


# --- 合成 ---
def parse_request(body: bytes) -> dict[str, Any]:
    try:
        req = json.loads(body)
    except ValueError as e:
        raise ApiError(400, f"invalid JSON: {e}") from e
    if not isinstance(req, dict):
        raise ApiError(400, "request body must be a JSON object")
    if not isinstance(req.get("input"), str) or not req["input"].strip():
        raise ApiError(500, '"input" is required')  # VoxCPM2 版(上流の仕様)に合わせて 500
    fmt = req.get("response_format", "wav")
    if fmt not in ("wav", "pcm"):
        raise ApiError(400, "response_format must be 'wav' or 'pcm'")
    for k in QUERY_PARAMS:
        v = req.get(k)
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float))):
            raise ApiError(400, f"{k} must be a number")
    return req


def synth_pcm(text: str, style_id: int, overrides: dict[str, float]) -> tuple[bytes, int]:
    """1 回分の audio_query → synthesis。呼び出し側が SYNTH_LOCK を保持していること。"""
    status, data = upstream("POST", f"/audio_query?speaker={style_id}&text={quote(text)}", timeout=None)
    if status != 200:
        raise ApiError(502, f"upstream audio_query failed ({status}): {data[:300].decode('utf-8', 'replace')}", "upstream_error")
    query = json.loads(data)
    if OUTPUT_SAMPLE_RATE is not None:
        query["outputSamplingRate"] = OUTPUT_SAMPLE_RATE
    query.update(overrides)
    status, wav = upstream("POST", f"/synthesis?speaker={style_id}", json.dumps(query).encode(), timeout=None)
    if status != 200:
        raise ApiError(502, f"upstream synthesis failed ({status}): {wav[:300].decode('utf-8', 'replace')}", "upstream_error")
    return wav_pcm(wav)


def _load_query_defaults() -> dict[str, float]:
    """DEFAULT_SPEED などの環境変数から、リクエストで省略されたときの既定値を読む。"""
    out: dict[str, float] = {}
    for k, qk in QUERY_PARAMS.items():
        raw = (os.environ.get(f"DEFAULT_{k.upper()}") or "").strip()
        if raw:
            out[qk] = float(raw)
    return out


QUERY_DEFAULTS: dict[str, float] = _load_query_defaults()


def query_overrides(req: dict[str, Any]) -> dict[str, float]:
    """環境変数の既定値の上に、リクエストの指定を重ねる(リクエスト優先)。"""
    return {**QUERY_DEFAULTS, **{QUERY_PARAMS[k]: float(req[k]) for k in QUERY_PARAMS if req.get(k) is not None}}


def prepare_text(req: dict[str, Any]) -> tuple[str, bool]:
    """文頭の「(声の説明)」は VoxCPM2 の声デザイン用の記法。AivisSpeech では読み上げてしまうので取り除く。"""
    text = req["input"].strip()
    stripped = VOICE_PROMPT.sub("", text, count=1).strip()
    if stripped != text and stripped:
        return stripped, True
    return text, False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "aivisspeech-api"

    def log_message(self, fmt: str, *args: Any) -> None:
        log(f"{self.address_string()} {fmt % args}")

    def _send_bytes(self, status: int, body: bytes, ctype: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, obj: Any) -> None:
        self._send_bytes(status, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _send_error(self, e: ApiError) -> None:
        self._send_json(e.status, {"error": {"message": e.message, "type": e.etype}})

    def _extra_headers(self, req: dict[str, Any], voice_stripped: bool) -> dict[str, str]:
        extra = {"X-TTS-Cache": "BYPASS"}
        ignored = [k for k in IGNORED_PARAMS if k in req]
        if ignored:
            extra["X-TTS-Ignored-Params"] = ",".join(ignored)
        if voice_stripped:
            extra["X-TTS-Voice-Prompt-Stripped"] = "1"
        return extra

    # --- /v1/audio/speech ---
    def _speech(self, body: bytes) -> None:
        req = parse_request(body)
        style_id = resolve_style(req)
        text, stripped = prepare_text(req)
        t0 = time.monotonic()
        with SYNTH_LOCK:
            pcm, rate = synth_pcm(text, style_id, query_overrides(req))
        extra = self._extra_headers(req, stripped)
        extra["X-TTS-Style-Id"] = str(style_id)
        if req.get("response_format", "wav") == "pcm":
            out, ctype = pcm16_to_f32le(pcm), "application/octet-stream"
        else:
            if OUTPUT_RMS_DBFS is not None:
                pcm, gain_db = normalize_pcm(pcm, OUTPUT_RMS_DBFS)
                extra["X-TTS-Gain-DB"] = f"{gain_db:.1f}"
            out, ctype = make_wav(pcm, rate), "audio/wav"
        sec = len(pcm) / 2 / rate
        gen = time.monotonic() - t0
        log(f"speech style={style_id} audio={sec:.1f}s gen={gen:.1f}s rtf={gen / sec if sec else 0:.2f} text={text[:30]!r}")
        self._send_bytes(200, out, ctype, extra)

    # --- /v1/audio/speech/stream ---
    def _stream(self, body: bytes) -> None:
        req = parse_request(body)
        style_id = resolve_style(req)
        text, stripped = prepare_text(req)
        pieces = [p.strip() for p in SENTENCE_SPLIT.split(text) if p.strip()] or [text]
        overrides = query_overrides(req)

        def one(i: int) -> tuple[bytes, int]:
            # 文の継ぎ目に無音が積み上がらないよう、明示指定がなければ先頭文以外の前余白・末尾文以外の後余白を 0 にする
            o = dict(overrides)
            if i > 0:
                o.setdefault("prePhonemeLength", 0.0)
            if i < len(pieces) - 1:
                o.setdefault("postPhonemeLength", 0.0)
            with SYNTH_LOCK:
                return synth_pcm(pieces[i], style_id, o)

        first_pcm, rate = one(0)  # 先頭が失敗したら、ヘッダ送信前に通常のエラー応答を返せる
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("X-TTS-Style-Id", str(style_id))
        for k, v in self._extra_headers(req, stripped).items():
            self.send_header(k, v)
        self.end_headers()

        def chunk(b: bytes) -> None:
            self.wfile.write(b"%x\r\n%b\r\n" % (len(b), b))
            self.wfile.flush()

        # サイズ不定の WAV ヘッダ(VoxCPM2 版と同じ流儀)
        chunk(b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
              + b"data" + struct.pack("<I", 0xFFFFFFFF))
        try:
            chunk(first_pcm)
            for i in range(1, len(pieces)):
                pcm, _ = one(i)
                chunk(pcm)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            log("client disconnected during stream")
            self.close_connection = True
        except ApiError as e:
            # ヘッダ送信後は応答を差し替えられない。終端チャンクを送らず切断し、クライアントに異常を伝える
            log(f"stream aborted: {e.message}")
            self.close_connection = True

    # --- /v1/audio/speech/events (NDJSON / SSE) ---
    def _events(self, body: bytes) -> None:
        """文ごとの PCM(base64)と文テキスト・時間情報をイベントで返す。字幕同期やバッファ制御向け。"""
        req = parse_request(body)
        fmt = req.get("stream_format", "ndjson")
        split = req.get("split", "sentence")
        if fmt not in ("ndjson", "sse") or split not in ("sentence", "clause"):
            raise ApiError(400, "stream_format must be 'ndjson' or 'sse'; split must be 'sentence' or 'clause'")
        style_id = resolve_style(req)
        text, stripped = prepare_text(req)
        splitter = CLAUSE_SPLIT if split == "clause" else SENTENCE_SPLIT
        pieces = [p.strip() for p in splitter.split(text) if p.strip()] or [text]
        overrides = query_overrides(req)

        def one(i: int) -> tuple[bytes, int, float]:
            o = dict(overrides)
            if i > 0:
                o.setdefault("prePhonemeLength", 0.0)
            if i < len(pieces) - 1:
                o.setdefault("postPhonemeLength", 0.0)
            t0 = time.monotonic()
            with SYNTH_LOCK:
                pcm, rate = synth_pcm(pieces[i], style_id, o)
            return pcm, rate, time.monotonic() - t0

        first = one(0)  # 先頭が失敗したら、ヘッダ送信前に通常のエラー応答を返せる
        ctype = "text/event-stream" if fmt == "sse" else "application/x-ndjson"
        self.send_response(200)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("X-TTS-Style-Id", str(style_id))
        for k, v in self._extra_headers(req, stripped).items():
            self.send_header(k, v)
        self.end_headers()

        def emit(event: dict[str, Any]) -> None:
            line = json.dumps(event, ensure_ascii=False)
            payload = (f"event: {event['type']}\ndata: {line}\n\n" if fmt == "sse" else line + "\n").encode()
            self.wfile.write(b"%x\r\n%b\r\n" % (len(payload), payload))
            self.wfile.flush()

        t_start = time.monotonic()
        offset = 0.0
        try:
            rate = first[1]
            emit({"type": "start", "sample_rate": rate, "encoding": "pcm_s16le", "channels": 1,
                  "speaker_style_id": style_id, "sentences": len(pieces)})
            for i in range(len(pieces)):
                pcm, rate, gen = first if i == 0 else one(i)
                dur = len(pcm) / 2 / rate
                emit({"type": "audio", "index": i, "text": pieces[i], "audio": base64.b64encode(pcm).decode("ascii"),
                      "duration_sec": round(dur, 3), "offset_sec": round(offset, 3), "gen_sec": round(gen, 3),
                      "elapsed_sec": round(time.monotonic() - t_start, 3)})
                offset += dur
            total = time.monotonic() - t_start
            emit({"type": "done", "sentences": len(pieces), "audio_sec": round(offset, 3),
                  "gen_sec": round(total, 3), "rtf": round(total / offset, 3) if offset else None})
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except ApiError as e:
            log(f"events aborted: {e.message}")
            try:
                emit({"type": "error", "status": e.status, "message": e.message})
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except OSError:
                self.close_connection = True
        except (BrokenPipeError, ConnectionResetError):
            log("client disconnected during events")
            self.close_connection = True
        log(f"events style={style_id} sentences={len(pieces)} audio={offset:.1f}s gen={time.monotonic() - t_start:.1f}s")

    # --- 情報系 ---
    def _health(self) -> None:
        try:
            status, _ = upstream("GET", "/version", timeout=3)
        except ApiError as e:
            if isinstance(e.__cause__, TimeoutError):
                self._send_json(200, {"engine": "aivisspeech", "status": "ok", "busy": True})
            else:
                self._send_json(503, {"engine": "aivisspeech", "status": "unavailable", "detail": e.message})
            return
        self._send_json(200 if status == 200 else 503, {"engine": "aivisspeech", "status": "ok" if status == 200 else "error"})

    def _models(self) -> None:
        META.refresh(force=True)
        rate = OUTPUT_SAMPLE_RATE or 44100
        self._send_json(200, {"object": "list", "data": [{
            "id": "aivisspeech", "object": "model", "sample_rate": rate,
            "default_speaker": DEFAULT_SPEAKER, "default_style": DEFAULT_STYLE,
            "license_allow": LICENSE_ALLOW, "speakers": META.speakers}]})

    def _license(self) -> None:
        models = upstream_json("/aivm_models")
        self._send_json(200, {k: {"name": v["manifest"].get("name"), "version": v["manifest"].get("version"),
                                  "license": v["manifest"].get("license")} for k, v in models.items()})

    def _dispatch(self, fn: Any) -> None:
        try:
            fn()
        except ApiError as e:
            log(f"error {e.status}: {e.message}")
            self._send_error(e)
        except Exception as e:  # noqa: BLE001 - 想定外は 500 で返し、ログに残す
            log(f"unexpected error: {e!r}")
            self._send_error(ApiError(500, f"internal error: {e}", "server_error"))

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/health":
            self._dispatch(self._health)
        elif path == MODELS_PATH:
            self._dispatch(self._models)
        elif path == "/license":
            self._dispatch(self._license)
        elif path.startswith("/cache/"):
            self._send_json(404, {"error": "cache is disabled"})
        else:
            self._send_json(404, {"error": f"not found: {path}"})

    def do_POST(self) -> None:
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            self._send_json(411, {"error": "chunked request bodies are not supported; send Content-Length"})
            return
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        path = urlsplit(self.path).path
        if path == SPEECH_PATH:
            self._dispatch(lambda: self._speech(body))
        elif path == STREAM_PATH:
            self._dispatch(lambda: self._stream(body))
        elif path == EVENTS_PATH:
            self._dispatch(lambda: self._events(body))
        else:
            self._send_json(404, {"error": f"not found: {path}"})


def startup_report() -> None:
    """起動時に利用可能な声とライセンス判定をログに出す(エンジンが未準備でも落ちない)。"""
    try:
        META.refresh(force=True)
    except ApiError as e:
        log(f"WARNING: cannot read speakers yet ({e.message}); will retry on demand")
        return
    for sp in META.speakers:
        log(f"voice: {sp['name']} license={sp['license_title']!r} -> {'ALLOWED' if sp['license_allowed'] else 'BLOCKED: ' + sp['license_reason']}")
    default = next((sp for sp in META.speakers if sp["name"] == DEFAULT_SPEAKER), None)
    if not DEFAULT_SPEAKER:
        log("WARNING: DEFAULT_SPEAKER is empty; requests must specify 'speaker'")
    elif default is None:
        log(f"WARNING: DEFAULT_SPEAKER={DEFAULT_SPEAKER!r} is not installed")
    elif not default["license_allowed"]:
        log(f"WARNING: DEFAULT_SPEAKER={DEFAULT_SPEAKER!r} is BLOCKED by the license gate; synthesis will return 403")


def main() -> None:
    log(f"license gate: allow prefixes {LICENSE_ALLOW}")
    log(f"query defaults: {QUERY_DEFAULTS or 'engine defaults'}")
    log(f"output: sample_rate={OUTPUT_SAMPLE_RATE or 'native'} rms={OUTPUT_RMS_DBFS if OUTPUT_RMS_DBFS is not None else 'unchanged'}")
    startup_report()
    log(f"listening on :{LISTEN_PORT} -> upstream {UPSTREAM_HOST}:{UPSTREAM_PORT}")
    srv = ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler)
    srv.daemon_threads = True
    srv.serve_forever()


if __name__ == "__main__":
    main()

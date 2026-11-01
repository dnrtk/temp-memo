#!/usr/bin/env python3
"""VoxCPM2 サーバの前段に置く、音声キャッシュ付きリバースプロキシ(標準ライブラリのみ)。

- POST /v1/audio/speech: 入力テキスト+生成パラメータが同一なら、保存済みの音声をそのまま返す。
  ミスなら上流(llama-tts-server)で生成し、成功した応答だけを保存する。
- GET /cache/texts, GET /cache/entries: 保存済みの内容を返す(LLM に既存の文面を再利用させる用途)。
- それ以外(/health, /v1/audio/speech/stream など)は上流へそのまま中継する。

キャッシュ置き場は CACHE_DIR(ホストにマウント)。管理表は index.jsonl(1行1エントリ、手編集可)。
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import parse_qs, urlsplit

UPSTREAM_HOST: str = os.environ.get("UPSTREAM_HOST") or "voxcpm2"
UPSTREAM_PORT: int = int(os.environ.get("UPSTREAM_PORT") or "8080")
LISTEN_PORT: int = int(os.environ.get("PORT") or "8080")
CACHE_DIR: Path = Path(os.environ.get("CACHE_DIR") or "/cache")
CACHE_ENABLED: bool = (os.environ.get("CACHE_ENABLED") or "1") != "0"
CACHE_MAX_BYTES: int = int(float(os.environ.get("CACHE_MAX_MB") or "1024") * 1024 * 1024)

SPEECH_PATH = "/v1/audio/speech"
INDEX_NAME = "index.jsonl"
# 上流の既定値(README 参照)。省略時と明示指定時で同じキーになるように補う
DEFAULT_PARAMS: dict[str, Any] = {
    "inference_timesteps": 10,
    "cfg_value": 2.0,
    "seed": 42,
    "temperature": 1.0,
    "max_steps": 4096,
    "response_format": "wav",
}
HOP_BY_HOP = {
    "connection", "keep-alive", "transfer-encoding", "content-length", "te",
    "trailers", "upgrade", "proxy-authenticate", "proxy-authorization", "server", "date",
}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _norm(v: Any) -> Any:
    # 10 と 10.0 を同一視する(bool は対象外)
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def make_key(req: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    """(キー, 正規化したテキスト, 保存用パラメータ) を返す。reference_audio はハッシュ化する。"""
    text = str(req["input"]).strip()
    params: dict[str, Any] = {k: _norm(v) for k, v in req.items() if k not in ("input", "reference_audio")}
    for k, v in DEFAULT_PARAMS.items():
        params.setdefault(k, _norm(v))
    ref = req.get("reference_audio")
    if ref:
        params["reference_audio_sha256"] = hashlib.sha256(str(ref).encode()).hexdigest()[:32]
    canon = json.dumps({"input": text, "params": params}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canon.encode()).hexdigest(), text, params


class Cache:
    def __init__(self, directory: Path, max_bytes: int) -> None:
        self.dir = directory
        self.max_bytes = max_bytes
        self.index_path = directory / INDEX_NAME
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._sig: tuple[int, int] | None = None
        directory.mkdir(parents=True, exist_ok=True)
        with self.lock:
            self._load()
            self._evict()
            self._save()

    # --- 管理表の読み書き ---
    def _stat_sig(self) -> tuple[int, int] | None:
        try:
            st = self.index_path.stat()
        except FileNotFoundError:
            return None
        return (st.st_mtime_ns, st.st_size)

    def _load(self) -> None:
        self.entries = {}
        invalid = 0
        if self.index_path.exists():
            for no, line in enumerate(self.index_path.read_text(encoding="utf-8").splitlines(), 1):
                if not line.strip():
                    continue
                try:
                    e = json.loads(line)
                    key, file = str(e["key"]), str(e["file"])
                    e.setdefault("hits", 0)
                    e.setdefault("pinned", False)
                    e["bytes"] = int(e["bytes"])
                    if not (self.dir / file).is_file():
                        log(f"index line {no}: file missing, entry dropped: {file}")
                        continue
                    self.entries[key] = e
                except (ValueError, KeyError, TypeError) as ex:
                    invalid += 1
                    log(f"index line {no}: invalid, dropped on next save ({ex!r})")
            if invalid:
                # 手編集の誤りで行を失わないよう、書き換え前に退避しておく
                bak = self.index_path.with_suffix(".jsonl.bak")
                bak.write_text(self.index_path.read_text(encoding="utf-8"), encoding="utf-8")
                log(f"invalid lines found; original index saved to {bak.name}")
        self._sig = self._stat_sig()
        self._remove_orphans()

    def _remove_orphans(self) -> None:
        known = {e["file"] for e in self.entries.values()}
        for p in self.dir.iterdir():
            if p.suffix in (".wav", ".pcm") and p.name not in known:
                log(f"orphan audio file removed (not in index): {p.name}")
                p.unlink()

    def _sync(self) -> None:
        """手編集などで管理表が変わっていたら読み直す。"""
        if self._stat_sig() != self._sig:
            log("index.jsonl changed on disk; reloading")
            self._load()

    def _save(self) -> None:
        lines = [json.dumps(e, ensure_ascii=False) for e in self.entries.values()]
        tmp = self.dir / (INDEX_NAME + ".tmp")
        tmp.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8", newline="\n")
        os.replace(tmp, self.index_path)
        self._sig = self._stat_sig()

    # --- 操作 ---
    def total_bytes(self) -> int:
        return sum(e["bytes"] for e in self.entries.values())

    def _evict(self) -> None:
        total = self.total_bytes()
        if total <= self.max_bytes:
            return
        # pinned は消さない。残りを最終利用が古い順に消す
        victims = sorted((e for e in self.entries.values() if not e["pinned"]), key=lambda e: e["last_used"])
        for e in victims:
            if total <= self.max_bytes:
                break
            (self.dir / e["file"]).unlink(missing_ok=True)
            del self.entries[e["key"]]
            total -= e["bytes"]
            log(f"evicted: {e['file']} ({e['bytes']} bytes, last_used {e['last_used']})")
        if total > self.max_bytes:
            log(f"WARNING: cache is {total} bytes (> limit {self.max_bytes}); remaining entries are pinned")

    def get(self, key: str) -> tuple[dict[str, Any], bytes] | None:
        with self.lock:
            self._sync()
            e = self.entries.get(key)
            if e is None:
                return None
            try:
                data = (self.dir / e["file"]).read_bytes()
            except FileNotFoundError:
                del self.entries[key]
                self._save()
                return None
            e["hits"] += 1
            e["last_used"] = now_iso()
            self._save()
            return dict(e), data

    def put(self, key: str, text: str, params: dict[str, Any], data: bytes, content_type: str, gen_sec: float) -> bool:
        if len(data) > self.max_bytes:
            log(f"not cached: {len(data)} bytes exceeds the limit")
            return False
        ext = "wav" if params.get("response_format") == "wav" else "pcm"
        file = f"{key[:20]}.{ext}"
        tmp = self.dir / (file + ".tmp")
        tmp.write_bytes(data)
        with self.lock:
            self._sync()
            os.replace(tmp, self.dir / file)
            ts = now_iso()
            old = self.entries.get(key)
            self.entries[key] = {
                "text": text, "file": file, "bytes": len(data), "hits": old["hits"] if old else 0,
                "pinned": old["pinned"] if old else False, "created": ts, "last_used": ts,
                "gen_sec": round(gen_sec, 1), "content_type": content_type, "params": params, "key": key,
            }
            self._evict()
            self._save()
        return True

    def snapshot(self) -> list[dict[str, Any]]:
        with self.lock:
            self._sync()
            return [dict(e) for e in self.entries.values()]


class KeyLocks:
    """同じキーの生成を1回にまとめる(同時に同じ文が来たら、後続は先行の完了を待ってヒットさせる)。"""

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._map: dict[str, list[Any]] = {}

    @contextmanager
    def hold(self, key: str) -> Iterator[None]:
        with self._guard:
            ent = self._map.setdefault(key, [threading.Lock(), 0])
            ent[1] += 1
        try:
            with ent[0]:
                yield
        finally:
            with self._guard:
                ent[1] -= 1
                if ent[1] == 0:
                    del self._map[key]


CACHE: Cache | None = None
KEY_LOCKS = KeyLocks()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "voxcpm2-cache-proxy"

    def log_message(self, fmt: str, *args: Any) -> None:
        log(f"{self.address_string()} {fmt % args}")

    # --- 応答ヘルパ ---
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

    def _read_body(self) -> bytes | None:
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            self._send_json(411, {"error": "chunked request bodies are not supported; send Content-Length"})
            return None
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    # --- 上流への中継 ---
    def _open_upstream(self, method: str, body: bytes | None) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse] | None:
        headers = {}
        if self.headers.get("Content-Type"):
            headers["Content-Type"] = self.headers["Content-Type"]
        conn = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=None)
        try:
            conn.request(method, self.path, body=body, headers=headers)
            return conn, conn.getresponse()
        except OSError as e:
            conn.close()
            log(f"upstream error: {e!r}")
            self._send_json(502, {"error": f"upstream {UPSTREAM_HOST}:{UPSTREAM_PORT} unreachable: {e}"})
            return None

    def _relay(self, method: str, body: bytes | None, tag: str | None = None) -> None:
        """上流の応答を逐次そのまま返す(ストリーミングも通す)。"""
        up = self._open_upstream(method, body)
        if up is None:
            return
        conn, resp = up
        try:
            length = resp.getheader("Content-Length")
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() not in HOP_BY_HOP:
                    self.send_header(k, v)
            if tag:
                self.send_header("X-TTS-Cache", tag)
            if length is not None:
                self.send_header("Content-Length", length)
            else:
                self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while True:
                chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536)
                if not chunk:
                    break
                if length is None:
                    self.wfile.write(b"%x\r\n%b\r\n" % (len(chunk), chunk))
                else:
                    self.wfile.write(chunk)
                self.wfile.flush()
            if length is None:
                self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            log("client disconnected during relay")
            self.close_connection = True
        finally:
            conn.close()

    # --- キャッシュ対象の合成 ---
    def _speech(self, body: bytes) -> None:
        try:
            req = json.loads(body)
            valid = isinstance(req, dict) and isinstance(req.get("input"), str) and req["input"].strip() != ""
        except ValueError:
            valid = False
        if not (CACHE_ENABLED and CACHE is not None and valid):
            # 不正な入力は上流にそのまま渡し、エラー応答も上流のものを返す
            self._relay("POST", body, "BYPASS" if not CACHE_ENABLED else None)
            return

        key, text, params = make_key(req)
        no_cache = "no-cache" in self.headers.get("Cache-Control", "").lower()
        with KEY_LOCKS.hold(key):
            if not no_cache:
                hit = CACHE.get(key)
                if hit is not None:
                    entry, data = hit
                    log(f"HIT  {entry['file']} hits={entry['hits']} text={text[:30]!r}")
                    self._send_bytes(200, data, entry.get("content_type") or "audio/wav",
                                     {"X-TTS-Cache": "HIT", "X-TTS-Cache-Key": key[:20]})
                    return
            t0 = time.monotonic()
            up = self._open_upstream("POST", body)
            if up is None:
                return
            conn, resp = up
            try:
                data = resp.read()
                status = resp.status
                ctype = resp.getheader("Content-Type") or "audio/wav"
            finally:
                conn.close()
            gen_sec = time.monotonic() - t0
            stored = False
            if status == 200 and data:
                stored = CACHE.put(key, text, params, data, ctype, gen_sec)
            log(f"MISS status={status} gen={gen_sec:.1f}s stored={stored} text={text[:30]!r}")
            self._send_bytes(status, data, ctype, {"X-TTS-Cache": "MISS" if stored else "MISS-NOSTORE",
                                                    "X-TTS-Cache-Key": key[:20]})

    # --- キャッシュ参照 API ---
    def _cache_api(self, path: str, query: dict[str, list[str]]) -> bool:
        if path not in ("/cache/texts", "/cache/entries"):
            return False
        if CACHE is None:
            self._send_json(404, {"error": "cache is disabled"})
            return True
        entries = CACHE.snapshot()
        sort = (query.get("sort") or ["recent"])[0]
        order = {
            "recent": lambda e: e["last_used"],
            "created": lambda e: e["created"],
            "hits": lambda e: (e["hits"], e["last_used"]),
        }.get(sort)
        if order is None:
            self._send_json(400, {"error": "sort must be one of: recent, created, hits"})
            return True
        entries.sort(key=order, reverse=True)
        q = (query.get("q") or [""])[0]
        if q:
            entries = [e for e in entries if q in e["text"]]
        try:
            limit = int((query.get("limit") or ["0"])[0])
        except ValueError:
            self._send_json(400, {"error": "limit must be an integer"})
            return True
        info = {"count": len(entries), "total_bytes": CACHE.total_bytes(), "max_bytes": CACHE.max_bytes}
        if path == "/cache/texts":
            texts = list(dict.fromkeys(e["text"] for e in entries))  # 重複を除き順序は維持
            if limit > 0:
                texts = texts[:limit]
            self._send_json(200, {**info, "texts": texts})
        else:
            for e in entries:
                e.pop("content_type", None)
            self._send_json(200, {**info, "entries": entries[:limit] if limit > 0 else entries})
        return True

    # --- メソッド ---
    def do_GET(self) -> None:
        parts = urlsplit(self.path)
        if self._cache_api(parts.path, parse_qs(parts.query)):
            return
        self._relay("GET", None)

    def do_POST(self) -> None:
        body = self._read_body()
        if body is None:
            return
        if urlsplit(self.path).path == SPEECH_PATH:
            self._speech(body)
        else:
            self._relay("POST", body)


def main() -> None:
    global CACHE
    if CACHE_ENABLED:
        CACHE = Cache(CACHE_DIR, CACHE_MAX_BYTES)
        log(f"cache: dir={CACHE_DIR} entries={len(CACHE.entries)} used={CACHE.total_bytes()} "
            f"limit={CACHE_MAX_BYTES} bytes")
    else:
        log("cache: disabled (CACHE_ENABLED=0); all requests are relayed")
    log(f"listening on :{LISTEN_PORT} -> upstream {UPSTREAM_HOST}:{UPSTREAM_PORT}")
    srv = ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler)
    srv.daemon_threads = True
    srv.serve_forever()


if __name__ == "__main__":
    main()

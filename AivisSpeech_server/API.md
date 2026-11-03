# AivisSpeech TTS API 利用ガイド

テキストを送ると音声(WAV)が返る HTTP API です。認証はありません。

- **ベース URL**: `http://127.0.0.1:8082`(サーバと同じ PC から。別 PC からは、サーバ側の設定で公開されている場合のみ `http://<サーバのIP>:8082`)
- **文字コード**: リクエスト・レスポンスの JSON はすべて UTF-8
- **処理速度**: RTF 約 1.0(1 秒の音声に約 1 秒)。**クライアントのタイムアウトは長め(60 秒以上)** にしてください
- **同時リクエスト**: 1 件ずつ順番に処理されます(後続は待たされます)
- **既定の声**: 話者 `阿井田 茂` / スタイル `Heavy`(落ち着いた低めの声)。`input` だけ送れば、この声で合成されます

## エンドポイント一覧

| メソッド / パス | 用途 |
|---|---|
| `POST /v1/audio/speech` | 音声を一括生成して WAV で返す |
| `POST /v1/audio/speech/events` | 文ごとに音声を返す(NDJSON / SSE)。リアルタイム発話向け |
| `POST /v1/audio/speech/stream` | 文ごとに合成して WAV をチャンク転送する |
| `GET /v1/audio/speech/models` | サンプルレート、使える話者・スタイルの一覧 |
| `GET /health` | 生存確認 |

## POST /v1/audio/speech

リクエスト: `Content-Type: application/json`

| キー | 型 | 既定 | 説明 |
|---|---|---|---|
| `input` | string | (必須) | 読み上げるテキスト。空・空白のみは HTTP 500 |
| `response_format` | string | `wav` | `wav`(PCM16 モノ、48kHz)または `pcm`(float32 リトルエンディアン、ヘッダなし、48kHz) |
| `speaker` / `voice` | string / int | `阿井田 茂` | 話者名。数値を渡すと style id の直接指定 |
| `style` | string | `Heavy` | スタイル名 |
| `speed` | number | 0.9 | 話速。1.0 が標準、小さいほどゆっくり |
| `intonation_scale` | number | 0.8 | 抑揚の強さ(0.0〜2.0)。1.0 超は不自然になることがある |
| `tempo_dynamics_scale` | number | エンジン既定(1.0) | 話速の緩急(0.0〜2.0) |
| `pitch_scale` | number | エンジン既定(0) | 音高。マイナスで低く。**0 以外にすると合成が大幅に遅くなり(RTF が約 0.5 悪化)、音質も劣化することがある**ため、通常は指定しない |
| `volume_scale` | number | エンジン既定(1.0) | 音量 |
| `pre_phoneme_length` / `post_phoneme_length` | number | 0.1 | 前後の無音(秒) |

- 省略したキーは、サーバ側の既定値(上表)が使われます。指定した値が優先されます。
- 数値のキーに数値以外を渡すと HTTP 400 です。
- 文頭の `(声の説明)` は取り除かれて読み上げられません(例: `"(落ち着いた声)こんにちは。"` は「こんにちは。」だけが合成されます)。
- 次のキーは **エラーにならず無視されます**: `inference_timesteps` `cfg_value` `seed` `temperature` `max_steps` `reference_audio` `prompt_text`。ボイスクローンは非対応です。

成功時のレスポンス: HTTP 200、ボディは音声データ(`wav` は `audio/wav`、`pcm` は `application/octet-stream`)。

| レスポンスヘッダ | 内容 |
|---|---|
| `X-TTS-Style-Id` | 使われた style id |
| `X-TTS-Gain-DB` | 音量の正規化で適用したゲイン(dB)。`wav` のときのみ |
| `X-TTS-Ignored-Params` | 無視されたキー(あれば) |
| `X-TTS-Voice-Prompt-Stripped` | 文頭の `(…)` を取り除いたとき `1` |

## POST /v1/audio/speech/events

文を 1 つ合成するたびに結果を返します。最初の音が早く出るので、再生しながら受信する用途に向きます。リクエストは `/v1/audio/speech` と同じで、次の 2 つが追加できます。

| キー | 既定 | 説明 |
|---|---|---|
| `stream_format` | `ndjson` | `ndjson`(1 行 1 JSON、`application/x-ndjson`)または `sse`(`text/event-stream`、`event:` 名は `type` と同じ) |
| `split` | `sentence` | `sentence`(`。！？!?` と改行で区切る)または `clause`(読点 `、，,` でも区切る。先頭は早いが抑揚が不自然になりやすい) |

イベント(`type` で判別):

```json
{"type":"start","sample_rate":48000,"encoding":"pcm_s16le","channels":1,"speaker_style_id":1310138979,"sentences":3}
{"type":"audio","index":0,"text":"一文目です。","audio":"<base64>","duration_sec":1.418,"offset_sec":0.0,"gen_sec":2.221,"elapsed_sec":0.003}
{"type":"done","sentences":3,"audio_sec":5.946,"gen_sec":5.138,"rtf":0.864}
{"type":"error","status":502,"message":"..."}
```

- `audio` は **ヘッダなしの PCM16 リトルエンディアン・モノ** を base64 にしたものです。`start` の `sample_rate` で再生します。
- `offset_sec` は音声全体の中での開始位置(字幕の同期に使えます)。`gen_sec` はその文の生成時間です。
- 先頭の文で失敗した場合は、通常の JSON エラー(HTTP 4xx/5xx)になります。途中で失敗した場合は `error` イベントで終わります。
- RTF が 1 前後なので、再生側で **0.5〜1 秒程度のバッファ**を持たせると途切れにくくなります。
- 接続を切ると、次の文から合成を止めます(割り込みはクライアントが切断する)。
- 音量の正規化はかかりません(`X-TTS-Gain-DB` なし)。

## POST /v1/audio/speech/stream

文ごとに合成し、サイズ不定の WAV ヘッダに続けて PCM をチャンク転送します(`Transfer-Encoding: chunked`)。WAV ヘッダの長さは不定値のため、ファイルとして保存するとサイズが不正な WAV になります。保存や字幕同期が目的なら `/events` か `/v1/audio/speech` を使ってください。音量の正規化はかかりません。

## GET /v1/audio/speech/models

```json
{"object":"list","data":[{"id":"aivisspeech","object":"model","sample_rate":48000,
  "default_speaker":"阿井田 茂","default_style":"Heavy",
  "speakers":[{"name":"阿井田 茂","styles":[{"name":"Heavy","id":1310138979}, "..."]}, "..."]}]}
```

使える話者・スタイルの一覧です(`speakers[].styles[].name` を `speaker` / `style` に渡します)。

## GET /health

`{"engine":"aivisspeech","status":"ok"}`(HTTP 200)。合成中は `"busy":true` が付くことがあります。エンジンに接続できないと HTTP 503 です。

## エラー

形式: `{"error":{"message":"...","type":"..."}}`

| HTTP | 原因 |
|---|---|
| 400 | JSON が不正、`response_format` / `stream_format` / `split` が不正、数値キーが数値でない、話者・スタイルが存在しない |
| 403 | 指定した声が、サーバ側で許可されていないライセンスの声モデル(`type: license_error`) |
| 500 | `input` が空 / 欠落、またはサーバ内部エラー |
| 502 | 推論エンジンが応答しない・失敗した |
| 503 | `/health` でエンジンに接続できない |

## 呼び出し例

### curl

```bash
# 基本(既定の声)
curl -s http://127.0.0.1:8082/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"input":"こんにちは。今日はいい天気ですね。"}' -o out.wav

# 声と話速を指定
curl -s http://127.0.0.1:8082/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"input":"こんにちは。","speaker":"まお","style":"おちつき","speed":1.0,"pitch_scale":0}' -o out.wav

# 使える声の一覧
curl -s http://127.0.0.1:8082/v1/audio/speech/models
```

**Windows(Git Bash / cmd)の注意**: コマンドライン引数の日本語が UTF-8 で渡らず、HTTP 400(`invalid JSON: 'utf-8' codec can't decode byte ...`)になることがあります。その場合は、UTF-8 で保存した JSON ファイルを渡してください。

```bash
curl -s http://127.0.0.1:8082/v1/audio/speech -H 'Content-Type: application/json' \
  --data-binary @req.json -o out.wav     # req.json は UTF-8 で保存した {"input":"こんにちは。"}
```

### PowerShell 7

```powershell
$body = @{ input = 'こんにちは。今日はいい天気ですね。' } | ConvertTo-Json -Compress
Invoke-WebRequest -Uri http://127.0.0.1:8082/v1/audio/speech -Method Post `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes($body)) -OutFile out.wav -TimeoutSec 600
```

日本語を含む本文は、上のように UTF-8 のバイト列にして渡してください(文字列のまま渡すと文字化けすることがあります)。

### Python(標準ライブラリのみ): 一括合成して WAV を保存

```python
import json
import urllib.request
from pathlib import Path

BASE_URL = "http://127.0.0.1:8082"


def synthesize(text: str, out_path: Path, **params: object) -> None:
    """text を合成して out_path に WAV で保存する。params は speaker / style / speed など。"""
    body = json.dumps({"input": text, **params}).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/v1/audio/speech", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        out_path.write_bytes(resp.read())


synthesize("こんにちは。今日はいい天気ですね。", Path("out.wav"))
synthesize("ゆっくり話します。", Path("slow.wav"), speed=0.8)
```

### Python(requests)

```python
from pathlib import Path

import requests

resp = requests.post(
    "http://127.0.0.1:8082/v1/audio/speech",
    json={"input": "こんにちは。", "speaker": "阿井田 茂", "style": "Heavy"},
    timeout=600,
)
resp.raise_for_status()  # 4xx / 5xx は例外。詳細は resp.json()["error"]["message"]
Path("out.wav").write_bytes(resp.content)
```

### Python: `/events` を受信しながら再生用 PCM を取り出す(NDJSON)

```python
import base64
import http.client
import json
from collections.abc import Iterator

HOST, PORT = "127.0.0.1", 8082


def stream_pcm(text: str, **params: object) -> Iterator[tuple[int, bytes, dict]]:
    """文ごとに (sample_rate, PCM16 モノのバイト列, イベント全体) を順に返す。"""
    conn = http.client.HTTPConnection(HOST, PORT, timeout=600)
    body = json.dumps({"input": text, "stream_format": "ndjson", **params}).encode("utf-8")
    conn.request("POST", "/v1/audio/speech/events", body, {"Content-Type": "application/json"})
    resp = conn.getresponse()
    if resp.status != 200:  # 先頭の文の失敗は、通常の JSON エラーで返る
        raise RuntimeError(f"HTTP {resp.status}: {resp.read().decode('utf-8', 'replace')}")
    rate = 48000
    while line := resp.readline():  # chunked は http.client が復号する
        event = json.loads(line)
        if event["type"] == "start":
            rate = event["sample_rate"]
        elif event["type"] == "audio":
            yield rate, base64.b64decode(event["audio"]), event
        elif event["type"] == "error":
            raise RuntimeError(f"stream error {event['status']}: {event['message']}")
        elif event["type"] == "done":
            break
    conn.close()


for rate, pcm, ev in stream_pcm("一文目です。二文目です。三文目です。"):
    print(f"[{ev['index']}] {ev['text']}  {ev['duration_sec']}s (offset {ev['offset_sec']}s)")
    # ここで pcm をオーディオデバイスへ渡す(例: sounddevice.RawOutputStream(samplerate=rate, channels=1, dtype="int16"))
```

### Python: SSE(`stream_format: "sse"`)で受信する

```python
import base64
import http.client
import json

conn = http.client.HTTPConnection("127.0.0.1", 8082, timeout=600)
body = json.dumps({"input": "一文目です。二文目です。", "stream_format": "sse"}).encode("utf-8")
conn.request("POST", "/v1/audio/speech/events", body, {"Content-Type": "application/json"})
resp = conn.getresponse()
name = ""
while line := resp.readline():
    text = line.decode("utf-8").rstrip("\n")
    if text.startswith("event: "):
        name = text[7:]
    elif text.startswith("data: "):
        data = json.loads(text[6:])
        if name == "audio":
            pcm = base64.b64decode(data["audio"])  # PCM16 LE モノ
            print(data["index"], data["text"], len(pcm))
        elif name in ("done", "error"):
            break
```

### JavaScript(ブラウザ / Node 18+): 一括合成

```javascript
const res = await fetch("http://127.0.0.1:8082/v1/audio/speech", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ input: "こんにちは。今日はいい天気ですね。" }),
});
if (!res.ok) throw new Error((await res.json()).error.message);
const blob = await res.blob(); // audio/wav
new Audio(URL.createObjectURL(blob)).play();
```

ブラウザから別オリジンで呼ぶ場合、このサーバは CORS ヘッダを返しません。サーバ側のバックエンド経由で呼ぶか、プロキシを挟んでください。

### PCM(`response_format: "pcm"`)を扱う

`pcm` は **float32 リトルエンディアン、48kHz、モノ、ヘッダなし**です(`/events` の `audio` は int16 なので別形式です)。

```python
import array
import wave

pcm = ...  # response_format="pcm" で受け取ったバイト列
f = array.array("f")
f.frombytes(pcm)
s = array.array("h", (max(-32768, min(32767, round(x * 32768))) for x in f))
with wave.open("out.wav", "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(48000)
    w.writeframes(s.tobytes())
```

## 使える声(2026-11-03 時点)

| 話者 | スタイル |
|---|---|
| 阿井田 茂(既定) | ノーマル / Calm / Far / **Heavy(既定)** / Mid / Shout / Surprise |
| まお | ノーマル / ふつー / あまあま / おちつき / からかい / せつなめ |
| コハク | ノーマル / あまあま / せつなめ / ねむたい |

最新の一覧は `GET /v1/audio/speech/models` で取得できます。

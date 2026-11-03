# VocCPM2_server — VoxCPM2 常駐 TTS サーバ(CPU / Docker)

テキストを HTTP で受け取り、音声(WAV)を返す **常駐サーバ** です。VoxCPM2 を GGUF 形式(Q8_0)で、`llama.cpp-omni` の `llama-tts-server` 上で動かします。**このフォルダだけで完結**します(リポジトリの他のフォルダには依存しません)。

- GPU 不要(CPU のみ)。コンテナは `restart: unless-stopped` で常時起動します。
- 認証なし。既定ではこの PC(`127.0.0.1`)からのみ接続できます。
- モデルは起動時に1回だけロードするので、リクエストごとのロード待ち(約25秒)がありません。
- **音声キャッシュ付き**: 同じ内容のリクエストは、保存済みの WAV を即座に返します(下記「キャッシュ」)。

> **速度の目安**(Ryzen 7 5700X、8 スレッド、`inference_timesteps=5`): RTF ≈ **2.7**。5 秒の音声に約 13 秒、32 秒の音声に約 86 秒かかります。**リアルタイムより遅い**ので、会話用途ではなくバッチ的な読み上げ向けです。

## 構成

```
VocCPM2_server/
├─ README.md
├─ docker-compose.yml     # 起動定義(推論サーバ voxcpm2 + キャッシュプロキシ api)
├─ .env                   # 設定値(PORT / BIND_ADDR / THREADS / BASELM_FILE …)
├─ Dockerfile             # llama.cpp-omni を取得・パッチ・ビルドする(CPU専用)
├─ server.patch           # 上流サーバへの最小パッチ(下記)
├─ proxy/cache_proxy.py   # 音声キャッシュ付きプロキシ(Python 標準ライブラリのみ)
├─ entrypoint.sh          # コンテナ起動スクリプト
├─ models/                # GGUF 重み(約3.3GB、git 管理外)
├─ cache/                 # キャッシュ(音声 + 管理表 index.jsonl、git 管理外。場所は .env の CACHE_DIR)
├─ scripts/
│  ├─ download-models.ps1 # 重みの取得(curl.exe を使用。Python 不要)
│  └─ smoke-test.ps1      # 動作確認
└─ out/                   # smoke-test の出力(git 管理外)
```

## セットアップ

前提: Windows 11 + Docker Desktop(Linux コンテナ)+ PowerShell 7。

```powershell
cd VocCPM2_server
./scripts/download-models.ps1     # models/ に GGUF を取得(取得済みならスキップ)
docker compose build              # 初回のみ約6〜10分(コンパイルあり)。プロキシ用の python イメージは up 時に自動取得
docker compose up -d              # 常駐起動(モデルロードに約20秒)
./scripts/smoke-test.ps1          # 動作確認
```

`docker compose ps` で `voccpm2-server`(推論)と `voccpm2-api`(プロキシ)が両方起動していれば準備完了です。推論サーバはホストに公開されず、利用者が叩くのは `api`(ポート 8080)です。PC を再起動しても、Docker Desktop が起動すれば自動で立ち上がります。

> イメージは **ビルドしたマシンの CPU 向けに最適化**(`GGML_NATIVE`)されます。別の(古い)CPU のマシンへイメージをコピーしても動かない場合があります。その場合はそのマシンで `docker compose build` してください。

## 使い方(API)

ベース URL: `http://127.0.0.1:8080`(キャッシュプロキシ経由。`/cache/*` 以外は上流にそのまま中継されます)

| メソッド / パス | 内容 |
|---|---|
| `GET /health` | 生存確認 |
| `GET /v1/audio/speech/models` | モデル情報(サンプルレート 48000 など) |
| `POST /v1/audio/speech` | 音声を一括生成して返す(OpenAI 互換形式) |
| `POST /v1/audio/speech/stream` | チャンク転送で返す(下記の注意あり。**キャッシュ対象外**) |
| `GET /cache/texts` | キャッシュ済みの文面の一覧(下記「キャッシュ」) |
| `GET /cache/entries` | キャッシュの管理表の内容(パラメータ・ヒット回数など) |

### 通常合成

```powershell
$body = @{ input = 'こんにちは。今日はローカルの音声合成を試しています。'; inference_timesteps = 5 } | ConvertTo-Json -Compress
Invoke-WebRequest -Uri http://127.0.0.1:8080/v1/audio/speech -Method Post `
  -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -OutFile out.wav
```

```bash
curl -s http://127.0.0.1:8080/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"input":"こんにちは。","inference_timesteps":5}' -o out.wav
```

リクエスト JSON(`input` 以外は省略可):

| キー | 既定 | 説明 |
|---|---|---|
| `input` | (必須) | 読み上げるテキスト。空だとエラー |
| `inference_timesteps` | 10 | 拡散のステップ数。**5 にすると約 2/3 の時間**で生成できます(音質への影響は未確認) |
| `cfg_value` | 2.0 | ガイダンス強度 |
| `seed` | 42 | 乱数シード(同じ入力・同じシードなら同じ結果) |
| `temperature` | 1.0 | ノイズ温度 |
| `max_steps` | **4096** | 最大デコードステップ(1 ステップ ≈ 0.16 秒)。上流既定の 200(約 32 秒分)から引き上げています |
| `response_format` | `wav` | `wav`(PCM16 モノ 48kHz)または `pcm`(**32bit float** リトルエンディアン、48kHz、ヘッダなし) |
| `reference_audio` | なし | ボイスクローン用の参照 WAV(**base64 文字列**) |
| `prompt_text` | なし | `reference_audio` の書き起こし(指定すると「継続モード」のクローン) |

**声デザイン**: テキストの先頭に `(声の説明)` を付けます。例: `"input": "(落ち着いた低めの男性の声)こんにちは。"`

**ボイスクローン**(PowerShell):

```powershell
$ref = [Convert]::ToBase64String([IO.File]::ReadAllBytes('speaker.wav'))
$body = @{ input = 'こんにちは。'; inference_timesteps = 5; reference_audio = $ref } | ConvertTo-Json -Compress
```

### ストリーミング

`/v1/audio/speech/stream` は、音声を 0.16 秒ずつチャンク転送します(WAV ヘッダのサイズは不定値)。

- 最初のチャンクは約 **1.7 秒**で出ますが、全体の生成は通常合成より遅く(約 **1.8 倍**)、**RTF が 1 を大きく超える**ため再生が追いつきません。途切れさせずに聞くには生成の大半が終わるまで待つ必要があり、**実用上は通常合成と変わりません**。
- 将来 RTF が 1 を下回る環境(GPU など)で使う想定の口です。

## キャッシュ

`POST /v1/audio/speech` の結果は、**成功(HTTP 200)したものだけ**を音声ファイルとして保存し、同じ内容のリクエストには保存済みの音声をそのまま返します(生成は行いません)。`/stream` は対象外です。

### 「同じ内容」の判定
次を合わせたハッシュが一致したときだけヒットします。**文面の類似判定(あいまい一致)はしません。**

- `input`(前後の空白は無視)
- 生成パラメータ全部(`inference_timesteps`, `cfg_value`, **`seed`**, `temperature`, `max_steps`, `response_format`, `prompt_text` など)。省略時は既定値で補うので、`10` と `10.0`、省略と明示は同一扱いです
- `reference_audio`(ボイスクローン)の中身

> `seed` は乱数シードで、文面ではありません。シードが違えば別の音声になるため、別エントリとして保存されます。

応答ヘッダ `X-TTS-Cache` で結果が分かります: `HIT`(保存済みを返した)/ `MISS`(生成して保存した)/ `MISS-NOSTORE`(生成したが保存しなかった)/ `BYPASS`(キャッシュ無効)。`Cache-Control: no-cache` を付けると、保存済みを使わずに再生成して**上書き**します。

### 文面の再利用(LLM が文面を作る場合)
LLM に毎回少しずつ違う文面を作らせるとヒットしません。そこで、**保存済みの文面の一覧を取得して LLM に渡し、似た内容なら一覧の文面をそのまま(1文字も変えずに)出力させる**使い方を想定しています。

```bash
# 最近使った順(既定)
curl -s http://127.0.0.1:8080/cache/texts

# ヒット回数の多い順に50件
curl -s 'http://127.0.0.1:8080/cache/texts?sort=hits&limit=50'

# 部分一致で絞り込み(日本語は --data-urlencode で渡す)
curl -s -G http://127.0.0.1:8080/cache/texts --data-urlencode 'q=おはよう'

# パラメータ・ヒット回数・生成時間つきの管理表の内容(同じクエリが使える)
curl -s 'http://127.0.0.1:8080/cache/entries?sort=hits&limit=10'
```

PowerShell の場合:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8080/cache/texts?sort=hits&limit=50'
Invoke-RestMethod 'http://127.0.0.1:8080/cache/entries?limit=10'
```

```json
{"count": 3, "total_bytes": 583812, "max_bytes": 1073741824,
 "texts": ["こんにちは。キャッシュの確認です。", "Hello there."]}
```

`sort` は `recent`(既定)/ `created` / `hits`、`limit` は 0 で無制限です。同じ文面で複数のパラメータ違いがあっても、`texts` は重複を除いて返します。パラメータも見たい場合は `GET /cache/entries`(同じクエリが使えます)。

### 保存場所と管理表(手編集できます)
保存先はホストのフォルダ(既定 `./cache`、`.env` の `CACHE_DIR` で変更)です。

- `*.wav`(`response_format=pcm` なら `*.pcm`): 音声ファイル
- `index.jsonl`: 管理表。**1行が1エントリの JSON**(UTF-8)です

```json
{"text": "こんにちは。", "file": "0987dae2a508795806ea.wav", "bytes": 230444, "hits": 2, "pinned": false, "created": "2026-11-01T01:16:53+00:00", "last_used": "2026-11-01T01:16:53+00:00", "gen_sec": 7.1, "content_type": "audio/wav", "params": {"inference_timesteps": 5, "seed": 42, "...": "..."}, "key": "0987dae2…"}
```

手編集の方法(コンテナの起動中でも可。次のアクセス時に自動で読み直します):

- **エントリを消す**: その行を削除する。対応する音声ファイルは、管理表に載っていないものとして自動で削除されます
- **消されないようにする**: `"pinned": false` を `true` にする。容量超過のときの自動削除の対象外になります
- **保存済み音声の差し替え**: 同名のファイルを置き換え、`bytes` を実サイズに合わせる

注意:
- 行の JSON が壊れていると、その行は無視され、次の書き込み時に失われます。その場合は書き換え前の内容を `index.jsonl.bak` に退避します
- 管理表に載っていない `*.wav` / `*.pcm` は自動削除されるので、`cache/` に別の音声を置かないでください
- `key` と `params` は判定に使うため、変更しないでください(`text` は一覧に出る表示用の値で、判定には使われません)

### 容量と削除
上限は `.env` の `CACHE_MAX_MB`(既定 1024 = 1GB)です。変更後は `docker compose up -d` で反映します。超えると、**最終利用が古いものから**削除します(`pinned` は除く。`pinned` だけで上限を超えた場合は警告をログに出します)。WAV は 48kHz/16bit で 1 秒あたり約 94KB なので、1GB でおよそ 3 時間分です。上限より大きい音声 1 件は保存しません。

無効にするには `CACHE_ENABLED=0` にします(全リクエストが上流へそのまま中継されます)。同じ内容が同時に複数来たときは、生成は 1 回にまとめ、残りは完了後にヒットさせます。

## 運用

```powershell
docker compose logs -f          # ログ(推論サーバ + プロキシ。HIT / MISS はプロキシ側 `docker compose logs -f api`)
docker compose restart          # 再起動
docker compose down             # 停止・削除(重みは models/ に残る)
docker compose build --no-cache # 上流から取り直して再ビルド
```

設定は `.env` で変更し、`docker compose up -d` で反映します。

| 変数 | 既定 | 説明 |
|---|---|---|
| `PORT` | 8080 | ホスト側ポート |
| `BIND_ADDR` | 127.0.0.1 | `0.0.0.0` にすると LAN の他の端末からも到達可。**認証がないため、信頼できるネットワークのみ**で使ってください |
| `THREADS` | 8 | 推論スレッド数(物理コア数が目安) |
| `BASELM_FILE` | `VoxCPM2-BaseLM-Q8_0.gguf` | `VoxCPM2-BaseLM-F16.gguf` にすると高精度(要 `download-models.ps1 -F16`、遅くなる可能性。速度・品質は未計測) |
| `CACHE_ENABLED` | 1 | `0` でキャッシュ無効 |
| `CACHE_MAX_MB` | 1024 | キャッシュ容量の上限(MB) |
| `CACHE_DIR` | `./cache` | キャッシュ置き場(ホスト側のフォルダ) |
| `HTTP_THREADS` | 1 | **変更非推奨**(下記) |
| `EXTRA_ARGS` | 空 | `llama-tts-server` への追加引数 |

メモリ使用量は約 3.3GB(Q8_0)。重みは `./models` を読み取り専用でマウントします。

## 設計上の注意(重要)

### 同時リクエストは「1 件ずつ順番に」処理されます
推論ランタイムはスレッドセーフではないため、生成は直列化しています。2 件同時に送ると、後のリクエストは前の完了まで待たされます(実測: 9.3 秒と 18.4 秒)。**クライアント側のタイムアウトは長め**(長文なら数分〜)にしてください。待ち行列の上限は設けていません。

### HTTP ワーカーは 1 スレッド固定(`HTTP_THREADS=1`)
上流サーバは HTTP リクエストをスレッドプールで処理しますが、推論の内部(ggml)は OpenMP を使うため、**別の HTTP スレッドで処理されるたびに OpenMP のスレッドチームが増えて競合し、以降の合成が約 2 倍遅くなる**ことを実測で確認しました(CPU 使用率 約 800% → 約 290%、コンテナ再起動で戻る)。HTTP ワーカーを 1 つに固定すると再現しなくなります。

その副作用として、**生成中は `/health` などの応答も待たされます**。そのためコンテナのヘルスチェックは HTTP ではなく、ポートへの接続可否で判定しています。監視を自作する場合も、長い生成中は HTTP が応答しない点に注意してください。

### 上流への変更(`server.patch`)
上流(`tc-mb/llama.cpp-omni`、`Dockerfile` の `LLAMA_OMNI_REV` で固定)のソースは直接改変せず、ビルド時に次の最小パッチを当てています。

1. 生成処理を `std::mutex` で直列化(上記)。
2. `max_steps` の既定値を 200 → 4096 に変更(200 だと約 32 秒で黙って切れるため)。

## 既知の制約・未確認事項
- RTF 約 2.7(`inference_timesteps=5`)。`10` だと約 3.5。リアルタイムには届きません。
- 音質は未評価です(音声を聴いての確認は行っていません)。Q8_0 量子化の影響や `inference_timesteps=5` の品質低下は未確認です。
- ボイスクローンは遅めです(実測 RTF 約 6)。
- 不正な入力(`input` が空など)も HTTP 500 で返ります(上流の仕様)。
- `--speed` のような話速指定はありません。
- 長文を分割せずにそのまま渡します。メモリや所要時間は長さに比例して増えます(32 秒分の音声で約 86 秒)。

## 出典・ライセンス
- 推論エンジン: [tc-mb/llama.cpp-omni](https://github.com/tc-mb/llama.cpp-omni)(`voxcpm2-cli` / `llama-tts-server`)
- 重み: [DennisHuang648/VoxCPM2-GGUF](https://huggingface.co/DennisHuang648/VoxCPM2-GGUF)(元モデル: [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM))
- VoxCPM2 本体は Apache-2.0 とされています(SPEC 記載。各ライセンスは配布元で最終確認してください)。

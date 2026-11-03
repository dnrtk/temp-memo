# AivisSpeech_server — AivisSpeech 常駐 TTS サーバ(CPU / Docker)

テキストを HTTP で受け取り、音声(WAV)を返す **常駐サーバ** です。[AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine) の公式 Docker イメージ(無改変)の前段に、**`VoxCPM2_server`(`VocCPM2_server/`)と同じ HTTP I/F** を提供する小さなアダプタを置いています。`VoxCPM2_server` を叩いているクライアントは、ポートを変えるだけで差し替えられます。

- GPU 不要(CPU のみ)。コンテナは `restart: unless-stopped` で常時起動します。
- 認証なし。既定ではこの PC(`127.0.0.1`)からのみ接続できます。
- **キャッシュ機能はありません**(意図的。下記「VoxCPM2_server との差分」)。
- **商用利用を想定したライセンスゲート付き**(下記「ライセンス」。必ず読んでください)。

> **速度の目安**(Ryzen 7 5700X、8 スレッド、ウォームアップ後): 4.4 秒の音声に約 4.5 秒、**RTF ≈ 1.0**。起動後の最初の合成だけは約 2.4(モデルの初回ロード)。リアルタイム前後なので、長文では再生が追いつかない場合があります。

## 構成

```
AivisSpeech_server/
├─ README.md
├─ docker-compose.yml     # 起動定義(エンジン aivisspeech + アダプタ api)
├─ .env                   # 設定値(PORT / DEFAULT_SPEAKER / LICENSE_ALLOW …)
├─ proxy/aivis_api.py     # VoxCPM2_server 互換 I/F + ライセンスゲート(Python 標準ライブラリのみ)
├─ data/                  # エンジンのデータ(声モデル・BERT・辞書・ログ。git 管理外)
├─ scripts/
│  ├─ smoke-test.ps1      # 動作確認
│  └─ check-licenses.ps1  # 声モデルごとのライセンス確認
└─ out/                   # smoke-test の出力(git 管理外)
```

## セットアップ

前提: Windows 11 + Docker Desktop(Linux コンテナ)+ PowerShell 7。**初回起動時のみインターネット接続が必要**です(既定の声モデル 2 つと BERT モデルを `data/` にダウンロードします。数分かかります)。2 回目以降は `data/` を使うのでオフラインで起動できます。

```powershell
cd AivisSpeech_server
docker compose up -d              # イメージ取得(約7GB)+ 初回ダウンロード。完了まで数分
./scripts/check-licenses.ps1      # 声モデルのライセンス判定を確認
./scripts/smoke-test.ps1          # 動作確認
```

`docker compose ps` で `aivisspeech-server`(推論)と `aivisspeech-api`(アダプタ)が両方 `healthy` / `running` なら準備完了です。推論エンジンはホストに公開されず、利用者が叩くのは `api`(ポート **8082**)です。

> ポート 8082 を選んだ理由: 8080 は VoxCPM2_server、8081 は Dify の nginx が使用しているためです。`.env` の `PORT` で変更できます。

## 使い方(API)

ベース URL: `http://127.0.0.1:8082`

| メソッド / パス | 内容 |
|---|---|
| `GET /health` | 生存確認(`{"engine":"aivisspeech","status":"ok"}`)。合成中は `"busy":true` が付くことがあります |
| `GET /v1/audio/speech/models` | モデル情報(サンプルレート、利用可能な話者・スタイル、各声のライセンス判定) |
| `POST /v1/audio/speech` | 音声を一括生成して返す(OpenAI 互換形式) |
| `POST /v1/audio/speech/stream` | 文ごとに合成してチャンク転送で返す(下記の注意あり) |
| `POST /v1/audio/speech/events` | 文ごとの PCM(base64)+文テキスト+時間情報を NDJSON / SSE で返す(独自。下記) |
| `GET /license` | インストール済み声モデルのライセンス条文(全文) |
| `GET /cache/*` | 404(キャッシュなし) |

### 通常合成

```powershell
$body = @{ input = 'こんにちは。今日はローカルの音声合成を試しています。' } | ConvertTo-Json -Compress
Invoke-WebRequest -Uri http://127.0.0.1:8082/v1/audio/speech -Method Post `
  -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -OutFile out.wav
```

```bash
curl -s http://127.0.0.1:8082/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"input":"こんにちは。","speaker":"まお","style":"あまあま","speed":1.1}' -o out.wav
```

リクエスト JSON(`input` 以外は省略可):

| キー | 既定 | 説明 |
|---|---|---|
| `input` | (必須) | 読み上げるテキスト。空だとエラー(VoxCPM2 版に合わせ HTTP 500) |
| `response_format` | `wav` | `wav`(PCM16 モノ。既定 48kHz)または `pcm`(**32bit float** リトルエンディアン、ヘッダなし。VoxCPM2 版と同じ形式) |
| `speaker` / `voice` | `DEFAULT_SPEAKER` | 話者名(例 `まお`)。数値なら style id を直接指定 |
| `style` | `DEFAULT_STYLE` | スタイル名(例 `あまあま`) |
| `speed` | 1.0 | 話速(`speedScale`) |
| `intonation_scale` | 1.0 | 感情・抑揚の強さ 0.0〜2.0。1.0 超は不自然になることがあります |
| `tempo_dynamics_scale` | 1.0 | 話速の緩急 0.0〜2.0 |
| `pitch_scale` | 0.0 | 音高。0 以外は音質が劣化することがあります |
| `volume_scale` | 1.0 | 音量(エンジン側) |
| `pre_phoneme_length` / `post_phoneme_length` | 0.1 | 前後の無音(秒) |

**VoxCPM2 版のパラメータの扱い**: `inference_timesteps` / `cfg_value` / `seed` / `temperature` / `max_steps` / `reference_audio` / `prompt_text` は **エラーにせず無視**し、応答ヘッダ `X-TTS-Ignored-Params` に無視した名前を返します(ボイスクローンは非対応)。
**声デザイン記法**: 文頭の `(声の説明)` は AivisSpeech では読み上げてしまうため、**取り除いてから合成**します(ヘッダ `X-TTS-Voice-Prompt-Stripped: 1`)。声を変えたいときは `speaker` / `style` を使ってください。

応答ヘッダ: `X-TTS-Cache: BYPASS`(常にキャッシュなし)、`X-TTS-Style-Id`、`X-TTS-Gain-DB`(音量正規化で適用したゲイン)。

### ストリーミング

`/v1/audio/speech/stream` は、入力を文(`。！？!?` と改行)で区切って順に合成し、サイズ不定の WAV ヘッダに続けて PCM をチャンク転送します。**エンジン自体はストリーミング非対応**のため、「文単位で先頭が早く出る」だけです。文ごとに独立して合成するので、通常合成より文の継ぎ目の抑揚が不自然になることがあります。RTF が 1 前後なので、短い文が続く入力で効果があります。

### イベントストリーミング(リアルタイム発話用。AivisSpeech_server 独自)

`POST /v1/audio/speech/events` は、文ごとに合成するたびに、その PCM(base64)と文テキスト・時間情報を **イベントで即座に返します**。リクエストは通常合成と同じ JSON で、次の 2 つが追加されます。

| キー | 既定 | 説明 |
|---|---|---|
| `stream_format` | `ndjson` | `ndjson`(1 行 1 JSON。`application/x-ndjson`)または `sse`(`text/event-stream`。`event:` 名は `type` と同じ) |
| `split` | `sentence` | `sentence`(`。！？!?` と改行で区切る)または `clause`(読点 `、，,` でも区切る。先頭の音が早く出る代わりに、抑揚は不自然になりやすい) |

イベント(`type` で判別):

```json
{"type":"start","sample_rate":48000,"encoding":"pcm_s16le","channels":1,"speaker_style_id":1878365376,"sentences":3}
{"type":"audio","index":0,"text":"一文目です。","audio":"<base64 PCM16 LE モノ>","duration_sec":1.418,"offset_sec":0.0,"gen_sec":2.221,"elapsed_sec":0.003}
{"type":"done","sentences":3,"audio_sec":5.946,"gen_sec":5.138,"rtf":0.864}
{"type":"error","status":502,"message":"..."}
```

- `audio` はヘッダなしの生 PCM です。クライアントは `start` のサンプルレートで、届いた順にバッファへ積んで再生します。`offset_sec` は音声全体の中での開始位置で、字幕の同期に使えます。
- 先頭の文が失敗した場合は、通常の JSON エラー応答(HTTP 4xx/5xx)になります。途中で失敗した場合は `error` イベントを送って終了します。
- クライアントが接続を切ると、**次の文から合成を止めます**(割り込み・キャンセルは切断で行う)。ただし合成中の 1 文は完了まで走ります。
- 音量正規化(`OUTPUT_RMS_DBFS`)は対象外です。声デザイン記法 `(説明)` の除去、`speaker` / `style` / `speed` などは通常合成と同じです。
- 計測例(コハク / ノーマル、3 文・計 5.9 秒): 先頭イベントまで約 2.3 秒(再起動直後で、ウォームアップを含む)、全体 RTF 0.86〜0.99。**RTF が 1 前後のため、文が短く連続する入力では途切れにくいが、長い文が続くと再生が追いつかない場合がある**ので、クライアント側で数百 ms〜1 秒程度のバッファを持たせてください。
- 呼び出し例(Python、標準ライブラリ): `http.client` で POST し、`resp.read1()` で受けた行を `json.loads` する。

## VoxCPM2_server との差分

| 項目 | VoxCPM2_server | AivisSpeech_server |
|---|---|---|
| ポート | 8080 | 8082 |
| サンプルレート | 48000 | 48000(エンジンの 44100 から変換。`OUTPUT_SAMPLE_RATE` で変更、空でネイティブ) |
| キャッシュ(`/cache/*`、`X-TTS-Cache` の HIT/MISS) | あり | **なし**(`BYPASS` 固定、`/cache/*` は 404) |
| ボイスクローン・`DEFAULT_VOICE` | あり | なし(声は話者モデルで選ぶ) |
| 声デザイン `(説明)` | あり | 取り除いて読み上げない |
| 音量正規化 `OUTPUT_RMS_DBFS` | あり | あり(`/stream` と `pcm` は対象外) |
| 同時リクエスト | 直列化 | 直列化 |
| ライセンスゲート | なし | **あり**(下記) |

キャッシュを外した理由: 現状の RTF が 1 前後で、まず素の速度を見るため(要望による)。入れる場合は VoxCPM2 版の `cache_proxy.py` のキャッシュ部分(`Cache` / `make_key` / `index.jsonl`)を、`aivis_api.py` の `_speech` に移植するのが最短です。キーには `speaker`/`style` と声モデルの版(`model_version`)を含めてください。

## ライセンス

**結論**: 本体は商用利用可・クレジット不要ですが、**声モデルごとに別ライセンス**です。既定の 2 モデル(コハク、まお)は ACML 1.0 で、**禁止事項に該当しなければ営利利用も可能**です(2026-11-03 に実機の `/aivm_models` で確認)。ただし以下を必ず守ってください。これは法的助言ではなく、事業での利用前は原文と法務の確認を推奨します。

### 1. エンジン本体(LGPL-3.0)
- AivisSpeech Engine は VOICEVOX ENGINE のデュアルライセンスのうち **LGPL-3.0 のみ**を継承しています。公式の説明では、本体はクレジット表記不要で、個人・法人・商用・非商用を問わず利用できます。
- このフォルダは公式イメージを **無改変のまま別コンテナで動かし、HTTP 越しに呼ぶだけ**です。`proxy/aivis_api.py` は別プログラムであり、エンジンのコードを含みません。
- **イメージを改変・再配布する場合は LGPL-3.0 の義務(ソース提供など)が生じます**。社内サーバで動かすだけなら通常は該当しませんが、イメージや派生物を第三者に渡す場合は事前に確認してください。
- イメージにはエンジン以外の依存(Ubuntu、onnxruntime、BERT モデル `tsukumijima/deberta-v2-large-japanese-char-wwm`、OpenJTalk 辞書など)も含まれます。**これらの個別ライセンスは今回確認していません**(未確認)。配布や製品組み込みをする場合は別途確認してください。

### 2. 声モデル(モデルごとに別ライセンス)
- **ACML 1.0**(既定の 2 モデル): 個人・法人・営利・非営利のいずれも、禁止事項に該当しなければ利用可。クレジットは任意。主な禁止事項:
  - 話者本人・公式関係者だと誤解させる利用(ディープフェイク等)
  - 話者のイメージ・品位を傷つける利用
  - 実在の人物・団体・商品への批判・攻撃・誹謗中傷
  - 虚偽情報の流布、誇大広告・悪質商法などの倫理的に問題のある事業
  - 特定の政治・宗教・陰謀論などの主張の宣伝
  - 反社会的・犯罪目的(なりすまし詐欺など)
- **ACML-NC**(非営利限定)や、モデル作者独自のライセンスのものは **商用利用できない/条件が異なる**可能性があります。
- 不特定多数が任意のテキストを入力できるアプリ・Web サービスに組み込む場合、ACML は「開発元自身が遵守し、現実的な範囲で禁止事項に該当する利用を防ぐ努力をしていればよい」としています。**LLM の出力を直接読み上げさせる場合も、この努力義務(入力側のフィルタ等)はあなた側の責任**です。
- クレジットは任意ですが、コハクの説明文には「クレジットする際は『AivisSpeech: コハク』を」との依頼があります。

### 3. このサーバのライセンスゲート
`aivis_api.py` は合成のたびに、使う声モデルの `license`(AIVM マニフェスト)の **先頭行が `LICENSE_ALLOW` の接頭辞に一致するか**を確認します(既定は `# Aivis Common Model License (ACML)` のみ)。

- 一致しない声(ACML-NC、独自ライセンス、ライセンス未記載)は **HTTP 403** で拒否します(fail-closed)。題名に `NC` を含むものも拒否します。
- 起動ログと `GET /v1/audio/speech/models` / `./scripts/check-licenses.ps1` で、声ごとの `ALLOWED` / `BLOCKED` を確認できます。条文全文は `check-licenses.ps1 -Full` または `GET /license`。
- 新しい声モデル(`data/Models/` に `.aivmx` を置く、または Engine の API でインストール)を入れたら、**使う前に `check-licenses.ps1 -Full` で条文を読んでください**。`LICENSE_ALLOW` を広げるのは、条文を読んで商用可と判断したものだけにしてください。

> **ゲートが保証しないこと**: ゲートが見るのはモデルに記載されたライセンスの題名だけです。**モデル自体の権利の正当性(学習データの出所)は判定できません**。実際に、AivisHub に投稿された「Anneli」モデルが、声優の無許可音声で作られていたとして問題になり、削除された事例があります(二次情報による。公式ページでの確認は未実施)。同種のリスクを避けるため、**公式の既定モデル、または作者・出所が明確で信頼できるモデルだけ**を使ってください。

### 4. イメージの固定(再現性)
`cpu-latest` は更新されます。声モデルの既定セットやライセンスが変わる可能性があるため、本番運用では `.env` の `AIVIS_IMAGE` をダイジェスト固定にすることを推奨します。動作確認時点のダイジェスト:

```
AIVIS_IMAGE=ghcr.io/aivis-project/aivisspeech-engine@sha256:d53bf4052ecd86e6bc26b7ce8e6836bd3a16c56d1b9ed09ef47955da367052cd
```

なお、エンジンは起動時に AivisHub から「既定モデル」を自動インストール/更新する仕様です(`data/Models/` にモデルが無い場合のダウンロードを確認済み)。更新されたモデルのライセンスもゲートが判定します。

## 運用

```powershell
docker compose logs -f api      # アダプタのログ(合成ごとに音声長・生成時間・RTF を出力)
docker compose logs -f          # 全体
docker compose restart          # 再起動
docker compose down             # 停止・削除(data/ は残る)
```

設定は `.env` で変更し、`docker compose up -d` で反映します。

| 変数 | 既定 | 説明 |
|---|---|---|
| `PORT` | 8082 | ホスト側ポート |
| `BIND_ADDR` | 127.0.0.1 | `0.0.0.0` にすると LAN の他の端末からも到達可。**認証がないため、信頼できるネットワークのみ**で使ってください |
| `THREADS` | 8 | 推論スレッド数(`OMP_NUM_THREADS`)。物理コア数が目安。**効果は未計測** |
| `AIVIS_IMAGE` | `…:cpu-latest` | エンジンのイメージ(上記 4 参照) |
| `DEFAULT_SPEAKER` | 阿井田 茂 | 既定の話者名 |
| `DEFAULT_STYLE` | Heavy | 既定のスタイル名 |
| `DEFAULT_SPEED` / `DEFAULT_INTONATION_SCALE` / `DEFAULT_TEMPO_DYNAMICS_SCALE` / `DEFAULT_PITCH_SCALE` / `DEFAULT_VOLUME_SCALE` | 0.9 / 0.8 / 空 / 空 / 空 | リクエストで省略されたときの声の調整値(リクエストの指定が優先)。空ならエンジンの既定。**ピッチは 0 以外にすると遅くなる**(12 秒の文で RTF 約 0.9 → 1.4 を実測)うえ、音質も劣化することがある |
| `OUTPUT_SAMPLE_RATE` | 48000 | 出力サンプルレート。空でエンジンのネイティブ(44100) |
| `OUTPUT_RMS_DBFS` | -20 | 出力音量の目標(RMS, dBFS)。空で無効 |
| `LICENSE_ALLOW` | `# Aivis Common Model License (ACML)` | 合成を許可するライセンス題名の接頭辞(`;` 区切り) |

## 設計上の注意

- **同時リクエストは 1 件ずつ順番に**処理します(アダプタ側で直列化。smoke-test で 4.0 秒と 8.5 秒を確認)。クライアントのタイムアウトは長めにしてください。
- `data/` はコンテナ内ユーザー(uid 1000)が書き込みます。Docker Desktop(Windows)では問題なく動作しました。Linux ホストで権限エラーが出る場合は `data/` の所有者を uid 1000 にしてください。
- エンジンの `/docs`(Swagger UI)や `/audio_query` などは **ホストに公開していません**。ユーザー辞書の登録など Engine の機能が必要な場合は、`docker-compose.yml` で `aivisspeech` にポートを追加するか、`docker exec` で操作してください。

## 既知の制約・未確認事項
- RTF は約 1.0(ウォームアップ後、1 文の短文で計測)。長文での RTF、`THREADS` の効果、他スタイルでの速度は未計測です。
- 音質は未評価です(音声を聴いての確認は行っていません)。48kHz はエンジン内の 44.1kHz からの変換です。
- エンジンのイメージ内の第三者ライセンスは未確認です(上記 1)。
- 異常終了した `/stream` は、終端チャンクを送らずに接続を切ります(ヘッダ送信後はエラー応答に差し替えられないため)。

## 出典
- 推論エンジン: [Aivis-Project/AivisSpeech-Engine](https://github.com/Aivis-Project/AivisSpeech-Engine)(イメージ: `ghcr.io/aivis-project/aivisspeech-engine`)
- 声モデル: AivisHub 配信の既定モデル(コハク、まお。いずれも ACML 1.0)

## 付録. 音声モデルURL
- 阿井田 茂
https://hub.aivis-project.com/aivm-models/47e53151-a378-46f3-abee-ce13aa07feb1

// 展示会コンシェルジュの設定。書いた項目だけが既定値(app.js の DEFAULTS)を上書きする。
//
// 接続先について
//   serve.py 経由で開く場合(おすすめ): '/gryphon' と '/tts' のままでよい。
//     実際の接続先は start.bat(serve.py)側に書く。APIキーもそちらに書けばブラウザに載らない。
//   index.html を直接開く/別のWebサーバに置く場合: 実際のURLを書く。
//     その場合 GRYPHON と TTSサーバの両方がCORSヘッダを返す必要がある。
window.CONCIERGE_CONFIG = {
  gryphon: {
    baseUrl: '/gryphon', // 直接なら例: 'http://gryphon.example.local/v1'
    apiKey: '', // serve.py 側で付けるなら空のまま
    inputs: {},
    // 回答を短く・端的・丁寧にするルール(prompts/answer-rules.txt)の渡し方
    //   'append' 質問文の末尾に付けて送る / 'inputs' inputs.answer_rules で渡す / 'off' 送らない
    // prompts/system-prompt.md を GRYPHON か Copilot Studio に入れたら 'off' にする
    answerRulesMode: 'append'
  },

  tts: {
    enabled: true,
    baseUrl: '/tts', // 直接なら例: 'http://127.0.0.1:8082'(AivisSpeech は CORS ヘッダを返さないので serve.py 経由を推奨)
    // AivisSpeech の /v1/audio/speech/events に { input: 文, ...params } を送り、文ごとに届いた音声から鳴らす
    // 省略したキーはサーバの既定値(阿井田 茂 / Heavy、speed 0.9 など)。例:
    //   params: { speaker: 'まお', style: 'おちつき', speed: 1.0 }
    params: {}
  },

  ui: {
    layout: 'bubble', // 'bubble' 吹き出し / 'panel' パネル
    brandName: 'Your Company',
    boothTitle: 'AI Platform Showcase',
    assistantName: 'ご案内AI',
    accent: '#0E7C86'
  },

  presets: [
    'このブースでは何を展示していますか？',
    'オンプレミスでLLMを使うメリットは？',
    '社内の文書を使ったAI検索はできますか？',
    'Microsoft Copilot Studioと連携できますか？',
    '導入までの期間と進め方を教えてください',
    '資料やデモの相談はどこでできますか？'
  ]
};

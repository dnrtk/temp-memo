#Requires -Version 7
<#
.SYNOPSIS
  起動中のサーバに対する動作確認。health / models / 通常合成(WAV) / ストリーミング / ライセンスゲート / 同時リクエストを試す。
.EXAMPLE
  ./scripts/smoke-test.ps1
  ./scripts/smoke-test.ps1 -Text "こんにちは。" -BaseUrl http://127.0.0.1:8082
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://127.0.0.1:8082',
    [string]$Text = 'こんにちは。今日はローカルの音声合成を試しています。',
    [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'out')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Get-WavSeconds([string]$Path) {
    # 標準WAV(44byteヘッダ, PCM16 mono)前提。サンプルレートはヘッダから読む
    $b = [System.IO.File]::ReadAllBytes($Path)
    $rate = [BitConverter]::ToInt32($b, 24)
    return [math]::Round(($b.Length - 44) / 2 / $rate, 2)
}

function Invoke-Tts([string]$Path, [string]$Body, [string]$OutFile) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Invoke-WebRequest -Uri "$BaseUrl$Path" -Method Post -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($Body)) -OutFile $OutFile -TimeoutSec 1800
    $sw.Stop()
    [pscustomobject]@{ File = (Split-Path $OutFile -Leaf); Sec = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
}

$body = @{ input = $Text } | ConvertTo-Json -Compress

Write-Host '== health'
Invoke-RestMethod "$BaseUrl/health" | ConvertTo-Json -Compress

Write-Host '== models / 声とライセンス判定'
$m = (Invoke-RestMethod "$BaseUrl/v1/audio/speech/models").data[0]
"sample_rate=$($m.sample_rate) default=$($m.default_speaker)/$($m.default_style)"
$m.speakers | ForEach-Object { "{0}: {1} -> allowed={2}" -f $_.name, $_.license_title, $_.license_allowed }

Write-Host '== /v1/audio/speech (WAV 一括。初回はモデルのウォームアップで遅いので 2 回測る)'
foreach ($i in 1..2) {
    $r = Invoke-Tts '/v1/audio/speech' $body (Join-Path $OutDir 'speech.wav')
    $a = Get-WavSeconds (Join-Path $OutDir 'speech.wav')
    "run{0} {1}: 音声 {2}s / 所要 {3}s / RTF {4}" -f $i, $r.File, $a, $r.Sec, [math]::Round($r.Sec / $a, 2)
}

Write-Host '== /v1/audio/speech/stream (文ごとにチャンク転送)'
$r = Invoke-Tts '/v1/audio/speech/stream' (@{ input = '一文目です。二文目です。三文目です。' } | ConvertTo-Json -Compress) (Join-Path $OutDir 'stream.wav')
"{0}: 所要 {1}s(ヘッダのサイズが不定のため長さは参考値)" -f $r.File, $r.Sec

Write-Host '== ライセンスゲート(存在しない/不許可の声は拒否される)'
$bad = @{ input = 'test'; speaker = '存在しない話者' } | ConvertTo-Json -Compress
$resp = Invoke-WebRequest -Uri "$BaseUrl/v1/audio/speech" -Method Post -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($bad)) -SkipHttpErrorCheck
"HTTP $($resp.StatusCode)(400 が期待値): $($resp.Content)"

Write-Host '== 同時2リクエスト(直列化されること)'
$jobs = 1..2 | ForEach-Object {
    $i = $_
    Start-ThreadJob -ArgumentList $BaseUrl, $body, (Join-Path $OutDir "concurrent$i.wav") -ScriptBlock {
        param($u, $b, $f)
        $sw = [Diagnostics.Stopwatch]::StartNew()
        Invoke-WebRequest -Uri "$u/v1/audio/speech" -Method Post -ContentType 'application/json; charset=utf-8' `
            -Body ([Text.Encoding]::UTF8.GetBytes($b)) -OutFile $f -TimeoutSec 1800
        [math]::Round($sw.Elapsed.TotalSeconds, 1)
    }
}
$t = $jobs | Wait-Job | Receive-Job
"2リクエストの所要(秒): $($t -join ', ')  ※片方がもう片方の約2倍なら直列化されている"
Write-Host "出力先: $OutDir" -ForegroundColor Green

#Requires -Version 7
<#
.SYNOPSIS
  起動中のサーバに対する動作確認。health / 通常合成(WAV) / キャッシュ / ストリーミング / 同時リクエストを試す。
  速度測定のリクエストは Cache-Control: no-cache でキャッシュを使わず生成させる(結果は上書き保存される)。
.EXAMPLE
  ./scripts/smoke-test.ps1
  ./scripts/smoke-test.ps1 -Text "こんにちは。" -Timesteps 5 -BaseUrl http://127.0.0.1:8080
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://127.0.0.1:8080',
    [string]$Text = 'こんにちは。今日はローカルの音声合成を試しています。',
    [int]$Timesteps = 5,
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
        -Body ([Text.Encoding]::UTF8.GetBytes($Body)) -Headers @{ 'Cache-Control' = 'no-cache' } -OutFile $OutFile -TimeoutSec 1800
    $sw.Stop()
    [pscustomobject]@{ File = (Split-Path $OutFile -Leaf); Sec = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
}

$body = @{ input = $Text; inference_timesteps = $Timesteps } | ConvertTo-Json -Compress

Write-Host '== health'
Invoke-RestMethod "$BaseUrl/health" | ConvertTo-Json -Compress

Write-Host '== /v1/audio/speech (WAV 一括)'
$r = Invoke-Tts '/v1/audio/speech' $body (Join-Path $OutDir 'speech.wav')
$a = Get-WavSeconds (Join-Path $OutDir 'speech.wav')
"{0}: 音声 {1}s / 所要 {2}s / RTF {3}" -f $r.File, $a, $r.Sec, [math]::Round($r.Sec / $a, 2)

Write-Host '== キャッシュ(同じ内容を再送すると即座に返る)'
$sw = [Diagnostics.Stopwatch]::StartNew()
$resp = Invoke-WebRequest -Uri "$BaseUrl/v1/audio/speech" -Method Post -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 1800
"X-TTS-Cache={0} / 所要 {1}s(HIT なら 1 秒未満)" -f $resp.Headers['X-TTS-Cache'][0], [math]::Round($sw.Elapsed.TotalSeconds, 2)
Invoke-RestMethod "$BaseUrl/cache/texts?limit=3" | ConvertTo-Json -Compress

Write-Host '== /v1/audio/speech/stream (チャンク転送)'
$r = Invoke-Tts '/v1/audio/speech/stream' $body (Join-Path $OutDir 'stream.wav')
"{0}: 所要 {1}s(ヘッダのサイズが不定のため長さは参考値)" -f $r.File, $r.Sec

Write-Host '== 同時2リクエスト(直列化されること)'
$jobs = 1..2 | ForEach-Object {
    $i = $_
    Start-ThreadJob -ArgumentList $BaseUrl, $body, (Join-Path $OutDir "concurrent$i.wav") -ScriptBlock {
        param($u, $b, $f)
        $sw = [Diagnostics.Stopwatch]::StartNew()
        Invoke-WebRequest -Uri "$u/v1/audio/speech" -Method Post -ContentType 'application/json; charset=utf-8' `
            -Body ([Text.Encoding]::UTF8.GetBytes($b)) -Headers @{ 'Cache-Control' = 'no-cache' } -OutFile $f -TimeoutSec 1800
        [math]::Round($sw.Elapsed.TotalSeconds, 1)
    }
}
$t = $jobs | Wait-Job | Receive-Job
"2リクエストの所要(秒): $($t -join ', ')  ※片方がもう片方の約2倍なら直列化されている"
Write-Host "出力先: $OutDir" -ForegroundColor Green

#Requires -Version 7
<#
.SYNOPSIS
  GGUF 重みを ../models に取得する(Python 不要。Windows 標準の curl.exe を使用)。
.EXAMPLE
  ./scripts/download-models.ps1            # Q8_0(既定)+ Acoustic
  ./scripts/download-models.ps1 -F16       # BaseLM F16 も取得
#>
[CmdletBinding()]
param([switch]$F16)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = 'DennisHuang648/VoxCPM2-GGUF'
$models = Join-Path (Split-Path -Parent $PSScriptRoot) 'models'
New-Item -ItemType Directory -Force -Path $models | Out-Null

$files = @('VoxCPM2-BaseLM-Q8_0.gguf', 'VoxCPM2-Acoustic-F16.gguf')
if ($F16) { $files += 'VoxCPM2-BaseLM-F16.gguf' }

foreach ($f in $files) {
    $dest = Join-Path $models $f
    if (Test-Path -LiteralPath $dest) {
        Write-Host "skip (exists): $f"
        continue
    }
    $tmp = "$dest.part"
    Write-Host "downloading $f ..."
    # -C - で中断再開、--fail で HTTP エラーを失敗扱いにする
    & curl.exe -L --fail -C - -o $tmp "https://huggingface.co/$repo/resolve/main/$f"
    if ($LASTEXITCODE -ne 0) { throw "download failed: $f" }
    Move-Item -LiteralPath $tmp -Destination $dest
}
Write-Host 'done' -ForegroundColor Green

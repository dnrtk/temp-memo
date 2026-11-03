#Requires -Version 7
<#
.SYNOPSIS
  インストール済みの声モデルごとに、ライセンスの題名・版・ゲート判定を表示する。-Full で条文全文も出す。
  新しい声モデルを入れたら、商用利用の前に必ず実行して条文を確認すること。
.EXAMPLE
  ./scripts/check-licenses.ps1
  ./scripts/check-licenses.ps1 -Full
#>
[CmdletBinding()]
param([string]$BaseUrl = 'http://127.0.0.1:8082', [switch]$Full)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$m = (Invoke-RestMethod "$BaseUrl/v1/audio/speech/models").data[0]
Write-Host "許可する接頭辞: $($m.license_allow -join ' ; ')"
$m.speakers | ForEach-Object {
    $color = $_.license_allowed ? 'Green' : 'Red'
    Write-Host ("{0} (v{1}) [{2}]  {3}" -f $_.name, $_.model_version, ($_.license_allowed ? 'ALLOWED' : 'BLOCKED'), $_.license_title) -ForegroundColor $color
    if (-not $_.license_allowed) { Write-Host "  理由: $($_.license_reason)" -ForegroundColor Red }
}
if ($Full) {
    (Invoke-RestMethod "$BaseUrl/license").PSObject.Properties | ForEach-Object {
        Write-Host "`n===== $($_.Value.name) ($($_.Name)) v$($_.Value.version) ====="
        $_.Value.license
    }
}

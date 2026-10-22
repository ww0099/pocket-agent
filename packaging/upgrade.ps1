param(
  [Parameter(Mandatory = $true)][string]$Source,
  [switch]$SkipCheck
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$rootPath = (Resolve-Path -LiteralPath $root).Path

if ($sourcePath -eq $rootPath) {
  throw '源目录不能是当前 Agent 目录'
}

if (-not (Test-Path -LiteralPath (Join-Path $sourcePath 'app\dist\cli.js'))) {
  throw '源目录缺少 app\dist\cli.js'
}

$backupDir = Join-Path (Join-Path $rootPath 'backup') (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

foreach ($relative in @('app', 'runtime', 'tools')) {
  $existing = Join-Path $rootPath $relative
  if (Test-Path -LiteralPath $existing) {
    Copy-Item -LiteralPath $existing -Destination (Join-Path $backupDir $relative) -Recurse -Force
  }
}

foreach ($relative in @('app', 'runtime', 'tools')) {
  $incoming = Join-Path $sourcePath $relative
  if (-not (Test-Path -LiteralPath $incoming)) { continue }

  $destination = Join-Path $rootPath $relative
  if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
  }
  Copy-Item -LiteralPath $incoming -Destination $destination -Recurse -Force
}

$incomingDocs = Join-Path $sourcePath 'docs'
if (Test-Path -LiteralPath $incomingDocs) {
  $docsDestination = Join-Path $rootPath 'docs'
  New-Item -ItemType Directory -Path $docsDestination -Force | Out-Null
  Copy-Item -Path (Join-Path $incomingDocs '*') -Destination $docsDestination -Recurse -Force
}

$incomingVersion = Join-Path $sourcePath 'VERSION.json'
if (Test-Path -LiteralPath $incomingVersion) {
  Copy-Item -LiteralPath $incomingVersion -Destination (Join-Path $rootPath 'VERSION.json') -Force
}

Write-Host "升级完成。备份：$backupDir"
Write-Host 'config / data / memory / skills / agents / commands 未被改动。'

if (-not $SkipCheck) {
  & (Join-Path $rootPath 'agent.cmd') --check
  exit $LASTEXITCODE
}

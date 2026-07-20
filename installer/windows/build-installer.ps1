[CmdletBinding()]
param(
  [string]$OutputDir,
  [string]$PresetSource
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $OutputDir) { $OutputDir = Join-Path $repoRoot 'output\installer' }
if (-not $PresetSource) {
  $localEnv = Join-Path $repoRoot '.env'
  $PresetSource = if (Test-Path -LiteralPath $localEnv) { $localEnv } else { Join-Path $repoRoot '.env.example' }
}
$systemDirectory = [Environment]::GetFolderPath('System')
if (-not $systemDirectory) { $systemDirectory = Join-Path $env:SystemRoot 'System32' }
$iexpress = Join-Path $systemDirectory 'iexpress.exe'
if (-not (Test-Path -LiteralPath $iexpress -PathType Leaf)) { throw "IExpress was not found: $iexpress" }

Push-Location $repoRoot
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }
} finally { Pop-Location }

$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ide-super-worker-installer-" + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $workRoot 'stage'
$payloadRoot = Join-Path $stage 'payload'
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $repoRoot 'dist') -Destination $payloadRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'node_modules') -Destination $payloadRoot -Recurse -Force
Push-Location $payloadRoot
try {
  & npm prune --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm prune --omit=dev failed with exit code $LASTEXITCODE." }
} finally { Pop-Location }
foreach ($file in @('package.json', 'package-lock.json', 'LICENSE', '.env.example')) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $payloadRoot $file) -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-mcp.ps1') -Destination (Join-Path $stage 'install-mcp.ps1') -Force

$secretPattern = '(?i)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)'
$presetLines = foreach ($rawLine in Get-Content -LiteralPath $PresetSource -Encoding UTF8) {
  $line = $rawLine.Trim()
  if ($line -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { continue }
  $name = $Matches[1]
  $value = if ($name -match $secretPattern) { '' } else { $Matches[2] }
  "$name=$value"
}
[System.IO.File]::WriteAllLines((Join-Path $stage 'preset.env'), [string[]]$presetLines, [System.Text.UTF8Encoding]::new($false))

$payloadZip = Join-Path $stage 'payload.zip'
Compress-Archive -Path (Join-Path $payloadRoot '*') -DestinationPath $payloadZip -CompressionLevel Optimal -Force
Remove-Item -LiteralPath $payloadRoot -Recurse -Force

$launch = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-mcp.ps1" -SourceDir "%~dp0"
if errorlevel 1 pause
'@
[System.IO.File]::WriteAllText((Join-Path $stage 'launch.cmd'), $launch, [System.Text.Encoding]::ASCII)

$targetExe = Join-Path $OutputDir 'IDE-Super-Worker-Setup.exe'
$temporaryExe = Join-Path $workRoot 'IDE-Super-Worker-Setup.exe'
$sourceDir = $stage.TrimEnd('\') + '\'
$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$temporaryExe
FriendlyName=IDE Super Worker Setup
AppLaunched=launch.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0="launch.cmd"
FILE1="install-mcp.ps1"
FILE2="preset.env"
FILE3="payload.zip"
[SourceFiles]
SourceFiles0=$sourceDir
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
%FILE3%=
"@
$sedPath = Join-Path $stage 'installer.sed'
[System.IO.File]::WriteAllText($sedPath, $sed, [System.Text.Encoding]::ASCII)

& $iexpress /N $sedPath
$iexpressExitCode = $LASTEXITCODE
$readyDeadline = (Get-Date).AddSeconds(30)
$installerReady = $false
while (-not $installerReady -and (Get-Date) -lt $readyDeadline) {
  if (Test-Path -LiteralPath $temporaryExe -PathType Leaf) {
    try {
      $stream = [System.IO.File]::Open($temporaryExe, 'Open', 'Read', 'None')
      $stream.Dispose()
      $installerReady = $true
      break
    } catch [System.IO.IOException] {
      # IExpress creates the file before it releases the final write handle.
    }
  }
  Start-Sleep -Milliseconds 250
}
if ($iexpressExitCode -ne 0 -or -not $installerReady) {
  throw "IExpress failed to create installer in temporary build directory: $workRoot"
}
Copy-Item -LiteralPath $temporaryExe -Destination $targetExe -Force
$portableZip = Join-Path $OutputDir 'IDE-Super-Worker-Offline.zip'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $portableZip -CompressionLevel Optimal -Force
Remove-Item -LiteralPath $workRoot -Recurse -Force

$sizeMiB = [math]::Round((Get-Item -LiteralPath $targetExe).Length / 1MB, 2)
Write-Host "[installer] Created: $targetExe ($sizeMiB MiB)"
Write-Host "[installer] Created: $portableZip (use install-mcp.ps1 -EnvFile for offline deployment)"
Write-Host '[installer] Secret-like preset values were blanked. Review non-secret URLs and paths before distributing this EXE.'

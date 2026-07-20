[CmdletBinding()]
param(
  [string]$SourceDir = $PSScriptRoot,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'IDE Super Worker'),
  [string]$SandboxRoot,
  [string]$GatewayUrl,
  [string]$Model,
  [string]$ClaudeCodeModel,
  [string]$ApiKey,
  [string]$EnvFile,
  [string]$PresetPath,
  [string]$CodexConfigPath = (Join-Path $HOME '.codex\config.toml'),
  [switch]$NonInteractive,
  [switch]$DryRun,
  [switch]$SkipPayloadInstall,
  [switch]$SkipDependencyInstall,
  [switch]$SkipDoctor
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-DotEnv {
  param([string]$Path)
  $values = [ordered]@{}
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $values }

  foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $equals = $line.IndexOf('=')
    if ($equals -le 0) { continue }
    $name = $line.Substring(0, $equals).Trim()
    $value = $line.Substring($equals + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$name] = $value
  }
  return $values
}

function Assert-SingleLine {
  param([string]$Name, [string]$Value)
  if ($Value -match "[\r\n]") { throw "$Name must be a single-line value." }
}

function ConvertTo-DotEnvValue {
  param([string]$Value)
  Assert-SingleLine -Name 'Environment value' -Value $Value
  if ($Value -match '[\s#"'']') {
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
  }
  return $Value
}

function Escape-TomlString {
  param([string]$Value)
  Assert-SingleLine -Name 'TOML value' -Value $Value
  return $Value.Replace('\', '\\').Replace('"', '\"')
}

function Remove-WorkerConfigTables {
  param([string]$Text)
  $kept = [System.Collections.Generic.List[string]]::new()
  $skip = $false
  foreach ($line in ($Text -split "\r?\n")) {
    if ($line -match '^\s*\[([^\]]+)\]\s*(?:#.*)?$') {
      $section = $Matches[1].Trim()
      $skip = $section -eq 'mcp_servers.codex_async_worker' -or $section.StartsWith('mcp_servers.codex_async_worker.')
      if ($skip) { continue }
    }
    if (-not $skip) { $kept.Add($line) }
  }
  return ($kept -join [Environment]::NewLine).TrimEnd()
}

function New-WorkerConfigBlock {
  param([string]$Root)
  $nodeArgs = Join-Path $Root 'dist\index.js'
  $rootEscaped = Escape-TomlString $Root
  $argsEscaped = Escape-TomlString $nodeArgs
  return @"
[mcp_servers.codex_async_worker]
command = "node"
args = ["$argsEscaped"]
cwd = "$rootEscaped"
startup_timeout_sec = 10
tool_timeout_sec = 3600
"@.Trim()
}

function Show-SetupDialog {
  param([System.Collections.IDictionary]$Preset)
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $form = [System.Windows.Forms.Form]@{
    Text = 'IDE Super Worker 一键安装'
    Width = 620
    Height = 430
    StartPosition = 'CenterScreen'
    FormBorderStyle = 'FixedDialog'
    MaximizeBox = $false
    MinimizeBox = $false
  }

  $fields = @(
    @{ Label = '允许访问的工作区'; Name = 'SandboxRoot'; Value = $Preset['SANDBOX_ROOT']; Password = $false },
    @{ Label = '模型网关地址'; Name = 'GatewayUrl'; Value = $Preset['ONEAPI_BASE_URL']; Password = $false },
    @{ Label = 'Worker 模型'; Name = 'Model'; Value = $Preset['CLAUDE_MODEL']; Password = $false },
    @{ Label = 'Claude Code 模型'; Name = 'ClaudeCodeModel'; Value = $Preset['CLAUDE_CODE_MODEL']; Password = $false },
    @{ Label = '网关 API Key'; Name = 'ApiKey'; Value = ''; Password = $true }
  )

  $controls = @{}
  $top = 25
  foreach ($field in $fields) {
    $label = [System.Windows.Forms.Label]@{ Text = $field.Label; Left = 25; Top = $top + 4; Width = 145 }
    $box = [System.Windows.Forms.TextBox]@{ Left = 175; Top = $top; Width = 390; Text = [string]$field.Value }
    if ($field.Password) { $box.UseSystemPasswordChar = $true }
    $form.Controls.Add($label)
    $form.Controls.Add($box)
    $controls[$field.Name] = $box
    $top += 54
  }

  $notice = [System.Windows.Forms.Label]@{
    Text = '密钥只写入本机安装目录的 .env，不写入 Codex config.toml。安装前会自动备份原配置。'
    Left = 25
    Top = 300
    Width = 540
    Height = 38
  }
  $installButton = [System.Windows.Forms.Button]@{ Text = '安装并配置'; Left = 345; Top = 345; Width = 105; DialogResult = 'OK' }
  $cancelButton = [System.Windows.Forms.Button]@{ Text = '取消'; Left = 460; Top = 345; Width = 105; DialogResult = 'Cancel' }
  $form.Controls.Add($notice)
  $form.Controls.Add($installButton)
  $form.Controls.Add($cancelButton)
  $form.AcceptButton = $installButton
  $form.CancelButton = $cancelButton

  if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
  return @{
    SandboxRoot = $controls.SandboxRoot.Text.Trim()
    GatewayUrl = $controls.GatewayUrl.Text.Trim()
    Model = $controls.Model.Text.Trim()
    ClaudeCodeModel = $controls.ClaudeCodeModel.Text.Trim()
    ApiKey = $controls.ApiKey.Text
  }
}

$preset = [ordered]@{}
$requiredEnvFileVariables = @('ONEAPI_BASE_URL', 'ONEAPI_API_KEY', 'CLAUDE_MODEL', 'CLAUDE_CODE_MODEL', 'SANDBOX_ROOT')
if ($PresetPath) {
  $preset = Read-DotEnv -Path $PresetPath
} elseif (-not $EnvFile) {
  $preset = Read-DotEnv -Path (Join-Path $SourceDir 'preset.env')
}
if ($EnvFile) {
  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "EnvFile was not found: $EnvFile" }
  $importedEnv = Read-DotEnv -Path $EnvFile
  foreach ($entry in $importedEnv.GetEnumerator()) {
    if ($entry.Key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "EnvFile contains an invalid variable name: $($entry.Key)" }
    Assert-SingleLine -Name $entry.Key -Value ([string]$entry.Value)
    $preset[$entry.Key] = [string]$entry.Value
  }
  foreach ($name in $requiredEnvFileVariables) {
    if (-not $preset.Contains($name) -or [string]::IsNullOrWhiteSpace([string]$preset[$name])) { throw "EnvFile must define $name." }
  }
}
if (-not $preset.Contains('SANDBOX_ROOT')) { $preset['SANDBOX_ROOT'] = 'D:/workspaces' }
if (-not $preset.Contains('ONEAPI_BASE_URL')) { $preset['ONEAPI_BASE_URL'] = 'https://your-gateway.example.com/v1' }
if (-not $preset.Contains('CLAUDE_MODEL')) { $preset['CLAUDE_MODEL'] = 'deepseek-v4-flash' }
if (-not $preset.Contains('CLAUDE_CODE_MODEL')) { $preset['CLAUDE_CODE_MODEL'] = 'sonnet' }

if (-not $NonInteractive) {
  $selection = Show-SetupDialog -Preset $preset
  if ($null -eq $selection) { Write-Host '[setup] Cancelled.'; exit 1 }
  $SandboxRoot = $selection.SandboxRoot
  $GatewayUrl = $selection.GatewayUrl
  $Model = $selection.Model
  $ClaudeCodeModel = $selection.ClaudeCodeModel
  if ($selection.ApiKey) { $ApiKey = $selection.ApiKey }
}

if (-not $SandboxRoot) { $SandboxRoot = [string]$preset['SANDBOX_ROOT'] }
if (-not $GatewayUrl) { $GatewayUrl = [string]$preset['ONEAPI_BASE_URL'] }
if (-not $Model) { $Model = [string]$preset['CLAUDE_MODEL'] }
if (-not $ClaudeCodeModel) { $ClaudeCodeModel = [string]$preset['CLAUDE_CODE_MODEL'] }
if (-not $ApiKey -and $preset.Contains('ONEAPI_API_KEY')) { $ApiKey = [string]$preset['ONEAPI_API_KEY'] }
foreach ($entry in @{ InstallDir=$InstallDir; SandboxRoot=$SandboxRoot; GatewayUrl=$GatewayUrl; Model=$Model; ClaudeCodeModel=$ClaudeCodeModel }.GetEnumerator()) {
  if (-not [string]$entry.Value) { throw "$($entry.Key) is required." }
  Assert-SingleLine -Name $entry.Key -Value ([string]$entry.Value)
}
if ($GatewayUrl -notmatch '^https?://') { throw 'GatewayUrl must start with http:// or https://.' }
if (-not $DryRun -and [string]::IsNullOrWhiteSpace($ApiKey)) { throw 'ApiKey is required for installation.' }

$configBlock = New-WorkerConfigBlock -Root $InstallDir
$existingConfig = if (Test-Path -LiteralPath $CodexConfigPath -PathType Leaf) {
  Get-Content -LiteralPath $CodexConfigPath -Raw -Encoding UTF8
} else { '' }
$baseConfig = Remove-WorkerConfigTables -Text $existingConfig
$newConfig = (($baseConfig, $configBlock | Where-Object { $_ }) -join ([Environment]::NewLine + [Environment]::NewLine)).Trim() + [Environment]::NewLine

if ($DryRun) {
  Write-Host '[setup] Dry run passed.'
  Write-Host "[setup] Install directory: $InstallDir"
  Write-Host "[setup] Sandbox root: $SandboxRoot"
  Write-Host "[setup] Codex config: $CodexConfigPath"
  exit 0
}

if (-not $SkipPayloadInstall) {
  $payload = Join-Path $SourceDir 'payload.zip'
  if (-not (Test-Path -LiteralPath $payload -PathType Leaf)) { throw "Missing installer payload: $payload" }
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Expand-Archive -LiteralPath $payload -DestinationPath $InstallDir -Force
} else {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$installedEnv = [ordered]@{}
foreach ($key in $preset.Keys) { $installedEnv[$key] = [string]$preset[$key] }
$installedEnv['SANDBOX_ROOT'] = $SandboxRoot
$installedEnv['ONEAPI_BASE_URL'] = $GatewayUrl
$installedEnv['CLAUDE_MODEL'] = $Model
$installedEnv['CLAUDE_CODE_MODEL'] = $ClaudeCodeModel
$installedEnv['ONEAPI_API_KEY'] = [string]$ApiKey
$envLines = foreach ($key in $installedEnv.Keys) {
  if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
  "$key=$(ConvertTo-DotEnvValue ([string]$installedEnv[$key]))"
}
[System.IO.File]::WriteAllLines((Join-Path $InstallDir '.env'), [string[]]$envLines, [System.Text.UTF8Encoding]::new($false))

if (-not $SkipDependencyInstall) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required but was not found in PATH.' }
  if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'node_modules') -PathType Container)) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required when bundled dependencies are unavailable.' }
    Push-Location $InstallDir
    try {
      & npm install --omit=dev --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }
    } finally { Pop-Location }
  }
}

$configDir = Split-Path -Parent $CodexConfigPath
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
if (Test-Path -LiteralPath $CodexConfigPath -PathType Leaf) {
  $backup = "$CodexConfigPath.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $CodexConfigPath -Destination $backup -Force
  Write-Host "[setup] Backed up Codex config: $backup"
}
[System.IO.File]::WriteAllText($CodexConfigPath, $newConfig, [System.Text.UTF8Encoding]::new($false))

if (-not $SkipDoctor) {
  $doctor = Join-Path $InstallDir 'dist\doctor.js'
  if (-not (Test-Path -LiteralPath $doctor -PathType Leaf)) { throw "Missing doctor entry point: $doctor" }
  Push-Location $InstallDir
  try {
    & node $doctor --codex
    if ($LASTEXITCODE -ne 0) { throw "Doctor failed with exit code $LASTEXITCODE." }
  } finally { Pop-Location }
}

Write-Host '[setup] IDE Super Worker installed successfully.'
Write-Host '[setup] Restart Codex, then use /mcp to verify codex_async_worker.'

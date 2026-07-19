[CmdletBinding()]
param(
  [string]$TaskName = 'IDE Super Worker Guard',
  [string]$EventSource = 'IDE Super Worker',
  [string]$RepoRoot,
  [switch]$Uninstall,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }

$node = (Get-Command node.exe -ErrorAction Stop).Source
$guard = Join-Path $RepoRoot 'scripts\codex_guard.mjs'
if (-not (Test-Path -LiteralPath $guard -PathType Leaf)) { throw "Guard script not found: $guard" }

if ($DryRun) {
  [ordered]@{
    task_name = $TaskName
    event_source = $EventSource
    executable = $node
    arguments = "`"$guard`" --watch"
    working_directory = $RepoRoot
    interval_minutes = 15
    multiple_instances = 'IgnoreNew'
    start_when_available = $true
    execution_time_limit_minutes = 5
    uninstall = [bool]$Uninstall
  } | ConvertTo-Json
  exit 0
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this installer once from an elevated PowerShell session.'
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  if ([System.Diagnostics.EventLog]::SourceExists($EventSource)) {
    [System.Diagnostics.EventLog]::DeleteEventSource($EventSource)
  }
  Write-Host "Removed task and Event Log source. Metrics and guard status were preserved."
  exit 0
}

if (-not [System.Diagnostics.EventLog]::SourceExists($EventSource)) {
  New-EventLog -LogName Application -Source $EventSource
}
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$guard`" --watch" -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null
Write-Host "Installed '$TaskName' (15 minute interval, no overlap, 5 minute limit)."

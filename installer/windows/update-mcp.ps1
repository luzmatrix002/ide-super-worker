[CmdletBinding()]
param(
  [ValidateSet('Check','Apply','Rollback')][string]$Mode = 'Check',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'IDE Super Worker'),
  [string]$Repository = 'luzmatrix002/ide-super-worker',
  [string]$PublisherSubject
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) { Write-Error "[update] $Message"; exit 1 }
function Get-LatestRelease {
  param([string]$StatePath)
  $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'IDE-Super-Worker-Updater' }
  if (Test-Path $StatePath) {
    try { $state = Get-Content $StatePath -Raw | ConvertFrom-Json; if ($state.etag) { $headers['If-None-Match'] = $state.etag } } catch { }
  }
  try { $response = Invoke-WebRequest -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers $headers -UseBasicParsing } catch { Fail "Unable to check GitHub Release: $($_.Exception.Message)" }
  if ($response.StatusCode -eq 304) { return $null }
  $release = $response.Content | ConvertFrom-Json
  if ($release.prerelease -or $release.draft -or $release.tag_name -notmatch '^v\d+\.\d+\.\d+$') { Fail 'Latest release is not a stable semantic version.' }
  [pscustomobject]@{ Release = $release; ETag = $response.Headers.ETag }
}

if (-not (Test-Path $InstallDir -PathType Container)) { Fail "Install directory not found: $InstallDir" }
$lockPath = Join-Path $InstallDir '.update.lock'
try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') } catch { Fail 'Another update is already running.' }
try {
  $statePath = Join-Path $InstallDir 'update-state.json'
  if ($Mode -eq 'Rollback') {
    $current = Join-Path $InstallDir 'current'; $previous = Join-Path $InstallDir 'previous'; $staging = Join-Path $InstallDir '.rollback-staging'
    if (-not (Test-Path $previous -PathType Container)) { Fail 'No previous version is available.' }
    Move-Item $current $staging -ErrorAction Stop; Move-Item $previous $current -ErrorAction Stop; Move-Item $staging $previous -ErrorAction Stop
    Write-Host '[update] Rolled back successfully.'; exit 0
  }
  $latest = Get-LatestRelease -StatePath $statePath
  if ($null -eq $latest) { Write-Host '[update] No newer release metadata.'; exit 0 }
  $asset = @($latest.Release.assets | Where-Object { $_.name -eq 'IDE-Super-Worker-Setup.exe' }) | Select-Object -First 1
  if ($null -eq $asset) { Fail 'Release does not contain IDE-Super-Worker-Setup.exe.' }
  if ($Mode -eq 'Check') { Write-Host "[update] Available: $($latest.Release.tag_name)"; exit 0 }
  $staging = Join-Path $InstallDir ('.staging-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory $staging | Out-Null
  $installer = Join-Path $staging $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer -UseBasicParsing
  if ($asset.digest -and $asset.digest -match '^sha256:([a-fA-F0-9]{64})$') { if ((Get-FileHash $installer -Algorithm SHA256).Hash -ne $Matches[1].ToUpper()) { Fail 'Downloaded installer SHA-256 mismatch.' } }
  if ($PublisherSubject) { $signature = Get-AuthenticodeSignature $installer; if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -ne $PublisherSubject) { Fail 'Installer signature validation failed.' } }
  $state = @{ etag = $latest.ETag; tag = $latest.Release.tag_name; checkedAt = (Get-Date).ToString('o') } | ConvertTo-Json
  [IO.File]::WriteAllText($statePath, $state, [Text.UTF8Encoding]::new($false))
  $process = Start-Process -FilePath $installer -Wait -PassThru
  if ($process.ExitCode -ne 0) { Fail 'Installer returned a failure status.' }
  Write-Host "[update] Updated to $($latest.Release.tag_name)."
} finally { if ($lock) { $lock.Dispose() }; Remove-Item $lockPath -Force -ErrorAction SilentlyContinue }

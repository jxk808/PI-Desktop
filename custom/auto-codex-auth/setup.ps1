param(
  [string]$Destination = (Join-Path $env:USERPROFILE '.pi-desktop\codex-automation'),
  [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$files = @('codex_oauth.py', 'install_playwright_chromium.py', 'install_turnstile_browser.py', 'turnstile_browser_bridge.js', 'pyproject.toml', 'package.json', 'package-lock.json', 'README.md', 'setup.ps1')
foreach ($name in $files) {
  if (!(Test-Path -LiteralPath (Join-Path $source $name) -PathType Leaf)) { throw "Missing source: $name" }
}
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
if ([IO.Path]::GetFullPath($source).TrimEnd('\') -ne [IO.Path]::GetFullPath($Destination).TrimEnd('\')) {
  foreach ($name in $files) { Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $Destination $name) -Force }
}
$venv = Join-Path $Destination '.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $venv)) {
  & $Python -m venv (Join-Path $Destination '.venv')
  if ($LASTEXITCODE -ne 0) { throw 'Python venv creation failed (Python 3.10+ is required)' }
}
Push-Location $Destination
try {
  & $venv -m pip install -e .
  if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed' }
  & $venv install_playwright_chromium.py
  if ($LASTEXITCODE -ne 0) { throw 'Chromium installation failed' }
  & $venv install_turnstile_browser.py
  if ($LASTEXITCODE -ne 0) { throw 'Node / browser bridge installation failed' }
  Write-Host "Automation ready: $Destination"
  Write-Host 'Keep account files outside this repository; select the file in Model configuration.'
} finally { Pop-Location }

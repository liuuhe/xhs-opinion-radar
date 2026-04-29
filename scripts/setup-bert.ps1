param(
  [string]$Python = "python",
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$bertDir = Join-Path $repoRoot "bert"
$venvDir = Join-Path $bertDir ".venv"
$pythonExe = Join-Path $venvDir "Scripts\python.exe"

if (-not (Test-Path -LiteralPath $pythonExe)) {
  Write-Host "Creating BERT virtual environment..."
  & $Python -m venv $venvDir
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create virtual environment with $Python"
  }
}

if ($SkipInstall) {
  Write-Host "BERT virtual environment is ready: $pythonExe"
  return
}

Write-Host "Installing BERT Python dependencies..."
& $pythonExe -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) {
  throw "Failed to upgrade pip"
}

& $pythonExe -m pip install -r (Join-Path $bertDir "requirements.txt")
if ($LASTEXITCODE -ne 0) {
  throw "Failed to install BERT dependencies"
}

Write-Host "BERT environment is ready: $pythonExe"

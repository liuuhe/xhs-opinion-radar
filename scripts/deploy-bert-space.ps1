param(
  [Parameter(Mandatory = $true)]
  [string]$SpaceRepo,

  [string]$ModelDir = "bert/models/xhs-bert-sentiment",
  [string]$PublishDir = ".deploy/bert-space",
  [string]$CommitMessage = "Deploy BERT sentiment service",
  [string]$SpaceUrl = "",

  [switch]$CreateSpace,
  [switch]$Private,
  [switch]$PrepareOnly,
  [switch]$UpdateWorkerSecret,
  [switch]$DeployWorker
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $repoRoot

function Resolve-InRepoPath([string]$PathValue) {
  $resolved = Resolve-Path $PathValue -ErrorAction Stop
  if (-not $resolved.Path.StartsWith($repoRoot.Path)) {
    throw "Path is outside the repository: $($resolved.Path)"
  }
  return $resolved.Path
}

function Ensure-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

function Copy-DirectoryContents([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
  }
}

Ensure-Command "hf"

$appPath = Resolve-InRepoPath "bert/app.py"
$requirementsPath = Resolve-InRepoPath "bert/requirements.txt"
$modelPath = Resolve-InRepoPath $ModelDir

$modelFiles = @("config.json", "tokenizer.json", "tokenizer_config.json")
foreach ($file in $modelFiles) {
  if (-not (Test-Path (Join-Path $modelPath $file))) {
    throw "Model directory is missing '$file': $modelPath"
  }
}

$hasWeights = (Test-Path (Join-Path $modelPath "model.safetensors")) -or (Test-Path (Join-Path $modelPath "pytorch_model.bin"))
if (-not $hasWeights) {
  throw "Model directory must contain model.safetensors or pytorch_model.bin: $modelPath"
}

$publishPath = Join-Path $repoRoot.Path $PublishDir
if (Test-Path $publishPath) {
  $resolvedPublish = Resolve-Path $publishPath
  if (-not $resolvedPublish.Path.StartsWith($repoRoot.Path)) {
    throw "Refusing to delete publish directory outside repository: $($resolvedPublish.Path)"
  }
  Remove-Item -LiteralPath $resolvedPublish.Path -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $publishPath | Out-Null
Copy-Item -LiteralPath $appPath -Destination (Join-Path $publishPath "app.py") -Force
Copy-Item -LiteralPath $requirementsPath -Destination (Join-Path $publishPath "requirements.txt") -Force
Copy-DirectoryContents $modelPath (Join-Path $publishPath "model")

$dockerfile = @"
FROM python:3.11-slim

WORKDIR /app
ENV MODEL_DIR=model
ENV PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY model ./model

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
"@
$dockerfile | Set-Content -Path (Join-Path $publishPath "Dockerfile") -Encoding UTF8

$spaceReadme = @"
---
title: Public Opinion BERT Sentiment
colorFrom: blue
colorTo: green
sdk: docker
pinned: false
---

FastAPI BERT sentiment service for the public opinion Worker.

- Health: /health
- Prediction: /predict
- Runtime model path: model/
"@
$spaceReadme | Set-Content -Path (Join-Path $publishPath "README.md") -Encoding UTF8

if ($CreateSpace -and -not $PrepareOnly) {
  $createArgs = @("repos", "create", $SpaceRepo, "--type", "space", "--space-sdk", "docker", "--env", "MODEL_DIR=model", "--exist-ok")
  if ($Private) {
    $createArgs += "--private"
  }
  & hf @createArgs
}

if (-not $PrepareOnly) {
  $uploadArgs = @(
    "upload",
    $SpaceRepo,
    $publishPath,
    ".",
    "--repo-type",
    "space",
    "--commit-message",
    $CommitMessage
  )
  & hf @uploadArgs
}

if ([string]::IsNullOrWhiteSpace($SpaceUrl)) {
  $SpaceUrl = "https://$($SpaceRepo.Replace("/", "-").ToLowerInvariant()).hf.space"
}
$predictUrl = "$($SpaceUrl.TrimEnd('/'))/predict"

if ($UpdateWorkerSecret -and -not $PrepareOnly) {
  Ensure-Command "npx"
  $predictUrl | & npx wrangler secret put BERT_INFERENCE_URL
}

if ($DeployWorker -and -not $PrepareOnly) {
  Ensure-Command "npm"
  & npm run deploy
}

Write-Host ""
Write-Host "BERT Space deployment prepared."
Write-Host "Space repo: $SpaceRepo"
Write-Host "Space URL:  $SpaceUrl"
Write-Host "Predict:    $predictUrl"
Write-Host "Publish dir: $publishPath"
if ($PrepareOnly) {
  Write-Host "PrepareOnly: upload and Worker deployment were skipped."
}

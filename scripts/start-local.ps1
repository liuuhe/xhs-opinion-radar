param(
  [string]$ModelDir = "bert\models\xhs-bert-sentiment-oldflow-v2-seed42-e5-b16-lr2e5",
  [int]$BertPort = 7860,
  [int]$WebPort = 8788,
  [string]$HostName = "127.0.0.1",
  [ValidateSet("torch", "onnx", "auto")]
  [string]$Runtime = "torch",
  [int]$BertTimeoutSeconds = 180,
  [switch]$SkipBuild,
  [switch]$SkipBert,
  [switch]$NoBrowser,
  [switch]$ExitAfterReady
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repoRoot ".local\logs"
$bertBaseUrl = "http://${HostName}:${BertPort}"
$webBaseUrl = "http://${HostName}:${WebPort}"
$startedProcesses = @()

function Quote-Argument([string]$value) {
  '"' + ($value -replace '"', '\"') + '"'
}

function Join-Arguments([string[]]$items) {
  ($items | ForEach-Object { Quote-Argument $_ }) -join " "
}

function Test-HttpOk([string]$Url, [int]$TimeoutSeconds = 2) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSeconds
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Wait-HttpOk([string]$Url, [int]$TimeoutSeconds, [string]$Name) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpOk $Url 2) {
      return
    }
    Start-Sleep -Seconds 2
  }
  throw "$Name did not become healthy within ${TimeoutSeconds}s: $Url"
}

function Start-HiddenProcess(
  [string]$Name,
  [string]$FilePath,
  [string[]]$Arguments,
  [string]$WorkingDirectory,
  [string]$StdoutPath,
  [string]$StderrPath
) {
  Write-Host "Starting $Name..."
  $process = Start-Process `
    -FilePath $FilePath `
    -ArgumentList (Join-Arguments $Arguments) `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -PassThru
  $script:startedProcesses += $process
  return $process
}

function Stop-ProcessTree([int]$ProcessId) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId ([int]$child.ProcessId)
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Stop-StartedProcesses {
  foreach ($process in $script:startedProcesses) {
    if ($null -ne $process -and -not $process.HasExited) {
      try {
        Stop-ProcessTree -ProcessId $process.Id
      } catch {
        Write-Warning "Failed to stop process $($process.Id): $($_.Exception.Message)"
      }
    }
  }
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

try {
  Set-Location $repoRoot

  if (-not $SkipBuild) {
    Write-Host "Building local WebUI..."
    & npm.cmd run build:local
    if ($LASTEXITCODE -ne 0) {
      throw "npm run build:local failed with exit code $LASTEXITCODE"
    }
  }

  $bertHealthUrl = "$bertBaseUrl/health"
  if ($SkipBert) {
    Write-Host "Skipping BERT startup. Expecting existing BERT API at $bertBaseUrl"
  } elseif (Test-HttpOk $bertHealthUrl 2) {
    Write-Host "BERT is already running: $bertBaseUrl"
  } else {
    $bertDir = Join-Path $repoRoot "bert"
    $python = Join-Path $bertDir ".venv\Scripts\python.exe"
    if (-not (Test-Path $python)) {
      throw "Missing BERT virtualenv python: $python"
    }
    $resolvedModel = Resolve-Path -LiteralPath (Join-Path $repoRoot $ModelDir)
    $env:MODEL_DIR = $resolvedModel.Path
    $env:BERT_RUNTIME = $Runtime
    $bertArgs = @(
      "-m", "uvicorn", "app:app",
      "--host", $HostName,
      "--port", [string]$BertPort
    )
    Start-HiddenProcess `
      -Name "BERT" `
      -FilePath $python `
      -Arguments $bertArgs `
      -WorkingDirectory $bertDir `
      -StdoutPath (Join-Path $logDir "bert.stdout.log") `
      -StderrPath (Join-Path $logDir "bert.stderr.log") | Out-Null
    Wait-HttpOk $bertHealthUrl $BertTimeoutSeconds "BERT"
    Write-Host "BERT is ready: $bertBaseUrl"
  }

  $webHealthUrl = "$webBaseUrl/api/health"
  if (Test-HttpOk $webHealthUrl 2) {
    Write-Host "Local WebUI is already running: $webBaseUrl"
  } else {
    $webScript = Join-Path $repoRoot "scripts\local-webui.mjs"
    $env:LOCAL_WEBUI_HOST = $HostName
    $env:LOCAL_WEBUI_PORT = [string]$WebPort
    $env:BERT_INFERENCE_URL = $bertBaseUrl
    Start-HiddenProcess `
      -Name "Local WebUI" `
      -FilePath "node" `
      -Arguments @($webScript) `
      -WorkingDirectory $repoRoot `
      -StdoutPath (Join-Path $logDir "webui.stdout.log") `
      -StderrPath (Join-Path $logDir "webui.stderr.log") | Out-Null
    Wait-HttpOk $webHealthUrl 60 "Local WebUI"
    Write-Host "Local WebUI is ready: $webBaseUrl"
  }

  if (-not $NoBrowser) {
    Start-Process $webBaseUrl
  }

  Write-Host ""
  Write-Host "Local stack is running."
  Write-Host "WebUI: $webBaseUrl"
  Write-Host "BERT:  $bertBaseUrl"
  Write-Host "Logs:  $logDir"
  if ($ExitAfterReady) {
    Write-Host "ExitAfterReady is set; stopping processes started by this command."
    return
  }

  Write-Host "Press Ctrl+C to stop processes started by this command."

  while ($true) {
    Start-Sleep -Seconds 3
    foreach ($process in $startedProcesses) {
      if ($null -ne $process -and $process.HasExited) {
        throw "A local process exited early. Check logs in $logDir"
      }
    }
  }
} finally {
  Stop-StartedProcesses
}

param(
  [int]$BertPort = 7860,
  [int]$WebPort = 8788,
  [switch]$RemoveLogs
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Join-Path $repoRoot ".local"
$runDir = Join-Path $localRoot "run"
$logDir = Join-Path $localRoot "logs"
$targetPorts = @($BertPort, $WebPort)

function Stop-ProcessTree([int]$ProcessId) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId ([int]$child.ProcessId)
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Remove-RunArtifacts {
  if (Test-Path -LiteralPath $runDir) {
    Remove-Item -LiteralPath (Join-Path $runDir "*.pid.json") -Force -ErrorAction SilentlyContinue
  }
  if ($RemoveLogs -and (Test-Path -LiteralPath $logDir)) {
    Remove-Item -LiteralPath $logDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Get-TrackedProcessIds {
  if (-not (Test-Path -LiteralPath $runDir)) {
    return @()
  }
  $ids = @()
  foreach ($pidFile in Get-ChildItem -LiteralPath $runDir -Filter *.pid.json -File -ErrorAction SilentlyContinue) {
    try {
      $payload = Get-Content -LiteralPath $pidFile.FullName -Raw | ConvertFrom-Json
      if ($payload.pid) {
        $ids += [int]$payload.pid
      }
    } catch {
      Remove-Item -LiteralPath $pidFile.FullName -Force -ErrorAction SilentlyContinue
    }
  }
  return $ids | Sort-Object -Unique
}

function Is-ProjectOwnedPortProcess([int]$ProcessId, [int]$Port) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return $false
  }
  $commandLine = [string]$process.CommandLine
  $escapedRoot = [Regex]::Escape($repoRoot)
  if ($commandLine -match $escapedRoot) {
    return $true
  }
  if ($Port -eq $WebPort -and $commandLine -match 'local-webui\.mjs') {
    return $true
  }
  if ($Port -eq $BertPort -and $commandLine -match 'uvicorn\s+app:app') {
    return $true
  }
  return $false
}

function Get-OwnedPortProcessIds {
  $ids = @()
  $listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $targetPorts }
  foreach ($listener in $listeners) {
    $pid = [int]$listener.OwningProcess
    if (Is-ProjectOwnedPortProcess -ProcessId $pid -Port ([int]$listener.LocalPort)) {
      $ids += $pid
    }
  }
  return $ids | Sort-Object -Unique
}

$trackedIds = Get-TrackedProcessIds
$ownedPortIds = Get-OwnedPortProcessIds
$allIds = @($trackedIds + $ownedPortIds) | Where-Object { $_ } | Sort-Object -Unique

if (-not $allIds.Count) {
  Write-Host "No tracked local WebUI/BERT processes found."
  Remove-RunArtifacts
  exit 0
}

Write-Host "Stopping local processes: $($allIds -join ', ')"
  foreach ($processId in $allIds) {
  try {
    Stop-ProcessTree -ProcessId $processId
  } catch {
    Write-Warning ("Failed to stop process {0}: {1}" -f $processId, $_.Exception.Message)
  }
}

Start-Sleep -Milliseconds 800
Remove-RunArtifacts

$remaining = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $targetPorts } | Select-Object LocalAddress,LocalPort,OwningProcess
if ($remaining) {
  Write-Warning "Some target ports are still listening."
  $remaining | Format-Table -AutoSize
  exit 1
}

Write-Host "Local WebUI/BERT processes stopped."

param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CrawlerArgs
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$crawlerDir = Join-Path $repoRoot "vendor\mediacrawler-xhs"

if (-not (Test-Path (Join-Path $crawlerDir "main.py"))) {
  throw "Missing vendored MediaCrawler entry: $crawlerDir"
}

Set-Location $crawlerDir

$defaultArgs = @(
  "--platform", "xhs",
  "--lt", "qrcode",
  "--type", "search",
  "--save_data_option", "jsonl",
  "--max_concurrency_num", "1",
  "--get_comment", "true",
  "--get_sub_comment", "false",
  "--save_data_path", "..\..\data\mediacrawler"
)

if (Get-Command uv -ErrorAction SilentlyContinue) {
  & uv run main.py @defaultArgs @CrawlerArgs
} else {
  & python main.py @defaultArgs @CrawlerArgs
}

# Local Runtime

This project can run fully locally:

- Web UI: local Vite build served by a Node API server.
- Analysis API: local Node server compatible with `/api/analyze/captured`.
- BERT: local FastAPI service from `bert/app.py`.
- Collection: vendored MediaCrawler Xiaohongshu subset under `vendor/mediacrawler-xhs`.

Cloudflare remains a deployment option, but it is not required for development, dataset work, or demos.

## Start Local BERT

From the repository root:

```powershell
npm run local
```

This one command builds the local WebUI, starts the local BERT service, starts
the local WebUI API server, opens `http://127.0.0.1:8788`, and keeps both child
processes alive until Ctrl+C. Logs are written to `.local\logs`.

Common options:

```powershell
npm run local -- -Runtime torch -BertPort 7860 -WebPort 8788
npm run local -- -SkipBuild
npm run local -- -SkipBert
npm run local -- -NoBrowser
npm run local -- -ExitAfterReady
```

To run each service manually instead, start BERT first:

```powershell
npm run local:bert
```

By default this uses:

```text
bert\models\xhs-bert-sentiment-oldflow-v2-seed42-e5-b16-lr2e5
```

The local script defaults to `BERT_RUNTIME=torch`, so a CUDA-enabled PyTorch install can use the local GPU. Cloudflare deployment can still use ONNX.

To choose another model:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-local-bert.ps1 `
  -ModelDir "bert\models\xhs-bert-sentiment-v3-llm" `
  -Runtime torch `
  -Port 7860
```

To force ONNX locally:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-local-bert.ps1 -Runtime onnx
```

Health check:

```powershell
Invoke-WebRequest http://127.0.0.1:7860/health -UseBasicParsing
```

## Start Local WebUI

Then start the WebUI in another terminal:

```powershell
npm run local:webui
```

Open:

```text
http://127.0.0.1:8788
```

When opened from localhost, the frontend automatically uses the local API origin instead of `https://opinion.liuhe.me`.

Optional environment variables:

```powershell
$env:LOCAL_WEBUI_PORT = "8788"
$env:BERT_INFERENCE_URL = "http://127.0.0.1:7860"
$env:OPENAI_API_KEY = "..."
$env:OPENAI_BASE_URL = "https://api.openai.com/v1"
$env:OPENAI_MODEL = "gpt-4o-mini"
npm run local:webui
```

## Run Vendored MediaCrawler

The vendored crawler is stored at:

```text
vendor\mediacrawler-xhs
```

It keeps the Xiaohongshu path from MediaCrawler and removes other platform crawler modules.

Run keyword collection:

```powershell
npm run mediacrawler:xhs -- --keywords "酒店 避雷" --max_comments_count_singlenotes 80
```

Default output path:

```text
data\mediacrawler\xhs\jsonl
```

Convert crawler output to capture JSON:

```powershell
npm run mediacrawler:to-capture -- `
  --input-dir "data\mediacrawler\xhs\jsonl" `
  --keyword "酒店 避雷" `
  --output "data\captures\xhs-mediacrawler-酒店-避雷.json"
```

Then upload the capture JSON in the local WebUI or send it to `/api/analyze/captured`.

## Notes

- MediaCrawler is governed by its own non-commercial learning license. See `vendor\mediacrawler-xhs\LICENSE`.
- Keep crawler concurrency low. The default wrapper uses `--max_concurrency_num 1`.
- If Xiaohongshu asks for verification, complete it in the real browser session before continuing.

# Project Agent Context

Active project directory:

```text
C:\Users\xlyytcy\codespace\public_opinion
```

## Current Product Flow

- The app is a fully local Xiaohongshu opinion-analysis workbench.
- The local WebUI starts vendored MediaCrawler for Xiaohongshu collection.
- MediaCrawler output is converted to capture JSON under `data/captures/`.
- The WebUI analyzes capture JSON through local BERT or local LLM configuration.
- Reports can be exported as JSON, Markdown, CSV, or printed PDF.

## Important Paths

- Web app source: `src/`
- Local WebUI/API server: `scripts/local-webui.mjs`
- One-command local launcher: `scripts/start-local.ps1`
- BERT training/inference source: `bert/`
- MediaCrawler Xiaohongshu subset: `vendor/mediacrawler-xhs/`
- MediaCrawler adapter: `scripts/mediacrawler-to-capture.mjs`

## Useful Commands

```powershell
npm run local
npm run check
npm run build
npm run mediacrawler:xhs -- --keywords "酒店 避雷" --max_notes_count 10 --max_comments_count_singlenotes 80
npm run mediacrawler:to-capture -- --input-dir "data\mediacrawler\xhs\jsonl" --keyword "酒店 避雷"
```

## BERT Accuracy Status

Current best local baseline:

- Test accuracy: 0.8542
- Test macro F1: 0.8295
- Negative F1: 0.7727
- Neutral F1: 0.8946
- Positive F1: 0.8212

Most remaining errors are negative comments predicted as neutral. The preferred
next step is data correction and better sample coverage, not blind
hyperparameter tuning.

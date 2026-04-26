# Project Status

Last consolidated: 2026-04-23.

## Active Folder

Use only this folder for ongoing work:

```text
C:\Users\xlyytcy\codespace\public_opinion
```

The sibling backup directory is archival. It can be kept for reference, but it should not receive new feature work.

## Product Direction

Actual product use should prioritize the browser extension. It reuses the user's normal logged-in browser session, keeps interaction simple, and can send captured data directly to the Worker or export capture JSON for the web app.

Dataset expansion should now use MediaCrawler as the external collector. This project keeps the analysis, report, dataset, training, and deployment pipeline, and converts MediaCrawler outputs into the existing capture JSON shape.

## Completed Work

- Browser extension capture prioritizes Xiaohongshu result links with `xsec_token`.
- Extension capture is sequential with random delay controls because concurrent capture triggered platform risk controls too easily.
- Extension supports pause/cancel, export JSON, and send-to-Worker analysis.
- Web app imports capture JSON and analysis JSON, renders reports, and exports JSON, Markdown, CSV, and print-to-PDF.
- MediaCrawler output can be converted through `npm run mediacrawler:to-capture` into capture JSON compatible with the web app and `/api/analyze/captured`.
- The old Playwright collector remains available through `npm run collect:xhs`, but it is now a fallback rather than the preferred dataset collection path.
- Dataset scripts convert captures to review CSV, run LLM pre-labeling, and merge valid labels into a new training CSV.
- BERT inference is deployed through Cloudflare Containers and uses ONNX Runtime when `model.onnx` is present.
- Custom domain is in use: `https://opinion.liuhe.me`.

## Current Deployment

Production:

```text
https://opinion.liuhe.me
```

Expected health state:

- Worker health: BERT provider `cloudflare-container`.
- BERT health: runtime `onnxruntime`, ONNX model file present.
- The Cloudflare container can take time to wake up on the first request; the UI should keep showing request progress.

## Current BERT Baseline

Current deployed best model:

```text
bert/models/xhs-bert-sentiment-oldflow-v2-seed42-e5-b16-lr2e5
```

Held-out test metrics:

| Metric | Value |
| --- | ---: |
| Test accuracy | 0.8542 |
| Test macro F1 | 0.8295 |
| Negative F1 | 0.7727 |
| Neutral F1 | 0.8946 |
| Positive F1 | 0.8212 |

This is good enough for current product demonstration and real analysis. Further model work should be gated by frozen test performance, not by training loss or validation-only gains.

## Recent Dataset Experiment

LLM pre-labeling was added for newly collected captures:

- `new_samples.review.csv`: 237 extracted comments.
- `new_samples.llm.csv`: 237 LLM-labeled comments.
- `train.corrected.v3.csv`: 2936 merged training rows.

The resulting v3 LLM-labeled training run did not beat the deployed baseline:

| Model | Test accuracy | Test macro F1 |
| --- | ---: | ---: |
| Current deployed baseline | 0.8542 | 0.8295 |
| v3 LLM-labeled experiment | 0.8036 | 0.7649 |

Conclusion: do not deploy v3. LLM labels are useful as pre-label candidates, but they should not be treated as final truth without review.

## Model Improvement Gate

Only deploy a new BERT model when all are true:

1. Validation and frozen test CSVs remain unchanged.
2. The new model beats `test_macro_f1 = 0.8295` on the frozen test set.
3. Negative-class performance does not regress in a way that hurts practical analysis.
4. ONNX export and `/api/bert/health` pass before production rollout.

Recommended improvement loop:

```powershell
npm run dataset:from-captures -- --input "data/captures/xhs-*.json" --output "bert/data/archive-wsl/exports/new_samples.review.csv"
npm run dataset:label-llm -- --input "bert/data/archive-wsl/exports/new_samples.review.csv" --output "bert/data/archive-wsl/exports/new_samples.llm.csv" --worker-url "https://opinion.liuhe.me"
npm run dataset:merge -- --base "bert/data/archive-wsl/exports/train.corrected.v2.csv" --new "bert/data/archive-wsl/exports/new_samples.llm.csv" --output "bert/data/archive-wsl/exports/train.corrected.v3.csv"
```

Then train with GPU and compare frozen test metrics before considering deployment.

## Backup Merge Decision

The backup directory contains older uncommitted changes for a previous Python pipeline. Those changes are not being copied into the main app because the active project already has the complete BERT flow:

- `bert/train.py`
- `bert/evaluate.py`
- `bert/apply_manual_review.py`
- `bert/export_onnx.py`
- Cloudflare container deployment
- GitHub Actions deployment

The useful context from the backup has been consolidated here and in `AGENTS.md`.

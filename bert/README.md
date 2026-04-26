# Local BERT

This directory contains the local BERT sentiment model training and inference
pipeline used by the WebUI.

## Start Inference

From the repository root:

```powershell
npm run local:bert
```

Default model:

```text
bert\models\xhs-bert-sentiment-oldflow-v2-seed42-e5-b16-lr2e5
```

The launcher defaults to `BERT_RUNTIME=torch`, so a CUDA-enabled PyTorch
environment can use the local GPU.

Health check:

```powershell
Invoke-WebRequest http://127.0.0.1:7860/health -UseBasicParsing
```

## Train

```powershell
cd bert
.\.venv\Scripts\python.exe train.py `
  --data data/archive-wsl/exports/train.corrected.v3.csv `
  --eval-data data/archive-wsl/exports/val.corrected.v2.csv `
  --test-data data/archive-wsl/exports/test.corrected.v2.csv `
  --output models/xhs-bert-sentiment-v3 `
  --epochs 5 `
  --batch-size 16 `
  --eval-batch-size 32 `
  --learning-rate 2e-5 `
  --warmup-ratio 0.1 `
  --max-length 256 `
  --seed 42 `
  --class-weights none
```

## Current Baseline

| Metric | Value |
| --- | ---: |
| Test macro F1 | 0.8295 |
| Test accuracy | 0.8542 |
| Negative F1 | 0.7727 |
| Neutral F1 | 0.8946 |
| Positive F1 | 0.8212 |

Only replace the default local model when a new run beats this frozen-test
baseline.

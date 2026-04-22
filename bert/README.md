# BERT Sentiment Service

Lightweight Chinese BERT sentiment training and inference for the public
opinion pipeline. The Cloudflare Worker calls this service when the UI selects
`BERT`.

## Data Format

Training data is JSONL:

```json
{"text":"这家拿铁真的很顺滑，服务也很耐心。","label":"positive"}
{"text":"门店太吵了，坐着办公不太合适。","label":"negative"}
{"text":"价格略高，不过味道确实稳定。","label":"neutral"}
```

Labels must be `positive`, `neutral`, or `negative`.

## Train Locally

```bash
cd bert
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python train.py --data data/seed.jsonl --output models/xhs-bert-sentiment --epochs 8
```

The seed data is intentionally small. Add exported plugin comments and labels to
improve the model before relying on BERT mode. Local model outputs under
`models/` are ignored by git and should be uploaded separately to the inference
runtime.

The archived dataset is stored locally under `data/archive-wsl/`. Train with its
existing split:

```bash
python train.py ^
  --data data/archive-wsl/exports/train.csv ^
  --eval-data data/archive-wsl/exports/val.csv ^
  --test-data data/archive-wsl/exports/test.csv ^
  --model hfl/chinese-bert-wwm-ext ^
  --output models/xhs-bert-sentiment ^
  --epochs 3
```

The archived model copied from that dataset was trained on 2701 rows, validated
on 338 rows, and tested on 336 rows. Its held-out test metrics were
`accuracy=0.7738` and `macro_f1=0.7269`.

## Run Inference Locally

```bash
set MODEL_DIR=models/xhs-bert-sentiment
uvicorn app:app --host 0.0.0.0 --port 7860
```

Test request:

```bash
curl -X POST http://127.0.0.1:7860/predict ^
  -H "Content-Type: application/json" ^
  -d "{\"samples\":[{\"sample_id\":\"s1\",\"text\":\"服务很耐心，下次还会去。\"}]}"
```

## Deploy To Hugging Face Space

Automated deployment uses the local `hf` CLI and `git-lfs`/Hub upload support.
Login once before deploying:

```bash
hf auth login
```

Create or update a Docker Space and upload the current local model:

```powershell
npm run deploy:bert -- `
  -SpaceRepo "your-hf-user/public-opinion-bert" `
  -CreateSpace
```

Also update the Cloudflare Worker secret and deploy the Worker:

```powershell
npm run deploy:bert -- `
  -SpaceRepo "your-hf-user/public-opinion-bert" `
  -CreateSpace `
  -UpdateWorkerSecret `
  -DeployWorker
```

If the inferred Space URL is wrong, pass it explicitly:

```powershell
npm run deploy:bert -- `
  -SpaceRepo "your-hf-user/public-opinion-bert" `
  -SpaceUrl "https://your-hf-user-public-opinion-bert.hf.space" `
  -UpdateWorkerSecret
```

The inference API is compatible with the current Worker:

- Request: `{ "samples": [{ "sample_id": "...", "text": "..." }] }`
- Response: `{ "labels": [{ "sample_id": "...", "label": "...", "confidence": 0.0, "reason_short": "bert" }] }`

Low-confidence BERT results may return `reason_short: "bert+rules"` after a
small Chinese sentiment lexicon fallback is applied.

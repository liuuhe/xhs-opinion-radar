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

## Improve Accuracy

The current dataset is model-labeled and imbalanced. Most remaining errors are
negative comments predicted as neutral, especially short sarcasm or platform
slang. The most reliable improvement loop is:

1. Evaluate the current model and export high-confidence mistakes.
2. Manually fill `manual_label` for the exported CSV rows.
3. Apply those corrections to the training data.
4. Retrain, compare `test_macro_f1`, then export ONNX and redeploy only if the
   held-out test metrics improve.

Evaluate and create a review CSV:

```powershell
cd bert
python evaluate.py `
  --model-dir models/xhs-bert-sentiment `
  --data data/archive-wsl/exports/test.csv `
  --output-dir models/xhs-bert-sentiment/evaluation-test `
  --review-limit 120
```

Open `models/xhs-bert-sentiment/evaluation-test/misclassified_review.csv`,
fill `manual_label` with `positive`, `neutral`, or `negative`, then apply it:

```powershell
python apply_manual_review.py `
  --input data/archive-wsl/exports/train.csv `
  --review models/xhs-bert-sentiment/evaluation-test/misclassified_review.csv `
  --output data/archive-wsl/exports/train.corrected.csv
```

Retrain with macro-F1 model selection:

```powershell
python train.py `
  --data data/archive-wsl/exports/train.corrected.csv `
  --eval-data data/archive-wsl/exports/val.csv `
  --test-data data/archive-wsl/exports/test.csv `
  --model hfl/chinese-bert-wwm-ext `
  --output models/xhs-bert-sentiment-next `
  --epochs 3 `
  --batch-size 16 `
  --learning-rate 2e-5 `
  --class-weights none
```

Use class weights only as an experiment. On the current data, a first weighted
run underperformed the existing model after one epoch, so the default
recommendation is data correction first.

## Export ONNX

The inference service prefers `model.onnx` when it exists in the model
directory. If `model.onnx` is missing, it falls back to the PyTorch weights.

Export and verify ONNX after training:

```powershell
cd bert
python export_onnx.py `
  --model-dir models/xhs-bert-sentiment `
  --verify
```

Expected output:

```text
ONNX verification max_abs_diff=...
ONNX model exported: models/xhs-bert-sentiment/model.onnx
```

Then package and redeploy the model as usual:

```powershell
npm run package:bert:model
gh release upload bert-model .deploy/xhs-bert-sentiment.zip --clobber
```

When `model.onnx` exists, the package script creates an ONNX-only model zip and
does not duplicate `model.safetensors` / `pytorch_model.bin`.

Run the `Deploy Cloudflare Containers` GitHub Actions workflow. After deploy,
`/api/bert/health` should report:

```json
{"runtime":"onnxruntime"}
```

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

## Deploy To Cloudflare Containers

Cloudflare Containers keeps the Worker, web UI, and BERT model on Cloudflare.
It requires Docker locally because Wrangler builds and pushes the container
image during deployment.

The current container image is defined by `bert/Dockerfile` and copies:

- `bert/app.py`
- `bert/requirements-container.txt`
- `bert/models/xhs-bert-sentiment/`

Deploy the Worker plus BERT container:

```powershell
npm run deploy:bert:cf
```

After deployment, check:

```text
https://opinion.liuhe.me/api/health
https://opinion.liuhe.me/api/bert/health
```

The Worker prefers the Cloudflare container when `BERT_CONTAINER` is bound. If
the container call fails and `BERT_INFERENCE_URL` is still configured, it falls
back to the external inference URL.

### GitHub Actions Deployment

If Docker is not installed locally, use the GitHub Actions workflow instead.
The workflow downloads the model from a GitHub Release asset, builds the Docker
image on GitHub's runner, and deploys the Worker plus container to Cloudflare.

One-time model packaging from this machine:

```powershell
npm run package:bert:model
```

Upload `.deploy/xhs-bert-sentiment.zip` to a GitHub Release tagged `bert-model`.
You can use the GitHub web UI, or the GitHub CLI:

```powershell
gh release create bert-model .deploy/xhs-bert-sentiment.zip `
  --title "BERT model" `
  --notes "BERT model for Cloudflare Containers"
```

If the release already exists:

```powershell
gh release upload bert-model .deploy/xhs-bert-sentiment.zip --clobber
```

Add these GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`: API token with permission to deploy this Worker.
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account id.

Then run the `Deploy Cloudflare Containers` workflow from GitHub Actions. The
default inputs expect:

- release tag: `bert-model`
- asset name: `xhs-bert-sentiment.zip`

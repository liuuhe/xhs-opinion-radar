# BERT Data Inventory

Local archived data lives under `bert/data/archive-wsl/`. The directory is
ignored by git because it contains runtime training data, but it should be kept
with the project workspace for reproducible local training.

## Files

- `exports/train.csv`: 2701 labeled rows for training.
- `exports/val.csv`: 338 labeled rows for validation.
- `exports/test.csv`: 336 labeled rows for held-out testing.
- `exports/manual_review_sample.csv`: small sample for manual review.
- `exports/validation_report.json`: validation metadata from the previous run.
- `labeled/labeled_comments.jsonl`: 3375 labeled comments with model labeling metadata.
- `clean/clean_comments.jsonl`: 3375 cleaned comments without labels.
- `raw/raw_comments.jsonl`: original raw comments.
- `raw/raw_posts.jsonl`: original raw post records.

## Current Model

The current local model is stored at:

```text
bert/models/xhs-bert-sentiment/
```

It was copied from the archived `bert_finetune` model and stripped of old
checkpoint directories. The recorded held-out test metrics are:

- `accuracy=0.7738`
- `macro_f1=0.7269`

Use this directory as the default local inference model unless a newer run
beats the frozen test baseline.

import argparse
import csv
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, precision_recall_fscore_support
from torch.utils.data import Dataset
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    EarlyStoppingCallback,
    Trainer,
    TrainingArguments,
)

LABEL_TO_ID = {"negative": 0, "neutral": 1, "positive": 2}
ID_TO_LABEL = {value: key for key, value in LABEL_TO_ID.items()}


@dataclass
class Row:
    text: str
    label: str


class SentimentDataset(Dataset):
    def __init__(self, rows: list[Row], tokenizer, max_length: int) -> None:
        self.rows = rows
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        row = self.rows[index]
        encoded = self.tokenizer(
            row.text,
            truncation=True,
            padding="max_length",
            max_length=self.max_length,
            return_tensors="pt",
        )
        item = {key: value.squeeze(0) for key, value in encoded.items()}
        item["labels"] = torch.tensor(LABEL_TO_ID[row.label], dtype=torch.long)
        return item


class WeightedTrainer(Trainer):
    def __init__(self, *args, class_weights: torch.Tensor | None = None, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.class_weights = class_weights

    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        labels = inputs.pop("labels")
        outputs = model(**inputs)
        logits = outputs.logits
        weights = self.class_weights.to(logits.device) if self.class_weights is not None else None
        loss = torch.nn.functional.cross_entropy(logits, labels, weight=weights)
        return (loss, outputs) if return_outputs else loss


def main() -> None:
    parser = argparse.ArgumentParser(description="Fine-tune Chinese BERT for Xiaohongshu sentiment labels.")
    parser.add_argument("--data", default="data/seed.jsonl", help="JSONL or CSV file with text,label columns.")
    parser.add_argument("--eval-data", help="Optional JSONL or CSV validation file.")
    parser.add_argument("--test-data", help="Optional JSONL or CSV held-out test file.")
    parser.add_argument("--model", default="google-bert/bert-base-chinese", help="Base Hugging Face model.")
    parser.add_argument("--output", default="models/xhs-bert-sentiment", help="Output model directory.")
    parser.add_argument("--epochs", type=float, default=3)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--eval-batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--class-weights", choices=["none", "balanced"], default="none")
    parser.add_argument("--warmup-ratio", type=float, default=0.06)
    parser.add_argument("--early-stopping-patience", type=int, default=2)
    parser.add_argument("--metric-for-best-model", default="eval_macro_f1")
    args = parser.parse_args()

    rows = load_rows(Path(args.data))
    if len(rows) < 9:
        raise SystemExit("Need at least 9 labeled rows so each label can appear in train/eval data.")

    if args.eval_data:
        train_rows = rows
        eval_rows = load_rows(Path(args.eval_data))
    else:
        train_rows, eval_rows = stratified_split(rows, seed=args.seed)

    disable_hf_auto_conversion()
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model,
        num_labels=3,
        id2label=ID_TO_LABEL,
        label2id=LABEL_TO_ID,
        use_safetensors=False,
    )

    metric_for_best_model = normalize_eval_metric_name(args.metric_for_best_model)

    training_args = TrainingArguments(
        output_dir=args.output,
        eval_strategy="epoch",
        learning_rate=args.learning_rate,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.eval_batch_size,
        num_train_epochs=args.epochs,
        weight_decay=0.01,
        logging_steps=10,
        report_to=[],
        seed=args.seed,
        warmup_ratio=args.warmup_ratio,
        load_best_model_at_end=True,
        metric_for_best_model=metric_for_best_model,
        greater_is_better=True,
        save_strategy="epoch",
        save_total_limit=2,
    )

    class_weights = compute_class_weights(train_rows) if args.class_weights == "balanced" else None
    callbacks = []
    if args.early_stopping_patience > 0:
        callbacks.append(EarlyStoppingCallback(early_stopping_patience=args.early_stopping_patience))

    trainer = WeightedTrainer(
        model=model,
        args=training_args,
        train_dataset=SentimentDataset(train_rows, tokenizer, args.max_length),
        eval_dataset=SentimentDataset(eval_rows, tokenizer, args.max_length),
        compute_metrics=compute_metrics,
        class_weights=class_weights,
        callbacks=callbacks,
    )

    train_result = trainer.train()
    eval_metrics = trainer.evaluate()
    print("eval_metrics", eval_metrics)
    if callbacks:
        trainer.remove_callback(EarlyStoppingCallback)

    test_metrics = None
    test_rows = None
    if args.test_data:
        test_rows = load_rows(Path(args.test_data))
        test_metrics = trainer.evaluate(SentimentDataset(test_rows, tokenizer, args.max_length), metric_key_prefix="test")
        print("test_metrics", test_metrics)

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    trainer.save_model(output_dir)
    tokenizer.save_pretrained(args.output)
    write_label_map(output_dir)
    remove_stale_exports(output_dir)
    write_confusion_matrices(
        output_dir=output_dir,
        trainer=trainer,
        tokenizer=tokenizer,
        eval_rows=eval_rows,
        test_rows=test_rows,
        max_length=args.max_length,
    )
    write_metrics(
        output_dir=output_dir,
        model_name=args.model,
        train_rows=train_rows,
        eval_rows=eval_rows,
        test_rows=test_rows,
        train_metrics=train_result.metrics,
        eval_metrics=eval_metrics,
        test_metrics=test_metrics,
    )


def load_rows(path: Path) -> list[Row]:
    if path.suffix.lower() == ".csv":
        with path.open("r", encoding="utf-8-sig", newline="") as file:
            return normalize_rows(csv.DictReader(file))

    rows = []
    with path.open("r", encoding="utf-8") as file:
        for line in file:
            if not line.strip():
                continue
            rows.append(json.loads(line))
    return normalize_rows(rows)


def normalize_rows(items) -> list[Row]:
    rows = []
    for item in items:
        text = str(item.get("text") or item.get("text_norm") or "").strip()
        manual_label = str(item.get("manual_label", "")).strip()
        label = manual_label if manual_label in LABEL_TO_ID else str(item.get("label", "")).strip()
        if text and label in LABEL_TO_ID:
            rows.append(Row(text=text[:300], label=label))
    return rows


def normalize_eval_metric_name(metric_name: str) -> str:
    metric_name = metric_name.strip()
    if not metric_name:
        return "eval_macro_f1"
    return metric_name if metric_name.startswith("eval_") else f"eval_{metric_name}"


def disable_hf_auto_conversion() -> None:
    try:
        import transformers.modeling_utils as modeling_utils
        import transformers.safetensors_conversion as safetensors_conversion
    except Exception:
        return

    def skip_auto_conversion(*args, **kwargs):
        return None, kwargs.get("revision"), False

    modeling_utils.auto_conversion = skip_auto_conversion
    safetensors_conversion.auto_conversion = skip_auto_conversion


def stratified_split(rows: list[Row], seed: int, eval_ratio: float = 0.18) -> tuple[list[Row], list[Row]]:
    grouped: dict[str, list[Row]] = {label: [] for label in LABEL_TO_ID}
    for row in rows:
        grouped[row.label].append(row)

    rng = np.random.default_rng(seed)
    train_rows: list[Row] = []
    eval_rows: list[Row] = []
    for label, label_rows in grouped.items():
        if len(label_rows) < 2:
            raise SystemExit(f"Need at least 2 rows for label {label!r}.")

        shuffled = list(label_rows)
        rng.shuffle(shuffled)
        eval_count = max(1, int(round(len(shuffled) * eval_ratio)))
        eval_rows.extend(shuffled[:eval_count])
        train_rows.extend(shuffled[eval_count:])

    rng.shuffle(train_rows)
    rng.shuffle(eval_rows)
    return train_rows, eval_rows


def compute_metrics(eval_prediction) -> dict[str, float]:
    logits, labels = eval_prediction
    predictions = np.argmax(logits, axis=-1)
    precision, recall, macro_f1, _ = precision_recall_fscore_support(
        labels,
        predictions,
        average="macro",
        zero_division=0,
    )
    _, _, per_label_f1, _ = precision_recall_fscore_support(
        labels,
        predictions,
        labels=[LABEL_TO_ID[label] for label in LABEL_TO_ID],
        average=None,
        zero_division=0,
    )
    return {
        "accuracy": accuracy_score(labels, predictions),
        "macro_precision": precision,
        "macro_recall": recall,
        "macro_f1": macro_f1,
        "weighted_f1": f1_score(labels, predictions, average="weighted"),
        **{f"{label}_f1": float(per_label_f1[index]) for index, label in enumerate(LABEL_TO_ID)},
    }


def write_label_map(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / "label_map.json").open("w", encoding="utf-8") as file:
        json.dump({"label2id": LABEL_TO_ID, "id2label": ID_TO_LABEL}, file, ensure_ascii=False, indent=2)


def compute_class_weights(rows: list[Row]) -> torch.Tensor:
    counts = np.array([sum(1 for row in rows if row.label == label) for label in LABEL_TO_ID], dtype=np.float32)
    weights = counts.sum() / (len(LABEL_TO_ID) * np.maximum(counts, 1.0))
    return torch.tensor(weights, dtype=torch.float32)


def remove_stale_exports(output_dir: Path) -> None:
    for filename in ("model.onnx", "model.onnx.data", "model-int8.onnx"):
        path = output_dir / filename
        if path.exists():
            path.unlink()


def write_metrics(
    output_dir: Path,
    model_name: str,
    train_rows: list[Row],
    eval_rows: list[Row],
    test_rows: list[Row] | None,
    train_metrics: dict[str, float],
    eval_metrics: dict[str, float],
    test_metrics: dict[str, float] | None,
) -> None:
    payload = {
        "model_name": model_name,
        "train_samples": len(train_rows),
        "val_samples": len(eval_rows),
        "test_samples": len(test_rows or []),
        "label_distribution": {
            split_name: label_distribution(rows)
            for split_name, rows in {
                "train": train_rows,
                "val": eval_rows,
                "test": test_rows or [],
            }.items()
        },
        "train_metrics": train_metrics,
        "val_metrics": eval_metrics,
        "test_metrics": test_metrics,
    }
    with (output_dir / "metrics.json").open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)


def label_distribution(rows: list[Row]) -> dict[str, int]:
    return {label: sum(1 for row in rows if row.label == label) for label in LABEL_TO_ID}


def write_confusion_matrices(
    output_dir: Path,
    trainer: Trainer,
    tokenizer,
    eval_rows: list[Row],
    test_rows: list[Row] | None,
    max_length: int,
) -> None:
    payload = {"labels": list(LABEL_TO_ID)}
    for split_name, rows in {"val": eval_rows, "test": test_rows or []}.items():
        if not rows:
            continue
        predictions = trainer.predict(SentimentDataset(rows, tokenizer, max_length))
        predicted_ids = np.argmax(predictions.predictions, axis=-1)
        label_ids = np.array([LABEL_TO_ID[row.label] for row in rows])
        matrix = confusion_matrix(label_ids, predicted_ids, labels=[LABEL_TO_ID[label] for label in LABEL_TO_ID])
        payload[split_name] = matrix.tolist()
    with (output_dir / "confusion_matrix.json").open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()

import argparse
import csv
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from sklearn.metrics import accuracy_score, confusion_matrix, precision_recall_fscore_support
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from train import ID_TO_LABEL, LABEL_TO_ID, Row, load_rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate a sentiment model and export review candidates.")
    parser.add_argument("--model-dir", default="models/xhs-bert-sentiment")
    parser.add_argument("--data", required=True, help="CSV or JSONL with text,label columns.")
    parser.add_argument("--output-dir", default="", help="Directory for metrics and misclassified CSV.")
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--max-length", type=int, default=160)
    parser.add_argument("--review-limit", type=int, default=200)
    args = parser.parse_args()

    model_dir = Path(args.model_dir)
    rows = load_rows(Path(args.data))
    tokenizer = AutoTokenizer.from_pretrained(model_dir)
    logits = predict_logits(model_dir, tokenizer, rows, args.batch_size, args.max_length)
    probabilities = softmax(logits)
    prediction_ids = np.argmax(probabilities, axis=-1)
    confidence = np.max(probabilities, axis=-1)
    margins = top_two_margin(probabilities)
    label_ids = np.array([LABEL_TO_ID[row.label] for row in rows])

    output_dir = Path(args.output_dir) if args.output_dir else model_dir / "evaluation"
    output_dir.mkdir(parents=True, exist_ok=True)
    write_metrics(output_dir, label_ids, prediction_ids, rows)
    write_review_csv(output_dir, rows, prediction_ids, confidence, margins, args.review_limit)
    print(f"Evaluation written to: {output_dir}")


def predict_logits(model_dir: Path, tokenizer, rows: list[Row], batch_size: int, max_length: int) -> np.ndarray:
    onnx_path = first_existing(model_dir / "model-int8.onnx", model_dir / "model.onnx")
    if onnx_path:
        return predict_logits_onnx(onnx_path, tokenizer, rows, batch_size, max_length)
    return predict_logits_torch(model_dir, tokenizer, rows, batch_size, max_length)


def predict_logits_onnx(onnx_path: Path, tokenizer, rows: list[Row], batch_size: int, max_length: int) -> np.ndarray:
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    input_names = {item.name for item in session.get_inputs()}
    batches = []
    for start in range(0, len(rows), batch_size):
        texts = [row.text for row in rows[start : start + batch_size]]
        encoded = tokenizer(texts, padding=True, truncation=True, max_length=max_length, return_tensors="np")
        inputs = {key: value.astype(np.int64) for key, value in encoded.items() if key in input_names}
        batches.append(session.run(None, inputs)[0])
    return np.concatenate(batches, axis=0)


def predict_logits_torch(model_dir: Path, tokenizer, rows: list[Row], batch_size: int, max_length: int) -> np.ndarray:
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = AutoModelForSequenceClassification.from_pretrained(model_dir)
    model.to(device)
    model.eval()
    batches = []
    for start in range(0, len(rows), batch_size):
        texts = [row.text for row in rows[start : start + batch_size]]
        encoded = tokenizer(texts, padding=True, truncation=True, max_length=max_length, return_tensors="pt").to(device)
        with torch.no_grad():
            batches.append(model(**encoded).logits.detach().cpu().numpy())
    return np.concatenate(batches, axis=0)


def write_metrics(output_dir: Path, label_ids: np.ndarray, prediction_ids: np.ndarray, rows: list[Row]) -> None:
    precision, recall, macro_f1, _ = precision_recall_fscore_support(label_ids, prediction_ids, average="macro", zero_division=0)
    _, _, per_label_f1, support = precision_recall_fscore_support(
        label_ids,
        prediction_ids,
        labels=[LABEL_TO_ID[label] for label in LABEL_TO_ID],
        average=None,
        zero_division=0,
    )
    payload = {
        "samples": len(rows),
        "accuracy": accuracy_score(label_ids, prediction_ids),
        "macro_precision": precision,
        "macro_recall": recall,
        "macro_f1": macro_f1,
        "per_label": {
            label: {
                "f1": float(per_label_f1[index]),
                "support": int(support[index]),
            }
            for index, label in enumerate(LABEL_TO_ID)
        },
        "labels": list(LABEL_TO_ID),
        "confusion_matrix": confusion_matrix(
            label_ids,
            prediction_ids,
            labels=[LABEL_TO_ID[label] for label in LABEL_TO_ID],
        ).tolist(),
    }
    with (output_dir / "metrics.json").open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)


def write_review_csv(
    output_dir: Path,
    rows: list[Row],
    prediction_ids: np.ndarray,
    confidence: np.ndarray,
    margins: np.ndarray,
    review_limit: int,
) -> None:
    candidates = []
    for index, row in enumerate(rows):
        predicted_label = ID_TO_LABEL[int(prediction_ids[index])]
        if predicted_label != row.label:
            candidates.append(
                {
                    "text": row.text,
                    "label": row.label,
                    "predicted_label": predicted_label,
                    "confidence": round(float(confidence[index]), 4),
                    "margin": round(float(margins[index]), 4),
                    "manual_label": "",
                    "notes": "",
                }
            )
    candidates.sort(key=lambda item: (-item["confidence"], item["margin"]))
    with (output_dir / "misclassified_review.csv").open("w", encoding="utf-8-sig", newline="") as file:
        fieldnames = ["text", "label", "predicted_label", "confidence", "margin", "manual_label", "notes"]
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(candidates[:review_limit])


def first_existing(*paths: Path) -> Path | None:
    for path in paths:
        if path.exists():
            return path
    return None


def softmax(logits: np.ndarray) -> np.ndarray:
    logits = logits - np.max(logits, axis=-1, keepdims=True)
    exp = np.exp(logits)
    return exp / np.sum(exp, axis=-1, keepdims=True)


def top_two_margin(probabilities: np.ndarray) -> np.ndarray:
    sorted_probs = np.sort(probabilities, axis=-1)
    return sorted_probs[:, -1] - sorted_probs[:, -2]


if __name__ == "__main__":
    main()

import argparse
import csv
from pathlib import Path

from train import LABEL_TO_ID


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply manual_label corrections from review CSV files to dataset CSV files.")
    parser.add_argument("--input", required=True, help="Original train/val/test CSV file.")
    parser.add_argument("--review", action="append", required=True, help="Review CSV with text,label,predicted_label,manual_label columns.")
    parser.add_argument("--output", required=True, help="Corrected output CSV file.")
    args = parser.parse_args()

    corrections = load_corrections([Path(path) for path in args.review])
    input_path = Path(args.input)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    changed = 0
    total = 0
    with input_path.open("r", encoding="utf-8-sig", newline="") as source, output_path.open(
        "w",
        encoding="utf-8-sig",
        newline="",
    ) as target:
        reader = csv.DictReader(source)
        if not reader.fieldnames:
            raise SystemExit(f"CSV has no header: {input_path}")
        fieldnames = list(reader.fieldnames)
        if "label" not in fieldnames:
            raise SystemExit(f"CSV must include label column: {input_path}")
        writer = csv.DictWriter(target, fieldnames=fieldnames)
        writer.writeheader()
        for row in reader:
            total += 1
            key = normalize_text(row.get("text") or row.get("text_norm") or "")
            manual_label = corrections.get(key)
            if manual_label and manual_label != row.get("label"):
                row["label"] = manual_label
                changed += 1
            writer.writerow(row)

    print(f"Applied {changed} corrections to {total} rows: {output_path}")


def load_corrections(review_paths: list[Path]) -> dict[str, str]:
    corrections = {}
    for path in review_paths:
        with path.open("r", encoding="utf-8-sig", newline="") as file:
            for row in csv.DictReader(file):
                manual_label = str(row.get("manual_label", "")).strip()
                if manual_label not in LABEL_TO_ID:
                    continue
                text = normalize_text(row.get("text") or row.get("text_norm") or "")
                if text:
                    corrections[text] = manual_label
    return corrections


def normalize_text(value: str) -> str:
    return " ".join(str(value or "").strip().split())


if __name__ == "__main__":
    main()

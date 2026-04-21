import json
from pathlib import Path

from app.utils import ensure_parent_dir


def write_json(path: str | Path, payload: dict) -> None:
    ensure_parent_dir(path)
    with Path(path).open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)

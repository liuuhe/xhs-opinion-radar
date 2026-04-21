from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.utils import find_existing_path

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


@dataclass(slots=True)
class BrowserConfig:
    home_url: str = "https://www.xiaohongshu.com/explore"
    login_url: str = "https://www.xiaohongshu.com/"
    login_candidates: list[str] = field(
        default_factory=lambda: [
            "https://www.xiaohongshu.com/",
            "https://www.xiaohongshu.com/explore",
            "https://www.xiaohongshu.com/search_result",
        ]
    )
    headless: bool = False
    slow_mo_ms: int = 200
    default_timeout_ms: int = 20000
    storage_state_path: str = "sessions/xiaohongshu_storage_state.json"
    ignore_https_errors: bool = True
    locale: str = "zh-CN"
    timezone_id: str = "Asia/Shanghai"
    user_agent: str = (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
    launch_args: list[str] = field(
        default_factory=lambda: [
            "--disable-blink-features=AutomationControlled",
            "--disable-quic",
            "--disable-dev-shm-usage",
        ]
    )


@dataclass(slots=True)
class CrawlConfig:
    posts_per_batch: int = 10
    comments_per_post: int = 40
    max_scroll_rounds: int = 20
    feed_scroll_px: int = 1600
    post_open_wait_ms: int = 2000
    comment_expand_clicks: int = 6
    comment_scroll_rounds: int = 8
    comment_scroll_px: int = 900
    dedupe_fallback_salt: str = "public-opinion-v1"


@dataclass(slots=True)
class AppConfig:
    browser: BrowserConfig = field(default_factory=BrowserConfig)
    crawl: CrawlConfig = field(default_factory=CrawlConfig)


def _update_dataclass(instance: Any, values: dict[str, Any] | None) -> None:
    if not values:
        return
    for key, value in values.items():
        if hasattr(instance, key):
            setattr(instance, key, value)


def load_config(path: str = "config.yaml") -> AppConfig:
    config = AppConfig()
    file_path = _resolve_runtime_path(path)
    if file_path.exists():
        payload = _load_config_payload(file_path)
        _update_dataclass(config.browser, payload.get("browser"))
        _update_dataclass(config.crawl, payload.get("crawl"))
    return config


def _load_config_payload(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if yaml is not None:
        return yaml.safe_load(text) or {}
    return _parse_simple_yaml(text)


def _parse_simple_yaml(text: str) -> dict[str, Any]:
    root: dict[str, Any] = {}
    stack: list[tuple[int, Any]] = [(-1, root)]
    lines = text.splitlines()

    for index, raw_line in enumerate(lines):
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        stripped = raw_line.strip()

        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()

        current = stack[-1][1]
        if stripped.startswith("- "):
            if not isinstance(current, list):
                raise RuntimeError(f"Invalid list entry in config line: {raw_line}")
            current.append(_parse_scalar(stripped[2:].strip()))
            continue

        if ":" not in stripped:
            raise RuntimeError(f"Invalid config line: {raw_line}")
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()

        if value == "":
            next_container: Any
            next_significant = _peek_next_significant_line(lines, index)
            if next_significant is not None and next_significant.strip().startswith("- "):
                next_container = []
            else:
                next_container = {}
            current[key] = next_container
            stack.append((indent, next_container))
            continue

        current[key] = _parse_scalar(value)

    return root


def _peek_next_significant_line(lines: list[str], current_index: int) -> str | None:
    for line in lines[current_index + 1 :]:
        if line.strip() and not line.lstrip().startswith("#"):
            return line
    return None


def _parse_scalar(value: str) -> Any:
    trimmed = value.strip().strip('"').strip("'")
    lowered = trimmed.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered in {"null", "none"}:
        return None
    try:
        if "." in trimmed:
            return float(trimmed)
        return int(trimmed)
    except ValueError:
        return trimmed


def _resolve_runtime_path(relative_name: str) -> Path:
    requested = Path(relative_name).expanduser()
    if requested.is_absolute():
        return requested

    project_root = Path(__file__).resolve().parent.parent
    candidate = find_existing_path(
        [
            Path.cwd() / requested,
            project_root / requested,
        ]
    )
    if candidate is not None:
        return candidate
    return project_root / requested

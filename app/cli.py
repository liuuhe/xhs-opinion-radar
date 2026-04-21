from __future__ import annotations

import argparse
import json

from app.config import load_config
from app.crawler import collect_keyword_capture, doctor_browser, login


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Public opinion data pipeline CLI")
    parser.add_argument("--config", default="config.yaml", help="Path to config file")

    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("login", help="Manual Xiaohongshu login and save browser session")
    subparsers.add_parser("doctor_browser", help="Diagnose browser access to Xiaohongshu URLs")

    collect_parser = subparsers.add_parser("collect", help="Collect Xiaohongshu keyword posts with local Playwright")
    collect_parser.add_argument("--keyword", required=True, help="Keyword to search on Xiaohongshu")
    collect_parser.add_argument("--posts", type=int, default=None, help="Maximum posts to collect")
    collect_parser.add_argument("--comments", type=int, default=None, help="Maximum comments per post")
    collect_parser.add_argument("--output", default=None, help="Path for captured JSON request")
    collect_parser.add_argument("--worker-url", default=None, help="Optional Worker URL for immediate analysis")
    collect_parser.add_argument("--engine", choices=["llm", "bert"], default="llm")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    config = load_config(args.config)

    if args.command == "login":
        login(config)
        return 0

    if args.command == "doctor_browser":
        result = doctor_browser(config)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.command == "collect":
        result = collect_keyword_capture(
            config,
            keyword=args.keyword,
            posts=args.posts,
            comments_per_post=args.comments,
            output_path=args.output,
            worker_url=args.worker_url,
            engine=args.engine,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    parser.error(f"Unsupported command: {args.command}")
    return 1

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.config import AppConfig, load_config
from app.crawler import (
    _build_comment_candidate,
    _decode_keyword,
    _extract_post_urls_from_payloads,
    _is_plausible_comment_candidate,
    _normalize_post_url,
)
from app.storage import write_json


class PipelineTests(unittest.TestCase):
    def test_decode_keyword_handles_double_encoded_input(self) -> None:
        self.assertEqual(_decode_keyword("%25E5%2592%2596%25E5%2595%25A1"), "咖啡")

    def test_normalize_post_url_keeps_query_string(self) -> None:
        url = (
            "https://www.xiaohongshu.com/explore/69afa831000000002603377b"
            "?xsec_token=abc123&xsec_source=pc_feed"
        )
        normalized = _normalize_post_url(url)
        self.assertEqual(
            normalized,
            "https://www.xiaohongshu.com/explore/69afa831000000002603377b"
            "?xsec_token=abc123&xsec_source=pc_feed",
        )

    def test_extract_post_urls_from_network_payloads(self) -> None:
        payloads = [
            {
                "url": "https://edith.xiaohongshu.com/api/sns/web/v1/search/notes",
                "payload": {
                    "data": {
                        "items": [
                            {
                                "note_id": "69afa831000000002603377b",
                                "xsec_token": "token-a",
                                "note_card": {"display_title": "咖啡推荐"},
                            },
                            {
                                "note_id": "69afa832000000002603377c",
                                "note_card": {"title": "拿铁测评"},
                            },
                        ]
                    }
                },
            }
        ]
        urls = _extract_post_urls_from_payloads(payloads)
        self.assertEqual(len(urls), 2)
        self.assertIn("xsec_token=token-a", urls[0])
        self.assertTrue(urls[1].startswith("https://www.xiaohongshu.com/explore/69afa832"))

    def test_comment_candidate_requires_comment_context(self) -> None:
        candidate = _build_comment_candidate(
            {
                "content": "宿舍翻修太吵了",
                "commentId": "c1",
                "userId": "u1",
            },
            ["https://edith.xiaohongshu.com/api/sns/web/v2/comment/page"],
        )
        self.assertIsNotNone(candidate)
        self.assertTrue(_is_plausible_comment_candidate(candidate or {}))

        garbage = {
            "text": "还没有简介",
            "user_id": "u2",
            "_path_hint": "global0.profile.desc",
        }
        self.assertFalse(_is_plausible_comment_candidate(garbage))

    def test_comment_candidate_infers_reply_level_and_generic_id(self) -> None:
        candidate = _build_comment_candidate(
            {
                "content": "同意",
                "id": "reply-1",
                "user": {"id": "u2"},
            },
            ["https://edith.xiaohongshu.com/api/sns/web/v2/comment/page", "data", "comments", "0", "sub_comments", "0"],
            parent_comment_id="root-1",
        )
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate["comment_id"], "reply-1")
        self.assertEqual(candidate["parent_comment_id"], "root-1")
        self.assertEqual(candidate["comment_level"], 2)

    def test_config_loader_keeps_runtime_config_small(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "config.yaml"
            config_path.write_text(
                "\n".join(
                    [
                        "browser:",
                        "  storage_state_path: sessions/test.json",
                        "crawl:",
                        "  posts_per_batch: 3",
                        "  comments_per_post: 5",
                    ]
                ),
                encoding="utf-8",
            )
            config = load_config(str(config_path))
            self.assertIsInstance(config, AppConfig)
            self.assertEqual(config.browser.storage_state_path, "sessions/test.json")
            self.assertEqual(config.crawl.posts_per_batch, 3)
            self.assertEqual(config.crawl.comments_per_post, 5)

    def test_write_json_creates_parent_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "nested" / "capture.json"
            write_json(output_path, {"keyword": "咖啡"})
            self.assertIn('"咖啡"', output_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

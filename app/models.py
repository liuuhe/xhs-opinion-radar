from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(slots=True)
class PostRecord:
    post_id: str
    post_url: str
    feed_batch_id: str
    capture_time: str
    title: str = ""
    description: str = ""
    author_hash: str = ""
    publish_time: str = ""
    topic_tags: list[str] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)
    raw_snapshot: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class CommentRecord:
    comment_id: str
    post_id: str
    post_url: str
    feed_batch_id: str
    capture_time: str
    comment_level: int
    parent_comment_id: str | None
    user_hash: str
    reply_to_user_hash: str = ""
    comment_text_raw: str = ""
    comment_time: str = ""
    dedupe_key: str = ""
    raw_snapshot: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

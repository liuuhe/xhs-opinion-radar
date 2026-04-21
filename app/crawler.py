from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urljoin, urlparse
from urllib.request import Request, urlopen

from app.config import AppConfig
from app.models import CommentRecord, PostRecord
from app.storage import write_json
from app.utils import ensure_parent_dir, hash_identifier, normalize_text, utc_now_iso


POST_URL_PATTERNS = ("/explore/", "/discovery/item/")
COMMENT_PATH_HINTS = ("comment", "comments", "subcomment", "sub_comment", "reply", "replies")
COMMENT_TEXT_FIELDS = ("content", "text", "commentContent", "comment_content", "message")


def login(config: AppConfig) -> None:
    sync_playwright = _load_playwright()
    storage_state_path = Path(config.browser.storage_state_path)
    ensure_parent_dir(storage_state_path)

    with sync_playwright() as playwright:
        browser = _launch_browser(playwright, config, headless=False)
        context = _new_context(browser, config)
        page = context.new_page()
        page.set_default_timeout(config.browser.default_timeout_ms)
        _goto_with_fallback(
            page,
            config.browser.login_candidates or [config.browser.login_url],
            config,
            label="login",
        )
        print("Please log in to Xiaohongshu in the opened browser window.")
        input("After login succeeds and the home feed is visible, press Enter to continue...")
        context.storage_state(path=str(storage_state_path))
        browser.close()
        print(f"Saved storage state to {storage_state_path}")


def doctor_browser(config: AppConfig) -> dict[str, Any]:
    sync_playwright = _load_playwright()
    diagnostics: list[dict[str, str]] = []

    with sync_playwright() as playwright:
        browser = _launch_browser(playwright, config, headless=config.browser.headless)
        context = _new_context(browser, config)
        page = context.new_page()
        page.set_default_timeout(config.browser.default_timeout_ms)

        for url in config.browser.login_candidates or [config.browser.login_url]:
            try:
                page.goto(url, wait_until="domcontentloaded")
                diagnostics.append(
                    {
                        "url": url,
                        "status": "ok",
                        "final_url": page.url,
                        "title": page.title(),
                    }
                )
            except Exception as exc:
                diagnostics.append(
                    {
                        "url": url,
                        "status": "error",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )
        browser.close()

    return {
        "headless": config.browser.headless,
        "ignore_https_errors": config.browser.ignore_https_errors,
        "launch_args": config.browser.launch_args,
        "results": diagnostics,
    }


def collect_keyword_capture(
    config: AppConfig,
    keyword: str,
    posts: int | None = None,
    comments_per_post: int | None = None,
    output_path: str | None = None,
    worker_url: str | None = None,
    engine: str = "llm",
) -> dict[str, Any]:
    keyword = _decode_keyword(keyword)
    if not keyword:
        raise RuntimeError("Keyword is required.")

    sync_playwright = _load_playwright()
    storage_state_path = Path(config.browser.storage_state_path)
    if not storage_state_path.exists():
        raise RuntimeError(
            f"Storage state not found at {storage_state_path}. Run `python -m app login` first."
        )

    max_posts = posts or config.crawl.posts_per_batch
    max_comments = comments_per_post or config.crawl.comments_per_post
    capture_path = output_path or _default_capture_path(keyword)
    source_page_url = _search_url(keyword)
    captured_posts: list[dict[str, Any]] = []

    with sync_playwright() as playwright:
        browser = _launch_browser(playwright, config, headless=config.browser.headless)
        context = _new_context(browser, config, storage_state=str(storage_state_path))
        search_page = context.new_page()
        search_page.set_default_timeout(config.browser.default_timeout_ms)
        search_payloads = _capture_response_payloads(search_page)
        _goto_with_fallback(search_page, [source_page_url], config, label=f"search keyword {keyword}")
        time.sleep(2)

        post_urls = _collect_keyword_post_urls(search_page, search_payloads, max_posts, config)
        feed_batch_id = f"keyword-{hash_identifier(keyword)}-{int(time.time())}"
        seen_post_ids: set[str] = set()

        for post_url in post_urls[:max_posts]:
            post_page = context.new_page()
            post_page.set_default_timeout(config.browser.default_timeout_ms)
            response_payloads = _capture_response_payloads(post_page)
            try:
                _goto_with_fallback(post_page, [post_url], config, label="post detail")
                time.sleep(config.crawl.post_open_wait_ms / 1000)
                post_data = _extract_post(post_page, post_url, feed_batch_id, config)
                if not post_data or post_data.post_id in seen_post_ids:
                    continue
                seen_post_ids.add(post_data.post_id)
                comments = _extract_comments(post_page, post_data, max_comments, config, response_payloads)
                captured_posts.append(_to_captured_post(post_data, comments))
                print(f"[collect] {len(captured_posts)}/{max_posts} {post_data.title or post_data.post_url} comments={len(comments)}")
            finally:
                post_page.close()

        browser.close()

    capture_payload = {
        "keyword": keyword,
        "engine": engine if engine in {"llm", "bert"} else "llm",
        "maxPosts": max_posts,
        "commentsPerPost": max_comments,
        "pageUrl": source_page_url,
        "posts": captured_posts,
    }
    write_json(capture_path, capture_payload)

    result: dict[str, Any] = {
        "keyword": keyword,
        "posts": len(captured_posts),
        "comments": sum(len(post.get("comments", [])) for post in captured_posts),
        "capture_path": capture_path,
    }
    if worker_url:
        analysis = _post_capture_to_worker(worker_url, capture_payload)
        analysis_path = _default_analysis_path(keyword)
        write_json(analysis_path, analysis)
        result["analysis_path"] = analysis_path
        result["summary"] = analysis.get("summary", "")
    return result


def _load_playwright():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "Playwright is not installed. Run `pip install -e .` and `playwright install chromium`."
        ) from exc
    return sync_playwright


def _launch_browser(playwright: Any, config: AppConfig, headless: bool) -> Any:
    return playwright.chromium.launch(
        headless=headless,
        slow_mo=config.browser.slow_mo_ms,
        args=config.browser.launch_args or None,
    )


def _new_context(browser: Any, config: AppConfig, storage_state: str | None = None) -> Any:
    kwargs = {
        "ignore_https_errors": config.browser.ignore_https_errors,
        "locale": config.browser.locale,
        "timezone_id": config.browser.timezone_id,
        "user_agent": config.browser.user_agent,
    }
    if storage_state:
        kwargs["storage_state"] = storage_state
    return browser.new_context(**kwargs)


def _goto_with_fallback(page: Any, urls: list[str], config: AppConfig, label: str) -> None:
    errors: list[str] = []
    for url in urls:
        try:
            page.goto(url, wait_until="domcontentloaded")
            return
        except Exception as exc:
            errors.append(f"{url} -> {type(exc).__name__}: {exc}")
            time.sleep(1.0)
    attempted = "\n".join(errors)
    raise RuntimeError(
        f"Failed to open {label}. Tried URLs:\n{attempted}\n\n"
        "Likely causes:\n"
        "1. The local network cannot reach xiaohongshu.com.\n"
        "2. Chromium fallback build is being blocked or the TLS/HTTP3 handshake failed.\n"
        "3. The site is actively closing connections for this browser fingerprint.\n\n"
        "Try editing `config.yaml` browser.launch_args or testing the same URLs in a normal browser first."
    )


def _capture_response_payloads(page: Any) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    seen_urls: set[str] = set()

    def handle_response(response: Any) -> None:
        url = response.url
        if url in seen_urls or not _is_relevant_comment_response_url(url):
            return
        seen_urls.add(url)

        headers = response.headers or {}
        content_type = headers.get("content-type", "")
        if "json" not in content_type.lower() and "/api/" not in url:
            return

        try:
            payload = response.json()
        except Exception:
            return
        payloads.append({"url": url, "payload": payload})

    page.on("response", handle_response)
    return payloads


def _is_relevant_comment_response_url(url: str) -> bool:
    lowered = url.lower()
    return "xiaohongshu.com" in lowered and any(
        hint in lowered for hint in ("comment", "comments", "note", "feed")
    )


def _collect_keyword_post_urls(
    page: Any,
    response_payloads: list[dict[str, Any]],
    posts_per_batch: int,
    config: AppConfig,
) -> list[str]:
    collected: list[str] = []
    seen: set[str] = set()

    for _ in range(config.crawl.max_scroll_rounds):
        candidates = page.evaluate(
            """
            () => {
              const anchors = Array.from(document.querySelectorAll("a[href]"));
              const html = document.documentElement.innerHTML
                .replaceAll("\\u002F", "/")
                .replaceAll("\\/", "/")
                .replaceAll("&amp;", "&");
              const hrefs = anchors.map((anchor) => anchor.href).filter(Boolean);
              const matches = Array.from(html.matchAll(/(?:https?:\\/\\/www\\.xiaohongshu\\.com)?\\/(?:explore|discovery\\/item)\\/([0-9a-fA-F]{12,32})(?:[^"'<>\\s]*)/g))
                .map((match) => match[0]);
              return hrefs.concat(matches);
            }
            """
        )
        candidates.extend(_extract_post_urls_from_payloads(response_payloads))
        for url in candidates:
            normalized = _normalize_post_url(str(url))
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            collected.append(normalized)
            if len(collected) >= posts_per_batch:
                return collected
        page.mouse.wheel(0, config.crawl.feed_scroll_px)
        time.sleep(1.2)
    return collected


def _extract_post_urls_from_payloads(payloads: list[dict[str, Any]]) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    for item in payloads:
        payload = item.get("payload")
        for post in _walk_post_payload(payload):
            url = _make_post_url(post["post_id"], post.get("xsec_token", ""), post.get("xsec_source", "pc_search"))
            if url not in seen:
                seen.add(url)
                urls.append(url)
    return urls


def _walk_post_payload(node: Any) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    seen: set[str] = set()

    def walk(value: Any, depth: int = 0) -> None:
        if depth > 8 or value is None:
            return
        if isinstance(value, list):
            for child in value:
                walk(child, depth + 1)
            return
        if not isinstance(value, dict):
            return

        note_card = value.get("note_card") or value.get("noteCard") or value
        post_id = str(
            value.get("note_id")
            or value.get("noteId")
            or note_card.get("note_id")
            or note_card.get("noteId")
            or note_card.get("id")
            or ""
        ).strip()
        title = str(note_card.get("display_title") or note_card.get("title") or note_card.get("desc") or "").strip()
        if post_id and title and post_id not in seen:
            seen.add(post_id)
            results.append(
                {
                    "post_id": post_id,
                    "xsec_token": str(value.get("xsec_token") or note_card.get("xsec_token") or ""),
                    "xsec_source": str(value.get("xsec_source") or note_card.get("xsec_source") or "pc_search"),
                }
            )

        for child in value.values():
            walk(child, depth + 1)

    walk(node)
    return results


def _normalize_post_url(url: str) -> str | None:
    if not any(pattern in url for pattern in POST_URL_PATTERNS):
        return None
    parsed = urlparse(url)
    path = parsed.path.rstrip("/")
    if not any(pattern in path for pattern in POST_URL_PATTERNS):
        return None
    normalized = urljoin(f"{parsed.scheme}://{parsed.netloc}", path)
    if parsed.query:
        normalized = f"{normalized}?{parsed.query}"
    return normalized


def _make_post_url(post_id: str, xsec_token: str = "", xsec_source: str = "pc_search") -> str:
    url = f"https://www.xiaohongshu.com/explore/{post_id}"
    query: list[str] = []
    if xsec_token:
        query.append(f"xsec_token={quote(xsec_token)}")
    if xsec_source:
        query.append(f"xsec_source={quote(xsec_source)}")
    return f"{url}?{'&'.join(query)}" if query else url


def _extract_post(page: Any, post_url: str, feed_batch_id: str, config: AppConfig) -> PostRecord | None:
    snapshot = page.evaluate(
        """
        () => {
          const meta = (name) => {
            const node = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
            return node ? node.content : "";
          };
          const title = document.querySelector("title")?.innerText || meta("og:title") || "";
          const description = meta("description") || meta("og:description") || "";
          const author = document.querySelector("a[href*='/user/profile/']")?.textContent || "";
          const tags = Array.from(document.querySelectorAll("a, span"))
            .map((node) => (node.textContent || "").trim())
            .filter((text) => text.startsWith("#"))
            .slice(0, 10);
          return { title, description, author, tags };
        }
        """
    )
    post_id = _extract_post_id(post_url)
    if not post_id:
        return None
    title = normalize_text(snapshot.get("title", ""))
    description = normalize_text(snapshot.get("description", ""))
    if "页面不见了" in title or "页面不见了" in description:
        return None
    return PostRecord(
        post_id=post_id,
        post_url=post_url,
        feed_batch_id=feed_batch_id,
        capture_time=utc_now_iso(),
        title=title,
        description=description,
        author_hash=hash_identifier(snapshot.get("author", ""), salt="xhs-author"),
        topic_tags=[normalize_text(tag) for tag in snapshot.get("tags", []) if normalize_text(tag)],
        raw_snapshot=snapshot,
    )


def _extract_post_id(url: str) -> str:
    match = re.search(r"/(?:explore|discovery/item)/([A-Za-z0-9]+)", url)
    return match.group(1) if match else ""


def _extract_comments(
    page: Any,
    post_record: PostRecord,
    comments_per_post: int,
    config: AppConfig,
    response_payloads: list[dict[str, Any]] | None = None,
) -> list[CommentRecord]:
    _expand_comment_threads(page, config)
    comments = _extract_comments_from_network_payloads(response_payloads or [])
    if not comments:
        comments = _extract_comments_from_global_state(page)
    if not comments:
        comments = _extract_comments_from_dom(page)

    records: list[CommentRecord] = []
    seen_comment_ids: set[str] = set()

    for item in comments:
        if not _is_plausible_comment_candidate(item):
            continue
        raw_text = normalize_text(str(item.get("text", "")))
        if not raw_text:
            continue
        comment_id = str(item.get("comment_id") or "")
        user_id = str(item.get("user_id") or "")
        dedupe_key = comment_id or hash_identifier(
            json.dumps(
                {
                    "post_id": post_record.post_id,
                    "user_id": user_id,
                    "parent_comment_id": item.get("parent_comment_id"),
                    "text": raw_text,
                    "salt": config.crawl.dedupe_fallback_salt,
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
            salt="comment-fallback",
        )
        if dedupe_key in seen_comment_ids:
            continue
        seen_comment_ids.add(dedupe_key)

        record = CommentRecord(
            comment_id=comment_id or dedupe_key,
            post_id=post_record.post_id,
            post_url=post_record.post_url,
            feed_batch_id=post_record.feed_batch_id,
            capture_time=utc_now_iso(),
            comment_level=int(item.get("comment_level") or 1),
            parent_comment_id=item.get("parent_comment_id"),
            user_hash=hash_identifier(user_id, salt="xhs-user"),
            reply_to_user_hash=hash_identifier(str(item.get("reply_to_user", "")), salt="xhs-user")
            if item.get("reply_to_user")
            else "",
            comment_text_raw=raw_text,
            comment_time=str(item.get("comment_time", "")),
            dedupe_key=dedupe_key,
            raw_snapshot=item,
        )
        records.append(record)
        if len(records) >= comments_per_post:
            break

    return records


def _extract_comments_from_network_payloads(payloads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    seen: set[str] = set()

    for item in payloads:
        url = str(item.get("url", ""))
        payload = item.get("payload")
        _walk_comment_payload(payload, [url], results, seen)

    return results


def _walk_comment_payload(
    node: Any,
    path: list[str],
    results: list[dict[str, Any]],
    seen: set[str],
    parent_comment_id: str | None = None,
) -> None:
    if isinstance(node, list):
        for index, child in enumerate(node):
            _walk_comment_payload(child, [*path, str(index)], results, seen, parent_comment_id)
        return

    if not isinstance(node, dict):
        return

    candidate = _build_comment_candidate(node, path, parent_comment_id)
    if candidate:
        key = f"{candidate.get('comment_id', '')}:{candidate.get('user_id', '')}:{candidate.get('text', '')}"
        if key not in seen:
            seen.add(key)
            results.append(candidate)
        next_parent_comment_id = str(candidate.get("comment_id") or parent_comment_id or "")
    else:
        next_parent_comment_id = parent_comment_id or ""

    for key, value in node.items():
        child_parent_comment_id = next_parent_comment_id if key in {"subComments", "sub_comments", "replies"} else parent_comment_id
        _walk_comment_payload(value, [*path, str(key)], results, seen, child_parent_comment_id)


def _build_comment_candidate(
    node: dict[str, Any],
    path: list[str],
    parent_comment_id: str | None = None,
) -> dict[str, Any] | None:
    text = ""
    for field in COMMENT_TEXT_FIELDS:
        value = node.get(field)
        if isinstance(value, str) and value.strip():
            text = value
            break
    if not text:
        return None

    comment_id = _first_string(
        node,
        ("commentId", "comment_id", "subCommentId", "sub_comment_id", "id"),
    )
    node_parent_comment_id = _first_string(node, ("parentCommentId", "parent_comment_id"))
    user_id = _extract_user_id(node)
    reply_to_user = _first_string(node, ("replyUserId", "reply_user_id"))
    comment_time = _first_string(node, ("time", "createTime", "create_time", "ipLocation"))
    path_hint = ".".join(path).lower()

    has_comment_context = (
        any(hint in path_hint for hint in COMMENT_PATH_HINTS)
        or bool(comment_id)
        or bool(node_parent_comment_id)
        or isinstance(node.get("subComments"), list)
        or isinstance(node.get("sub_comments"), list)
        or isinstance(node.get("replies"), list)
    )
    if not has_comment_context:
        return None

    effective_parent_comment_id = node_parent_comment_id or parent_comment_id or ""
    comment_level = 2 if effective_parent_comment_id or ".sub_comments." in path_hint or ".subcomments." in path_hint or ".replies." in path_hint else 1

    return {
        "comment_id": comment_id,
        "user_id": user_id,
        "parent_comment_id": effective_parent_comment_id or None,
        "text": text,
        "comment_time": comment_time,
        "comment_level": comment_level,
        "reply_to_user": reply_to_user,
        "_path_hint": path_hint,
    }


def _first_string(node: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = node.get(key)
        if value is None:
            continue
        if isinstance(value, (str, int)):
            value_str = str(value).strip()
            if value_str:
                return value_str
    return ""


def _extract_user_id(node: dict[str, Any]) -> str:
    direct = _first_string(node, ("userId", "user_id", "uid"))
    if direct:
        return direct
    for nested_key in ("user", "userInfo", "user_info", "author", "authorInfo"):
        nested = node.get(nested_key)
        if isinstance(nested, dict):
            nested_value = _first_string(nested, ("userId", "user_id", "uid", "id"))
            if nested_value:
                return nested_value
    return ""


def _is_plausible_comment_candidate(item: dict[str, Any]) -> bool:
    text = normalize_text(str(item.get("text", "")))
    if len(text) < 2 or len(text) > 300:
        return False

    path_hint = str(item.get("_path_hint", "")).lower()
    comment_id = str(item.get("comment_id", "")).strip()
    parent_comment_id = str(item.get("parent_comment_id", "")).strip()
    user_id = str(item.get("user_id", "")).strip()
    has_comment_context = any(hint in path_hint for hint in COMMENT_PATH_HINTS)

    if comment_id or parent_comment_id:
        return True
    if has_comment_context and user_id:
        return True
    if path_hint.startswith("dom_comment"):
        return True
    return False


def _expand_comment_threads(page: Any, config: AppConfig) -> None:
    for _ in range(config.crawl.comment_expand_clicks):
        clicked = page.evaluate(
            """
            () => {
              const patterns = ["展开", "更多回复", "查看更多回复", "全部回复"];
              const clickable = Array.from(document.querySelectorAll("button, span, div"))
                .find((node) => patterns.some((pattern) => (node.textContent || "").includes(pattern)));
              if (!clickable) return false;
              clickable.click();
              return true;
            }
            """
        )
        if not clicked:
            break
        time.sleep(0.8)

    for _ in range(config.crawl.comment_scroll_rounds):
        page.mouse.wheel(0, config.crawl.comment_scroll_px)
        time.sleep(0.8)


def _extract_comments_from_global_state(page: Any) -> list[dict[str, Any]]:
    return page.evaluate(
        """
        () => {
          const globals = [
            window.__INITIAL_STATE__,
            window.__NEXT_DATA__,
            window.__NUXT__,
            window.__APOLLO_STATE__,
            window.__INITIAL_SSR_STATE__,
          ].filter(Boolean);

          const results = [];
          const seen = new Set();
          const visited = new WeakSet();

          function walk(node, depth = 0, path = []) {
            if (!node || depth > 8) return;
            if (Array.isArray(node)) {
              node.forEach((item, index) => walk(item, depth + 1, path.concat(String(index))));
              return;
            }
            if (typeof node !== "object") return;
            if (visited.has(node)) return;
            visited.add(node);

            const text = node.content || node.text || node.commentContent || node.desc;
            const commentId = node.commentId || node.comment_id || node.subCommentId || node.sub_comment_id;
            const userId = node.userId || node.user_id || node.uid || (node.user && (node.user.userId || node.user.id));
            const parentId = node.parentCommentId || node.parent_comment_id || null;
            const subComments = node.subComments || node.sub_comments || node.replies || [];
            const pathHint = path.join(".").toLowerCase();
            const hasCommentContext = (
              path.some((segment) => ["comment", "comments", "reply", "replies", "sub_comments", "subComments"].includes(segment)) ||
              Boolean(commentId) ||
              Boolean(parentId) ||
              Array.isArray(subComments)
            );

            if (typeof text === "string" && text.trim() && hasCommentContext) {
              const key = `${commentId || ""}:${text}`;
              if (!seen.has(key)) {
                seen.add(key);
                results.push({
                  comment_id: commentId || "",
                  user_id: userId || "",
                  parent_comment_id: parentId,
                  text: text,
                  comment_time: node.time || node.createTime || node.create_time || "",
                  comment_level: parentId ? 2 : 1,
                  reply_to_user: node.replyUserId || node.reply_to_user || "",
                  _path_hint: pathHint,
                });
              }
            }

            Object.entries(node).forEach(([key, value]) => walk(value, depth + 1, path.concat(key)));
            if (Array.isArray(subComments)) {
              subComments.forEach((item, index) => walk(item, depth + 1, path.concat("subComments", String(index))));
            }
          }

          globals.forEach((item, index) => walk(item, 0, [`global${index}`]));
          return results;
        }
        """
    )


def _extract_comments_from_dom(page: Any) -> list[dict[str, Any]]:
    return page.evaluate(
        """
        () => {
          const results = [];
          const seen = new Set();
          const selectors = [
            "[data-comment-id]",
            "[data-rid]",
            "[class*='comment-item']",
            "[class*='CommentItem']",
            "[class*='reply-item']",
            "[class*='comment']",
            "[class*='Comment']",
          ];
          const commentRoots = Array.from(document.querySelectorAll("[class*='comment'], [class*='Comment']"))
            .filter((node) => (node.innerText || "").includes("评论"));
          const searchRoot = commentRoots[0] || document.body;
          const nodes = Array.from(searchRoot.querySelectorAll(selectors.join(",")));
          for (const node of nodes) {
            const text = (node.innerText || "").trim();
            if (!text || text.length < 2) continue;
            const lines = text.split("\\n").map((line) => line.trim()).filter(Boolean);
            if (lines.length < 2) continue;
            const normalizedText = lines[lines.length - 1];
            const key = `${node.getAttribute("data-comment-id") || ""}:${normalizedText}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({
              comment_id: node.getAttribute("data-comment-id") || "",
              user_id: node.getAttribute("data-user-id") || "",
              parent_comment_id: node.getAttribute("data-parent-comment-id"),
              text: normalizedText,
              comment_time: "",
              comment_level: node.getAttribute("data-parent-comment-id") ? 2 : 1,
              reply_to_user: "",
              _path_hint: "dom_comment",
            });
          }
          return results;
        }
        """
    )


def _to_captured_post(post: PostRecord, comments: list[CommentRecord]) -> dict[str, Any]:
    return {
        "postId": post.post_id,
        "url": post.post_url,
        "title": post.title,
        "description": post.description,
        "authorHash": post.author_hash,
        "tags": post.topic_tags,
        "comments": [_to_captured_comment(comment) for comment in comments],
    }


def _to_captured_comment(comment: CommentRecord) -> dict[str, Any]:
    source = "network"
    path_hint = str(comment.raw_snapshot.get("_path_hint", ""))
    if path_hint.startswith("dom_comment"):
        source = "dom"
    elif path_hint.startswith("global"):
        source = "global"
    return {
        "sampleId": f"local-{comment.dedupe_key or comment.comment_id}",
        "commentId": comment.comment_id,
        "postId": comment.post_id,
        "postUrl": comment.post_url,
        "text": comment.comment_text_raw,
        "userHash": comment.user_hash,
        "commentLevel": comment.comment_level,
        "captureSource": source,
    }


def _search_url(keyword: str) -> str:
    encoded = quote(keyword)
    return f"https://www.xiaohongshu.com/search_result?keyword={encoded}&source=web_search_result_notes&type=51"


def _decode_keyword(value: str) -> str:
    decoded = str(value)
    for _ in range(2):
        next_value = unquote(decoded)
        if next_value == decoded:
            break
        decoded = next_value
    return normalize_text(decoded)


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", value).strip("-")
    return cleaned[:40] or "keyword"


def _default_capture_path(keyword: str) -> str:
    return f"data/captures/public-opinion-{_safe_filename(keyword)}-capture.json"


def _default_analysis_path(keyword: str) -> str:
    return f"data/reports/public-opinion-{_safe_filename(keyword)}-analysis.json"


def _post_capture_to_worker(worker_url: str, payload: dict[str, Any]) -> dict[str, Any]:
    endpoint = worker_url.rstrip("/") + "/api/analyze/captured"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=120) as response:
        response_body = response.read().decode("utf-8")
    return json.loads(response_body)

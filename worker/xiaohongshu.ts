import { launch } from "@cloudflare/playwright";
import type { AnalysisDiagnostics, CapturedComment, CapturedPost } from "../src/shared/types";
import { ApiError, type Env } from "./env";
import { hashIdentifier, isMeaningfulComment, normalizeText } from "./text";

const POST_URL_PATTERNS = ["/explore/", "/discovery/item/"];
const COMMENT_PATH_HINTS = ["comment", "comments", "subcomment", "sub_comment", "reply", "replies"];
const COMMENT_TEXT_FIELDS = ["content", "text", "commentContent", "comment_content", "message", "desc"];
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type PageLike = any;

interface PayloadCapture {
  url: string;
  payload: unknown;
}

interface CommentCandidate {
  commentId: string;
  userId: string;
  parentCommentId: string | null;
  text: string;
  commentLevel: number;
  pathHint: string;
}

export async function crawlKeyword(input: {
  env: Env;
  keyword: string;
  maxPosts: number;
  commentsPerPost: number;
  warnings: string[];
}): Promise<{ posts: CapturedPost[]; diagnostics: AnalysisDiagnostics }> {
  const storageState = await loadStorageState(input.env);
  const browser = await launch(input.env.BROWSER as Parameters<typeof launch>[0]);

  try {
    const context = await browser.newContext({
      storageState: storageState as any,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: true
    });
    const page = await context.newPage();
    page.setDefaultTimeout?.(25000);

    const searchCapture = await collectSearchPostUrls(page, input.keyword, input.maxPosts, input.warnings);
    const postUrls = searchCapture.urls;
    const diagnostics: AnalysisDiagnostics = {
      ...searchCapture.diagnostics,
      commentCountsByPost: {}
    };
    if (postUrls.length === 0) {
      input.warnings.push("未在搜索页提取到帖子链接，可能是登录态失效、页面结构变化或搜索结果为空。");
      diagnostics.errorCode = diagnostics.hasLoginGate ? "login_required" : "search_no_posts";
      diagnostics.advice = diagnostics.hasLoginGate
        ? "搜索页显示登录门槛，请刷新小红书登录态后重试。"
        : "搜索页没有提取到帖子链接，建议更换关键词或检查小红书页面结构。";
    }

    const posts: CapturedPost[] = [];
    const seenPostIds = new Set<string>();

    for (const postUrl of postUrls.slice(0, input.maxPosts)) {
      const postPage = await context.newPage();
      postPage.setDefaultTimeout?.(25000);
      const payloads = captureResponsePayloads(postPage);

      try {
        await gotoWithTimeout(postPage, postUrl);
        await postPage.waitForTimeout(2200);
        const post = await extractPost(postPage, postUrl);
        if (seenPostIds.has(post.postId)) {
          continue;
        }
        seenPostIds.add(post.postId);
        post.comments = await extractComments(postPage, payloads, post, input.commentsPerPost);
        diagnostics.commentCountsByPost![post.postId] = post.comments.length;
        posts.push(post);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        input.warnings.push(`帖子抓取失败：${postUrl} (${detail.slice(0, 160)})`);
      } finally {
        await postPage.close().catch(() => undefined);
      }
    }

    try {
      const updatedStorageState = await context.storageState({ indexedDB: true });
      await input.env.PUBLIC_OPINION_KV.put(storageStateKey(input.env), JSON.stringify(updatedStorageState));
    } catch {
      input.warnings.push("登录态刷新写回 KV 失败，不影响本次分析结果。");
    }

    await context.close().catch(() => undefined);
    if (posts.length > 0 && posts.every((post) => post.comments.length === 0) && input.commentsPerPost > 0) {
      diagnostics.errorCode = "comment_empty";
      diagnostics.advice = "帖子已抓到但评论为空，可能是评论接口变化、评论未加载或页面风控。";
    }
    return { posts, diagnostics };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function loadStorageState(env: Env): Promise<unknown> {
  const value = await env.PUBLIC_OPINION_KV.get(storageStateKey(env));
  if (!value) {
    throw new ApiError(
      424,
      "缺少小红书登录态",
      "请先确认本地已有 sessions/xiaohongshu_storage_state.json，然后运行 `npm run cf:upload-session` 上传到 KV key `xhs:storage_state`。只有本地登录态缺失或失效时才需要 `python -m app login`。",
      "missing_storage_state"
    );
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ApiError(500, "KV 中的小红书登录态不是合法 JSON", String(error));
  }
}

function storageStateKey(env: Env): string {
  return env.XHS_STORAGE_STATE_KEY || "xhs:storage_state";
}

async function collectSearchPostUrls(
  page: PageLike,
  keyword: string,
  maxPosts: number,
  warnings: string[]
): Promise<{ urls: string[]; diagnostics: AnalysisDiagnostics }> {
  const payloads = captureResponsePayloads(page);
  const encoded = encodeURIComponent(keyword);
  const urls = [
    `https://www.xiaohongshu.com/search_result?keyword=${encoded}&source=web_search_result_notes`,
    `https://www.xiaohongshu.com/search_result?keyword=${encoded}`
  ];

  for (const url of urls) {
    try {
      await gotoWithTimeout(page, url);
      break;
    } catch (error) {
      warnings.push(`搜索页打开失败：${url} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const collected: string[] = [];
  const seen = new Set<string>();

  for (let round = 0; round < 8; round += 1) {
    const domUrls = await extractPostUrlsFromDom(page);
    const payloadUrls = extractPostUrlsFromPayloads(payloads);
    for (const url of [...domUrls, ...payloadUrls]) {
      const normalized = normalizePostUrl(url);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      collected.push(normalized);
      if (collected.length >= maxPosts) {
        return {
          urls: collected,
          diagnostics: await collectSearchDiagnostics(page, payloads, collected.length)
        };
      }
    }
    await page.mouse.wheel(0, 1400).catch(() => undefined);
    await page.waitForTimeout(1000);
  }

  return {
    urls: collected,
    diagnostics: await collectSearchDiagnostics(page, payloads, collected.length)
  };
}

async function gotoWithTimeout(page: PageLike, url: string): Promise<void> {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000
  });
}

function captureResponsePayloads(page: PageLike): PayloadCapture[] {
  const payloads: PayloadCapture[] = [];
  const seen = new Set<string>();

  page.on("response", (response: any) => {
    void (async () => {
      const url = String(response.url?.() || response.url || "");
      if (seen.has(url) || !isRelevantPayloadUrl(url)) {
        return;
      }
      seen.add(url);

      const headers = typeof response.headers === "function" ? await response.headers() : {};
      const contentType = String(headers["content-type"] || "");
      if (!contentType.toLowerCase().includes("json") && !url.includes("/api/")) {
        return;
      }

      try {
        payloads.push({ url, payload: await response.json() });
      } catch {
        // Ignore non-JSON responses from the same API namespace.
      }
    })();
  });

  return payloads;
}

function isRelevantPayloadUrl(url: string): boolean {
  const lowered = url.toLowerCase();
  return (
    lowered.includes("xiaohongshu.com") &&
    ["comment", "comments", "note", "feed", "search"].some((hint) => lowered.includes(hint))
  );
}

async function collectSearchDiagnostics(
  page: PageLike,
  payloads: PayloadCapture[],
  extractedLinkCount: number
): Promise<AnalysisDiagnostics> {
  const snapshot = await page
    .evaluate(() => {
      const bodyText = document.body?.innerText || "";
      return {
        pageUrl: location.href,
        pageTitle: document.title,
        bodyExcerpt: bodyText.slice(0, 600),
        hasLoginGate:
          bodyText.includes("登录后查看搜索结果") ||
          bodyText.includes("手机号登录") ||
          bodyText.includes("获取验证码") ||
          bodyText.includes("新用户可直接登录")
      };
    })
    .catch(() => ({
      pageUrl: "",
      pageTitle: "",
      bodyExcerpt: "",
      hasLoginGate: false
    }));

  return {
    ...snapshot,
    extractedLinkCount,
    networkPayloadCount: payloads.length
  };
}

async function extractPostUrlsFromDom(page: PageLike): Promise<string[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => (anchor as HTMLAnchorElement).href)
      .filter(Boolean);
  });
}

function extractPostUrlsFromPayloads(payloads: PayloadCapture[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const item of payloads) {
    walkPostPayload(item.payload, results, seen);
  }

  return results;
}

function walkPostPayload(node: unknown, results: string[], seen: Set<string>): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walkPostPayload(child, results, seen));
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }

  const item = node as Record<string, unknown>;
  const directUrl = firstString(item, ["url", "noteUrl", "note_url", "shareLink", "share_link"]);
  const normalizedDirectUrl = normalizePostUrl(directUrl);
  if (normalizedDirectUrl && !seen.has(normalizedDirectUrl)) {
    seen.add(normalizedDirectUrl);
    results.push(normalizedDirectUrl);
  }

  const noteId = firstString(item, ["noteId", "note_id", "noteIdStr", "note_id_str"]);
  if (noteId && /^[A-Za-z0-9]{12,40}$/.test(noteId)) {
    const generated = `https://www.xiaohongshu.com/explore/${noteId}`;
    if (!seen.has(generated)) {
      seen.add(generated);
      results.push(generated);
    }
  }

  Object.values(item).forEach((child) => walkPostPayload(child, results, seen));
}

function normalizePostUrl(url: string): string | null {
  if (!url || !POST_URL_PATTERNS.some((pattern) => url.includes(pattern))) {
    return null;
  }

  try {
    const parsed = new URL(url, "https://www.xiaohongshu.com");
    if (!POST_URL_PATTERNS.some((pattern) => parsed.pathname.includes(pattern))) {
      return null;
    }
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

async function extractPost(page: PageLike, postUrl: string): Promise<CapturedPost> {
  const snapshot = await page.evaluate(() => {
    const meta = (name: string) => {
      const node = document.querySelector(
        `meta[name="${name}"], meta[property="${name}"]`
      ) as HTMLMetaElement | null;
      return node?.content || "";
    };
    const title =
      (document.querySelector("title") as HTMLElement | null)?.innerText ||
      meta("og:title") ||
      "";
    const description = meta("description") || meta("og:description") || "";
    const author =
      (document.querySelector("a[href*='/user/profile/']") as HTMLElement | null)?.textContent ||
      "";
    const tags = Array.from(document.querySelectorAll("a, span"))
      .map((node) => (node.textContent || "").trim())
      .filter((text) => text.startsWith("#"))
      .slice(0, 10);
    return { title, description, author, tags };
  });

  const postId = extractPostId(postUrl) || (await hashIdentifier(postUrl, "xhs-post-url"));
  const author = normalizeText(String(snapshot.author || ""));

  return {
    postId,
    url: postUrl,
    title: normalizeText(String(snapshot.title || "")),
    description: normalizeText(String(snapshot.description || "")),
    authorHash: author ? await hashIdentifier(author, "xhs-author") : "",
    tags: Array.isArray(snapshot.tags)
      ? snapshot.tags.map((tag: unknown) => normalizeText(String(tag))).filter(Boolean)
      : [],
    comments: []
  };
}

function extractPostId(url: string): string {
  const match = url.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/);
  return match?.[1] || "";
}

async function extractComments(
  page: PageLike,
  payloads: PayloadCapture[],
  post: CapturedPost,
  limit: number
): Promise<CapturedComment[]> {
  if (limit <= 0) {
    return [];
  }

  await expandCommentThreads(page);

  const candidates = [
    ...extractCommentsFromPayloads(payloads, "network"),
    ...(await extractCommentsFromGlobalState(page)),
    ...(await extractCommentsFromDom(page))
  ];
  const records: CapturedComment[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const text = normalizeText(candidate.text);
    if (!isMeaningfulComment(text)) {
      continue;
    }

    const dedupeMaterial =
      candidate.commentId || `${post.postId}:${candidate.userId}:${candidate.parentCommentId || ""}:${text}`;
    const dedupeKey = await hashIdentifier(dedupeMaterial, "xhs-comment");
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    const commentId = candidate.commentId || dedupeKey;
    records.push({
      sampleId: await hashIdentifier(`${post.postId}:${commentId}:${text}`, "clean-sample"),
      commentId,
      postId: post.postId,
      postUrl: post.url,
      text,
      userHash: candidate.userId ? await hashIdentifier(candidate.userId, "xhs-user") : "",
      commentLevel: candidate.commentLevel || 1,
      captureSource: sourceFromPath(candidate.pathHint)
    });

    if (records.length >= limit) {
      return records;
    }
  }

  return records;
}

async function expandCommentThreads(page: PageLike): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    const clicked = await page
      .evaluate(() => {
        const patterns = ["展开", "更多回复", "查看更多回复", "全部回复"];
        const clickable = Array.from(document.querySelectorAll("button, span, div")).find((node) =>
          patterns.some((pattern) => (node.textContent || "").includes(pattern))
        ) as HTMLElement | undefined;
        if (!clickable) {
          return false;
        }
        clickable.click();
        return true;
      })
      .catch(() => false);
    if (!clicked) {
      break;
    }
    await page.waitForTimeout(700);
  }

  for (let index = 0; index < 5; index += 1) {
    await page.mouse.wheel(0, 900).catch(() => undefined);
    await page.waitForTimeout(700);
  }
}

function extractCommentsFromPayloads(
  payloads: PayloadCapture[],
  source: "network"
): CommentCandidate[] {
  const results: CommentCandidate[] = [];
  const seen = new Set<string>();

  for (const item of payloads) {
    walkCommentPayload(item.payload, [source, item.url], results, seen);
  }

  return results;
}

function walkCommentPayload(
  node: unknown,
  path: string[],
  results: CommentCandidate[],
  seen: Set<string>,
  parentCommentId: string | null = null
): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) =>
      walkCommentPayload(child, [...path, String(index)], results, seen, parentCommentId)
    );
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }

  const candidate = buildCommentCandidate(node as Record<string, unknown>, path, parentCommentId);
  const nextParentCommentId = candidate?.commentId || parentCommentId;
  if (candidate) {
    const key = `${candidate.commentId}:${candidate.userId}:${candidate.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push(candidate);
    }
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const childParent = ["subComments", "sub_comments", "replies"].includes(key)
      ? nextParentCommentId
      : parentCommentId;
    walkCommentPayload(value, [...path, key], results, seen, childParent || null);
  }
}

function buildCommentCandidate(
  node: Record<string, unknown>,
  path: string[],
  parentCommentId: string | null
): CommentCandidate | null {
  const text = COMMENT_TEXT_FIELDS.map((field) => node[field]).find(
    (value) => typeof value === "string" && value.trim()
  );
  if (!text) {
    return null;
  }

  const commentId = firstString(node, ["commentId", "comment_id", "subCommentId", "sub_comment_id", "id"]);
  const nodeParentCommentId = firstString(node, ["parentCommentId", "parent_comment_id"]);
  const userId = extractUserId(node);
  const pathHint = path.join(".").toLowerCase();
  const hasCommentContext =
    COMMENT_PATH_HINTS.some((hint) => pathHint.includes(hint)) ||
    Boolean(commentId) ||
    Boolean(nodeParentCommentId) ||
    Array.isArray(node.subComments) ||
    Array.isArray(node.sub_comments) ||
    Array.isArray(node.replies);

  if (!hasCommentContext) {
    return null;
  }

  const effectiveParent = nodeParentCommentId || parentCommentId || "";
  return {
    commentId,
    userId,
    parentCommentId: effectiveParent || null,
    text: String(text),
    commentLevel: effectiveParent || pathHint.includes(".replies.") ? 2 : 1,
    pathHint
  };
}

async function extractCommentsFromGlobalState(page: PageLike): Promise<CommentCandidate[]> {
  return page
    .evaluate(() => {
      const globals = [
        (window as any).__INITIAL_STATE__,
        (window as any).__NEXT_DATA__,
        (window as any).__NUXT__,
        (window as any).__APOLLO_STATE__,
        (window as any).__INITIAL_SSR_STATE__
      ].filter(Boolean);
      const results: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      const visited = new WeakSet<object>();

      function walk(node: unknown, depth = 0, path: string[] = [], parentCommentId = "") {
        if (!node || depth > 8) {
          return;
        }
        if (Array.isArray(node)) {
          node.forEach((item, index) => walk(item, depth + 1, [...path, String(index)], parentCommentId));
          return;
        }
        if (typeof node !== "object") {
          return;
        }
        if (visited.has(node)) {
          return;
        }
        visited.add(node);

        const item = node as Record<string, any>;
        const text = item.content || item.text || item.commentContent || item.desc;
        const commentId = item.commentId || item.comment_id || item.subCommentId || item.sub_comment_id || item.id || "";
        const user = item.user || item.userInfo || item.user_info || item.author || item.authorInfo || {};
        const userId = item.userId || item.user_id || item.uid || user.userId || user.user_id || user.uid || user.id || "";
        const parentId = item.parentCommentId || item.parent_comment_id || parentCommentId || "";
        const subComments = item.subComments || item.sub_comments || item.replies || [];
        const pathHint = path.join(".").toLowerCase();
        const hasContext =
          pathHint.includes("comment") ||
          pathHint.includes("reply") ||
          Boolean(commentId) ||
          Boolean(parentId) ||
          Array.isArray(subComments);

        if (typeof text === "string" && text.trim() && hasContext) {
          const key = `${commentId}:${userId}:${text}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({
              commentId,
              userId,
              parentCommentId: parentId || null,
              text,
              commentLevel: parentId ? 2 : 1,
              pathHint: `global.${pathHint}`
            });
          }
        }

        Object.entries(item).forEach(([key, value]) =>
          walk(value, depth + 1, [...path, key], parentId || parentCommentId)
        );
      }

      globals.forEach((item, index) => walk(item, 0, [`global${index}`]));
      return results;
    })
    .catch(() => []);
}

async function extractCommentsFromDom(page: PageLike): Promise<CommentCandidate[]> {
  return page
    .evaluate(() => {
      const results: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      const selectors = [
        "[data-comment-id]",
        "[data-rid]",
        "[class*='comment-item']",
        "[class*='CommentItem']",
        "[class*='reply-item']",
        "[class*='comment']",
        "[class*='Comment']"
      ];
      const roots = Array.from(document.querySelectorAll("[class*='comment'], [class*='Comment']")).filter((node) =>
        (node.textContent || "").includes("评论")
      );
      const searchRoot = roots[0] || document.body;
      const nodes = Array.from(searchRoot.querySelectorAll(selectors.join(",")));

      for (const node of nodes) {
        const text = (node.textContent || "").trim();
        if (!text || text.length < 2) {
          continue;
        }
        const lines = text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const normalizedText = lines[lines.length - 1] || "";
        const element = node as HTMLElement;
        const key = `${element.getAttribute("data-comment-id") || ""}:${normalizedText}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        results.push({
          commentId: element.getAttribute("data-comment-id") || element.getAttribute("data-rid") || "",
          userId: element.getAttribute("data-user-id") || "",
          parentCommentId: element.getAttribute("data-parent-comment-id"),
          text: normalizedText,
          commentLevel: element.getAttribute("data-parent-comment-id") ? 2 : 1,
          pathHint: "dom.comment"
        });
      }

      return results;
    })
    .catch(() => []);
}

function firstString(node: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = node[key];
    if (typeof value === "string" || typeof value === "number") {
      const normalized = String(value).trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return "";
}

function extractUserId(node: Record<string, unknown>): string {
  const direct = firstString(node, ["userId", "user_id", "uid"]);
  if (direct) {
    return direct;
  }

  for (const key of ["user", "userInfo", "user_info", "author", "authorInfo"]) {
    const nested = node[key];
    if (nested && typeof nested === "object") {
      const value = firstString(nested as Record<string, unknown>, ["userId", "user_id", "uid", "id"]);
      if (value) {
        return value;
      }
    }
  }

  return "";
}

function sourceFromPath(pathHint: string): "network" | "global" | "dom" {
  if (pathHint.startsWith("global")) {
    return "global";
  }
  if (pathHint.startsWith("dom")) {
    return "dom";
  }
  return "network";
}

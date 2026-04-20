import type {
  AnalysisDiagnostics,
  AnalysisEngine,
  AnalysisErrorCode,
  AnalysisResponse,
  AnalysisStreamEvent,
  AnalyzeRequest,
  CapturedComment,
  CapturedPost,
  ClientCapturedAnalyzeRequest
} from "../src/shared/types";
import { ApiError, type Env } from "./env";
import { buildFixtureAnalysis } from "./fixtures";
import { labelComments } from "./sentiment";
import { recordSessionDiagnostic } from "./session";
import { buildAnalysisResponse } from "./stats";
import { clampNumber, hashIdentifier } from "./text";
import { crawlKeyword } from "./xiaohongshu";

const DEFAULT_MAX_POSTS = 10;
const DEFAULT_COMMENTS_PER_POST = 20;
const BROWSER_COOLDOWN_KEY = "browser:rate-limit:cooldown";

type StageReporter = (event: AnalysisStreamEvent) => void | Promise<void>;

interface BrowserCooldown {
  createdAt: string;
  until: string;
  reason?: string;
}

export async function analyzeKeyword(
  env: Env,
  request: AnalyzeRequest,
  report?: StageReporter
): Promise<AnalysisResponse> {
  const keyword = String(request.keyword || "").trim();
  if (!keyword) {
    throw new ApiError(400, "请输入关键词");
  }
  if (keyword.length > 60) {
    throw new ApiError(400, "关键词过长", "请将关键词控制在 60 个字符以内。");
  }

  const engine = normalizeEngine(request.engine);
  const maxPosts = clampNumber(request.maxPosts, DEFAULT_MAX_POSTS, 1, 30);
  const commentsPerPost = clampNumber(request.commentsPerPost, DEFAULT_COMMENTS_PER_POST, 0, 50);
  const useFixture = Boolean(request.useFixture);

  await report?.({
    stage: "started",
    message: `开始分析“${keyword}”`,
    progress: 5
  });

  if (useFixture) {
    if (!fixtureEnabled(env)) {
      throw new ApiError(
        403,
        "本地 fixture 模式未启用",
        "fixture 仅用于本地开发和答辩彩排。请在本地 .dev.vars 设置 LOCAL_FIXTURE_ENABLED=true。",
        "unknown"
      );
    }
    const fixture = buildFixtureAnalysis({ keyword, engine, maxPosts, commentsPerPost });
    await report?.({
      stage: "completed",
      message: "已加载本地 fixture 演示报告",
      progress: 100,
      result: fixture
    });
    return fixture;
  }

  const cacheKey = await buildCacheKey({ keyword, engine, maxPosts, commentsPerPost });
  const cached = await env.PUBLIC_OPINION_KV.get(cacheKey);
  if (cached) {
    try {
      const response = JSON.parse(cached) as AnalysisResponse;
      const cachedResponse = {
        ...response,
        labeledSamples: response.labeledSamples || response.samples || [],
        warnings: [...(response.warnings || []), "结果来自 Cloudflare KV 缓存。"],
        exports: response.exports || {
          jsonFilename: `public-opinion-${keyword}.json`,
          csvFilename: `public-opinion-${keyword}.csv`,
          markdownFilename: `public-opinion-${keyword}.md`
        },
        summary: response.summary || `“${keyword}”结果来自旧版缓存。`,
        sourceMode: "cache" as const
      };
      await report?.({
        stage: "completed",
        message: "已命中 Cloudflare KV 缓存",
        progress: 100,
        result: cachedResponse
      });
      return cachedResponse;
    } catch {
      await env.PUBLIC_OPINION_KV.delete(cacheKey).catch(() => undefined);
    }
  }

  const warnings: string[] = [];
  if (engine === "bert" && !env.BERT_INFERENCE_URL) {
    throw new ApiError(
      400,
      "BERT 推理服务未配置",
      "请配置 BERT_INFERENCE_URL，或在页面选择 LLM 模式。",
      "unknown"
    );
  }

  const cooldown = await getActiveBrowserCooldown(env);
  if (cooldown) {
    throw new ApiError(
      429,
      "Cloudflare Browser Run 当前被限流",
      cooldown.reason || "Cloudflare 暂时拒绝创建新浏览器。",
      "browser_rate_limited",
      browserRateLimitDiagnostics(cooldown.until, cooldown.reason)
    );
  }

  await report?.({
    stage: "searching",
    message: "正在打开小红书搜索页并提取帖子链接",
    progress: 18
  });

  let diagnostics: AnalysisDiagnostics | undefined;
  let crawlResult: Awaited<ReturnType<typeof crawlKeyword>>;
  try {
    crawlResult = await crawlKeyword({
      env,
      keyword,
      maxPosts,
      commentsPerPost,
      warnings
    });
  } catch (error) {
    const normalized = normalizeAnalysisError(error);
    if (normalized.code === "browser_rate_limited") {
      const until = await markBrowserCooldown(env, normalized.details);
      throw new ApiError(
        429,
        normalized.message,
        normalized.details,
        normalized.code,
        browserRateLimitDiagnostics(until, normalized.details)
      );
    }
    throw error;
  }
  const posts = crawlResult.posts;
  diagnostics = crawlResult.diagnostics;

  if (diagnostics.errorCode === "login_required") {
    await recordSessionDiagnostic(env, diagnostics);
    throw new ApiError(
      401,
      "小红书登录态失效",
      "KV 中存在登录态文件，但 Cloudflare 远程浏览器打开搜索页后仍被小红书要求登录。请重新生成本地 sessions/xiaohongshu_storage_state.json 并运行 npm run cf:upload-session。",
      "login_required",
      diagnostics
    );
  }

  await recordSessionDiagnostic(env, diagnostics);

  if (posts.length === 0) {
    warnings.push("本次没有可分析的帖子。请确认关键词、登录态和小红书页面可访问性。");
  }

  await report?.({
    stage: "posts_captured",
    message: `已提取 ${posts.length} 篇帖子`,
    progress: 46,
    diagnostics
  });

  await report?.({
    stage: "comments_captured",
    message: `已提取 ${posts.reduce((sum, post) => sum + post.comments.length, 0)} 条评论`,
    progress: 62,
    diagnostics
  });

  await report?.({
    stage: "labeling",
    message: "正在执行情绪标注和汇总统计",
    progress: 78,
    diagnostics
  });

  const labeledSamples = await labelComments({
    env,
    engine,
    posts,
    warnings
  });

  if (labeledSamples.length === 0) {
    warnings.push("本次没有可分析的评论样本。");
  }

  const response = buildAnalysisResponse({
    keyword,
    engine,
    capturedAt: new Date().toISOString(),
    posts,
    labeledSamples,
    warnings,
    diagnostics,
    sourceMode: "live"
  });

  const ttl = clampNumber(env.ANALYSIS_CACHE_TTL_SECONDS, 1800, 0, 86400);
  if (ttl > 0 && response.totals.validSamples > 0) {
    await env.PUBLIC_OPINION_KV.put(cacheKey, JSON.stringify(response), {
      expirationTtl: ttl
    });
  }

  await report?.({
    stage: "completed",
    message: "分析完成，已生成报告",
    progress: 100,
    result: response,
    diagnostics
  });

  return response;
}

export async function analyzeClientCapture(
  env: Env,
  request: ClientCapturedAnalyzeRequest
): Promise<AnalysisResponse> {
  const keyword = normalizeKeyword(request.keyword);
  const engine = normalizeEngine(request.engine);
  const maxPosts = clampNumber(request.maxPosts, DEFAULT_MAX_POSTS, 1, 30);
  const commentsPerPost = clampNumber(request.commentsPerPost, DEFAULT_COMMENTS_PER_POST, 0, 80);
  const warnings: string[] = [];

  if (engine === "bert" && !env.BERT_INFERENCE_URL) {
    throw new ApiError(
      400,
      "BERT 推理服务未配置",
      "请配置 BERT_INFERENCE_URL，或在扩展里选择 LLM 模式。",
      "unknown"
    );
  }

  const posts = await sanitizeClientPosts(request.posts, {
    keyword,
    maxPosts,
    commentsPerPost,
    warnings
  });

  const diagnostics: AnalysisDiagnostics = {
    pageUrl: trimString(request.pageUrl, 500),
    extractedLinkCount: posts.length,
    commentCountsByPost: Object.fromEntries(posts.map((post) => [post.postId, post.comments.length])),
    advice:
      posts.length === 0
        ? "扩展未采集到帖子。请先打开小红书搜索页或帖子详情页，滚动加载后再采集。"
        : "本次数据由浏览器扩展在已登录的小红书页面采集，不使用 Cloudflare Browser Run。"
  };

  if (posts.length === 0) {
    warnings.push("扩展没有采集到可分析帖子。请确认当前标签页是小红书搜索页或帖子详情页。");
  }
  const commentCount = posts.reduce((sum, post) => sum + post.comments.length, 0);
  if (commentCount === 0) {
    warnings.push("扩展没有采集到评论样本。请打开帖子详情页并滚动评论区后重新采集。");
  }

  const labeledSamples = await labelComments({
    env,
    engine,
    posts,
    warnings
  });

  return buildAnalysisResponse({
    keyword,
    engine,
    capturedAt: new Date().toISOString(),
    posts,
    labeledSamples,
    warnings,
    diagnostics,
    sourceMode: "client"
  });
}

export function streamAnalyzeKeyword(env: Env, url: URL): Response {
  const encoder = new TextEncoder();
  const request = analyzeRequestFromUrl(url);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AnalysisStreamEvent) => {
        controller.enqueue(encoder.encode(`event: ${event.stage}\ndata: ${JSON.stringify(event)}\n\n`));
      };

      try {
        await analyzeKeyword(env, request, send);
      } catch (error) {
        const normalized = normalizeAnalysisError(error);
        if (normalized.code === "browser_rate_limited" && !normalized.diagnostics?.cooldownUntil) {
          const until = await markBrowserCooldown(env, normalized.details);
          normalized.diagnostics = browserRateLimitDiagnostics(until, normalized.details);
        }
        send({
          stage: "failed",
          message: normalized.message,
          progress: 100,
          error: normalized.message,
          code: normalized.code,
          diagnostics: normalized.diagnostics
        });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    }
  });
}

function normalizeEngine(value: unknown): AnalysisEngine {
  return value === "bert" ? "bert" : "llm";
}

function normalizeKeyword(value: unknown): string {
  const keyword = String(value || "").trim();
  if (!keyword) {
    throw new ApiError(400, "请输入关键词");
  }
  if (keyword.length > 60) {
    throw new ApiError(400, "关键词过长", "请将关键词控制在 60 个字符以内。");
  }
  return keyword;
}

function analyzeRequestFromUrl(url: URL): AnalyzeRequest {
  return {
    keyword: url.searchParams.get("keyword") || "",
    engine: normalizeEngine(url.searchParams.get("engine")),
    maxPosts: Number(url.searchParams.get("maxPosts") || DEFAULT_MAX_POSTS),
    commentsPerPost: Number(url.searchParams.get("commentsPerPost") || DEFAULT_COMMENTS_PER_POST),
    useFixture: ["1", "true", "yes"].includes((url.searchParams.get("useFixture") || "").toLowerCase())
  };
}

function fixtureEnabled(env: Env): boolean {
  return ["1", "true", "yes"].includes(String(env.LOCAL_FIXTURE_ENABLED || "").toLowerCase());
}

function normalizeAnalysisError(error: unknown): {
  message: string;
  details?: string;
  code: AnalysisErrorCode;
  diagnostics?: AnalysisDiagnostics;
} {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      details: error.details,
      code: error.code || "unknown",
      diagnostics: error.diagnostics
    };
  }

  const details = error instanceof Error ? error.message : String(error);
  if (/429|rate limit/i.test(details)) {
    return {
      message: "Cloudflare Browser Run 当前被限流",
      details,
      code: "browser_rate_limited",
      diagnostics: browserRateLimitDiagnostics(undefined, details)
    };
  }

  return {
    message: "分析失败",
    details,
    code: "unknown"
  };
}

async function getActiveBrowserCooldown(env: Env): Promise<BrowserCooldown | null> {
  if (!env.PUBLIC_OPINION_KV) {
    return null;
  }

  const value = await env.PUBLIC_OPINION_KV.get(BROWSER_COOLDOWN_KEY);
  if (!value) {
    return null;
  }

  try {
    const cooldown = JSON.parse(value) as BrowserCooldown;
    if (Date.parse(cooldown.until) > Date.now()) {
      return cooldown;
    }
  } catch {
    // Invalid cooldown payloads should not block future analysis.
  }

  await env.PUBLIC_OPINION_KV.delete(BROWSER_COOLDOWN_KEY).catch(() => undefined);
  return null;
}

async function markBrowserCooldown(env: Env, reason?: string): Promise<string> {
  const seconds = clampNumber(env.BROWSER_RATE_LIMIT_COOLDOWN_SECONDS, 180, 60, 900);
  const now = Date.now();
  const until = new Date(now + seconds * 1000).toISOString();
  if (env.PUBLIC_OPINION_KV) {
    const payload: BrowserCooldown = {
      createdAt: new Date(now).toISOString(),
      until,
      reason
    };
    await env.PUBLIC_OPINION_KV.put(BROWSER_COOLDOWN_KEY, JSON.stringify(payload), {
      expirationTtl: seconds
    }).catch(() => undefined);
  }
  return until;
}

function browserRateLimitDiagnostics(until?: string, reason?: string): AnalysisDiagnostics {
  const retryAfterSeconds = until
    ? Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 1000))
    : undefined;
  return {
    errorCode: "browser_rate_limited",
    bodyExcerpt: reason,
    cooldownUntil: until,
    retryAfterSeconds,
    advice: retryAfterSeconds
      ? `Cloudflare Browser Run 创建浏览器被限流。请等待约 ${retryAfterSeconds} 秒后再点“开始分析”，不要连续刷新或重复提交。`
      : "Cloudflare Browser Run 创建浏览器被限流。请等待几分钟后重试，不要连续刷新或重复提交。"
  };
}

async function buildCacheKey(input: {
  keyword: string;
  engine: AnalysisEngine;
  maxPosts: number;
  commentsPerPost: number;
}): Promise<string> {
  const digest = await hashIdentifier(JSON.stringify(input), "analysis-cache-v1");
  return `analysis:v1:${digest}`;
}

async function sanitizeClientPosts(
  rawPosts: unknown,
  options: {
    keyword: string;
    maxPosts: number;
    commentsPerPost: number;
    warnings: string[];
  }
): Promise<CapturedPost[]> {
  if (!Array.isArray(rawPosts)) {
    return [];
  }

  const posts: CapturedPost[] = [];
  const seenPosts = new Set<string>();

  for (const rawPost of rawPosts) {
    if (!rawPost || typeof rawPost !== "object" || posts.length >= options.maxPosts) {
      continue;
    }
    const item = rawPost as Partial<CapturedPost>;
    const url = trimString(item.url, 500);
    const rawPostId = trimString(item.postId, 120) || extractPostId(url) || `client-post-${posts.length + 1}`;
    const postId = await hashIdentifier(rawPostId, "client-post");
    if (seenPosts.has(postId)) {
      continue;
    }
    seenPosts.add(postId);

    const comments = await sanitizeClientComments(item.comments, {
      postId,
      postUrl: url,
      limit: options.commentsPerPost
    });

    posts.push({
      postId,
      url,
      title: trimString(item.title, 160) || `${options.keyword} 相关帖子`,
      description: trimString(item.description, 500),
      authorHash: trimString(item.authorHash, 80) || "client-author",
      tags: Array.isArray(item.tags) ? item.tags.map((tag) => trimString(tag, 40)).filter(Boolean).slice(0, 12) : [],
      comments
    });
  }

  if (rawPosts.length > options.maxPosts) {
    options.warnings.push(`扩展采集到 ${rawPosts.length} 篇帖子，本次按设置截取前 ${options.maxPosts} 篇。`);
  }

  return posts;
}

async function sanitizeClientComments(
  rawComments: unknown,
  input: {
    postId: string;
    postUrl: string;
    limit: number;
  }
): Promise<CapturedComment[]> {
  if (!Array.isArray(rawComments) || input.limit <= 0) {
    return [];
  }

  const comments: CapturedComment[] = [];
  const seenTexts = new Set<string>();
  for (const rawComment of rawComments) {
    if (!rawComment || typeof rawComment !== "object" || comments.length >= input.limit) {
      continue;
    }
    const item = rawComment as Partial<CapturedComment>;
    const text = trimString(item.text, 300);
    if (!text || seenTexts.has(text)) {
      continue;
    }
    seenTexts.add(text);
    const rawCommentId = trimString(item.commentId, 120) || `${input.postId}:${text}`;
    const commentId = await hashIdentifier(rawCommentId, "client-comment");
    comments.push({
      sampleId: `client-${commentId}`,
      commentId,
      postId: input.postId,
      postUrl: input.postUrl,
      text,
      userHash: trimString(item.userHash, 80) || "client-user",
      commentLevel: clampNumber(item.commentLevel, 1, 1, 5),
      captureSource: item.captureSource === "network" ? "network" : "dom"
    });
  }
  return comments;
}

function trimString(value: unknown, maxLength: number): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function extractPostId(url: string): string {
  const match = url.match(/\/(?:explore|discovery\/item)\/([^/?#]+)/);
  return match?.[1] || "";
}

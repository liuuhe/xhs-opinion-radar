import type {
  AnalysisDiagnostics,
  AnalysisEngine,
  AnalysisResponse,
  AnalyzeRequest,
  CapturedComment,
  CapturedPost,
  ClientCapturedAnalyzeRequest
} from "../src/shared/types";
import { ApiError, type Env } from "./env";
import { buildFixtureAnalysis } from "./fixtures";
import { labelComments } from "./sentiment";
import { buildAnalysisResponse } from "./stats";
import { clampNumber, hashIdentifier } from "./text";

const DEFAULT_MAX_POSTS = 10;
const DEFAULT_COMMENTS_PER_POST = 30;

export async function analyzeFixtureRequest(
  env: Env,
  request: AnalyzeRequest
): Promise<AnalysisResponse> {
  if (!fixtureEnabled(env)) {
    throw new ApiError(
      410,
      "线上抓取已迁移到本地 Playwright",
      "请运行 `python -m app collect --keyword 关键词 --worker-url <Worker地址>`，或向 `/api/analyze/captured` 上传本地采集 JSON。",
      "unknown"
    );
  }

  const keyword = normalizeKeyword(request.keyword || "咖啡");
  const engine = normalizeEngine(request.engine);
  return buildFixtureAnalysis({
    keyword,
    engine,
    maxPosts: clampNumber(request.maxPosts, DEFAULT_MAX_POSTS, 1, 30),
    commentsPerPost: clampNumber(request.commentsPerPost, DEFAULT_COMMENTS_PER_POST, 0, 80)
  });
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
      "Cloudflare Worker 不能直接运行本地 PyTorch 模型。请配置 BERT_INFERENCE_URL，或使用 LLM 模式。",
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
        ? "本地 Playwright 没有采集到帖子。请确认小红书已登录、关键词存在结果，并调高滚动轮次后重试。"
        : "本次数据由本地 Playwright 在已登录浏览器环境采集；Worker 只执行情绪标注和报告生成。"
  };

  if (posts.length === 0) {
    warnings.push("本地采集结果中没有可分析帖子。");
  }
  const commentCount = posts.reduce((sum, post) => sum + post.comments.length, 0);
  if (commentCount === 0) {
    warnings.push("本地采集结果中没有评论样本。请打开帖子评论区可见后重试，或增加 commentsPerPost。");
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

function normalizeEngine(value: unknown): AnalysisEngine {
  return value === "bert" ? "bert" : "llm";
}

function normalizeKeyword(value: unknown): string {
  const keyword = decodeMaybeEncodedText(value).trim();
  if (!keyword) {
    throw new ApiError(400, "请输入关键词");
  }
  if (keyword.length > 60) {
    throw new ApiError(400, "关键词过长", "请将关键词控制在 60 个字符以内。");
  }
  return keyword;
}

function decodeMaybeEncodedText(value: unknown): string {
  let decoded = String(value || "");
  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function fixtureEnabled(env: Env): boolean {
  return ["1", "true", "yes"].includes(String(env.LOCAL_FIXTURE_ENABLED || "").toLowerCase());
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
    const rawPostId = trimString(item.postId, 120) || extractPostId(url) || `local-post-${posts.length + 1}`;
    const postId = await hashIdentifier(rawPostId, "local-post");
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
      authorHash: trimString(item.authorHash, 80) || "local-author",
      tags: Array.isArray(item.tags) ? item.tags.map((tag) => trimString(tag, 40)).filter(Boolean).slice(0, 12) : [],
      comments
    });
  }

  if (rawPosts.length > options.maxPosts) {
    options.warnings.push(`本地采集到 ${rawPosts.length} 篇帖子，本次按设置截取前 ${options.maxPosts} 篇。`);
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
    const commentId = await hashIdentifier(rawCommentId, "local-comment");
    comments.push({
      sampleId: `local-${commentId}`,
      commentId,
      postId: input.postId,
      postUrl: input.postUrl,
      text,
      userHash: trimString(item.userHash, 80) || "local-user",
      commentLevel: clampNumber(item.commentLevel, 1, 1, 5),
      captureSource: item.captureSource === "network" ? "network" : item.captureSource === "global" ? "global" : "dom"
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

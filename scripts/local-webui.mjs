#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staticRoot = path.join(root, "dist", "local-client");
const port = Number(process.env.LOCAL_WEBUI_PORT || process.env.PORT || 8788);
const host = process.env.LOCAL_WEBUI_HOST || "127.0.0.1";
const bertBaseUrl = normalizeBaseUrl(process.env.BERT_INFERENCE_URL || "http://127.0.0.1:7860");
const openaiBaseUrl = normalizeBaseUrl(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1");
const openaiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
const labels = ["positive", "neutral", "negative"];
const captureRoot = path.join(root, "data", "captures");
let crawlerJob = null;

if (!existsSync(staticRoot)) {
  console.error(`Missing ${staticRoot}. Run npm run build:local first.`);
  process.exit(1);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
    if (request.method === "OPTIONS") {
      writeCors(response, 204);
      response.end();
      return;
    }
    if (url.pathname === "/api/health") {
      writeJson(response, {
        ok: true,
        mode: "local-webui",
        llmConfigured: Boolean(process.env.OPENAI_API_KEY),
        bertConfigured: Boolean(bertBaseUrl),
        bertProvider: "local-url",
        fixtureEnabled: false,
        model: openaiModel,
        bertUrl: bertBaseUrl
      });
      return;
    }
    if (url.pathname === "/api/bert/health") {
      const payload = await fetchJson(new URL("/health", bertBaseUrl).toString(), { method: "GET" }, 30_000);
      writeJson(response, payload.body, payload.status);
      return;
    }
    if (url.pathname === "/api/analyze/captured" && request.method === "POST") {
      const body = await readJsonBody(request);
      writeJson(response, await analyzeCaptured(body));
      return;
    }
    if (url.pathname === "/api/mediacrawler/run" && request.method === "POST") {
      const body = await readJsonBody(request);
      writeJson(response, await startMediaCrawler(body), 202);
      return;
    }
    if (url.pathname === "/api/mediacrawler/status") {
      writeJson(response, publicCrawlerJob());
      return;
    }
    if (url.pathname === "/api/mediacrawler/capture") {
      const file = resolveCapturePath(url.searchParams.get("path"));
      writeJson(response, JSON.parse(await readFile(file, "utf8")));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      writeJson(response, { error: "Not found" }, 404);
      return;
    }
    await serveStatic(url.pathname, response);
  } catch (error) {
    const status = Number(error?.status || 500);
    writeJson(response, { error: error instanceof Error ? error.message : String(error) }, status);
  }
});

server.listen(port, host, () => {
  console.log(`Local WebUI: http://${host}:${port}`);
  console.log(`BERT API: ${bertBaseUrl}`);
});

async function analyzeCaptured(request) {
  const keyword = text(request.keyword || "本地分析");
  const engine = request.engine === "bert" ? "bert" : "llm";
  const maxPosts = clamp(request.maxPosts, 10, 1, 200);
  const commentsPerPost = clamp(request.commentsPerPost, 30, 0, 500);
  const warnings = [];
  const posts = sanitizePosts(request.posts, { keyword, maxPosts, commentsPerPost });
  const labeledSamples = await labelComments(engine, flattenComments(posts), warnings, posts);
  return buildAnalysisResponse({
    keyword,
    engine,
    capturedAt: new Date().toISOString(),
    posts,
    labeledSamples,
    warnings,
    diagnostics: {
      pageUrl: text(request.pageUrl),
      extractedLinkCount: posts.length,
      commentCountsByPost: Object.fromEntries(posts.map((post) => [post.postId, post.comments.length])),
      advice: "本次数据由本地 WebUI 分析；BERT/LLM 推理由本机服务完成。"
    }
  });
}

async function startMediaCrawler(request) {
  if (crawlerJob?.running) {
    const error = new Error("MediaCrawler is already running");
    error.status = 409;
    throw error;
  }

  const keyword = text(request.keyword || "咖啡");
  const maxPosts = clamp(request.maxPosts, 10, 1, 200);
  const commentsPerPost = clamp(request.commentsPerPost, 30, 0, 500);
  const headless = Boolean(request.headless);
  const outputPath = path.join(captureRoot, `xhs-mediacrawler-${safeFilename(keyword)}-${timestampForFile()}.json`);
  await mkdir(captureRoot, { recursive: true });

  crawlerJob = {
    id: stableId(`${keyword}:${Date.now()}`, "mc-job"),
    keyword,
    maxPosts,
    commentsPerPost,
    outputPath,
    capturePath: "",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    running: true,
    status: "running",
    exitCode: null,
    error: "",
    logs: []
  };

  const crawlerScript = path.join(root, "scripts", "run-mediacrawler-xhs.ps1");
  const crawlerArgs = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", crawlerScript,
    "--keywords", keyword,
    "--max_notes_count", String(maxPosts),
    "--max_comments_count_singlenotes", String(commentsPerPost),
    "--headless", String(headless),
    "--save_data_path", "..\\..\\data\\mediacrawler"
  ];
  appendCrawlerLog(`Starting MediaCrawler for "${keyword}"`);
  const child = spawn("powershell", crawlerArgs, { cwd: root, windowsHide: false });
  attachProcessLogs(child, "crawler");
  child.on("error", (error) => finishCrawlerJob(1, error.message));
  child.on("exit", async (code) => {
    if (code !== 0) {
      finishCrawlerJob(code ?? 1, `MediaCrawler exited with code ${code}`);
      return;
    }
    try {
      appendCrawlerLog("Converting MediaCrawler output to capture JSON...");
      await runNodeScript(path.join(root, "scripts", "mediacrawler-to-capture.mjs"), [
        "--input-dir", path.join(root, "data", "mediacrawler", "xhs", "jsonl"),
        "--keyword", keyword,
        "--max-posts", String(maxPosts),
        "--comments-per-post", String(commentsPerPost),
        "--output", outputPath
      ]);
      const capture = JSON.parse(await readFile(outputPath, "utf8"));
      const comments = Array.isArray(capture.posts) ? capture.posts.reduce((sum, post) => sum + (Array.isArray(post.comments) ? post.comments.length : 0), 0) : 0;
      crawlerJob.capturePath = outputPath;
      crawlerJob.status = "completed";
      crawlerJob.exitCode = 0;
      crawlerJob.finishedAt = new Date().toISOString();
      crawlerJob.running = false;
      crawlerJob.summary = { posts: Array.isArray(capture.posts) ? capture.posts.length : 0, comments };
      appendCrawlerLog(`Capture JSON ready: ${outputPath}`);
    } catch (error) {
      finishCrawlerJob(1, error instanceof Error ? error.message : String(error));
    }
  });

  return publicCrawlerJob();
}

function runNodeScript(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, windowsHide: true });
    attachProcessLogs(child, "convert");
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Converter exited with code ${code}`));
      }
    });
  });
}

function attachProcessLogs(child, prefix) {
  child.stdout?.on("data", (chunk) => appendCrawlerLog(`[${prefix}] ${chunk.toString("utf8").trim()}`));
  child.stderr?.on("data", (chunk) => appendCrawlerLog(`[${prefix}] ${chunk.toString("utf8").trim()}`));
}

function appendCrawlerLog(line) {
  if (!crawlerJob || !line) {
    return;
  }
  crawlerJob.logs.push(...String(line).split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
  crawlerJob.logs = crawlerJob.logs.slice(-200);
}

function finishCrawlerJob(exitCode, error) {
  if (!crawlerJob) {
    return;
  }
  crawlerJob.running = false;
  crawlerJob.status = "failed";
  crawlerJob.exitCode = exitCode;
  crawlerJob.error = error;
  crawlerJob.finishedAt = new Date().toISOString();
  appendCrawlerLog(error);
}

function publicCrawlerJob() {
  if (!crawlerJob) {
    return { running: false, status: "idle", logs: [] };
  }
  return {
    id: crawlerJob.id,
    keyword: crawlerJob.keyword,
    maxPosts: crawlerJob.maxPosts,
    commentsPerPost: crawlerJob.commentsPerPost,
    running: crawlerJob.running,
    status: crawlerJob.status,
    startedAt: crawlerJob.startedAt,
    finishedAt: crawlerJob.finishedAt,
    exitCode: crawlerJob.exitCode,
    error: crawlerJob.error,
    capturePath: crawlerJob.capturePath,
    summary: crawlerJob.summary,
    logs: crawlerJob.logs
  };
}

function resolveCapturePath(value) {
  const resolved = path.resolve(String(value || ""));
  if (!resolved.startsWith(path.resolve(captureRoot) + path.sep) && resolved !== path.resolve(captureRoot)) {
    const error = new Error("Capture path must be under data/captures");
    error.status = 400;
    throw error;
  }
  if (!existsSync(resolved)) {
    const error = new Error("Capture file not found");
    error.status = 404;
    throw error;
  }
  return resolved;
}

function sanitizePosts(rawPosts, options) {
  const posts = [];
  const seenPosts = new Set();
  for (const rawPost of Array.isArray(rawPosts) ? rawPosts : []) {
    if (!rawPost || typeof rawPost !== "object" || posts.length >= options.maxPosts) {
      continue;
    }
    const url = text(rawPost.url).slice(0, 500);
    const postId = text(rawPost.postId || extractPostId(url) || stableId(url || `${options.keyword}:${posts.length}`, "post"));
    if (seenPosts.has(postId)) {
      continue;
    }
    seenPosts.add(postId);
    const comments = [];
    const seenTexts = new Set();
    for (const rawComment of Array.isArray(rawPost.comments) ? rawPost.comments : []) {
      if (!rawComment || typeof rawComment !== "object" || comments.length >= options.commentsPerPost) {
        continue;
      }
      const commentText = text(rawComment.text).slice(0, 300);
      const dedupeKey = commentText.toLowerCase();
      if (!commentText || seenTexts.has(dedupeKey)) {
        continue;
      }
      seenTexts.add(dedupeKey);
      const commentId = text(rawComment.commentId || stableId(`${postId}:${commentText}`, "comment"));
      comments.push({
        sampleId: text(rawComment.sampleId || `local-${commentId}`),
        commentId,
        postId,
        postUrl: text(rawComment.postUrl || url),
        text: commentText,
        userHash: text(rawComment.userHash || "local-user"),
        commentLevel: clamp(rawComment.commentLevel, 1, 1, 5),
        captureSource: ["network", "global", "dom"].includes(rawComment.captureSource) ? rawComment.captureSource : "dom"
      });
    }
    posts.push({
      postId,
      url,
      title: text(rawPost.title || `${options.keyword} 相关帖子`).slice(0, 160),
      description: text(rawPost.description).slice(0, 500),
      authorHash: text(rawPost.authorHash || "local-author"),
      tags: Array.isArray(rawPost.tags) ? rawPost.tags.map(text).filter(Boolean).slice(0, 12) : [],
      comments
    });
  }
  return posts;
}

async function labelComments(engine, comments, warnings, posts) {
  const titleByPostId = new Map(posts.map((post) => [post.postId, post.title || post.url]));
  const labelsById = engine === "bert" ? await labelWithBert(comments, warnings) : await labelWithLlm(comments, warnings);
  const labelMap = new Map(labelsById.map((item) => [item.sampleId, item]));
  return comments.map((comment) => {
    const result = labelMap.get(comment.sampleId) || heuristicLabel(comment);
    return {
      ...comment,
      label: result.label,
      confidence: result.confidence,
      reasonShort: result.reasonShort,
      postTitle: titleByPostId.get(comment.postId) || "未提取标题"
    };
  });
}

async function labelWithBert(comments, warnings) {
  const chunks = chunkArray(comments, 64);
  const results = [];
  for (const [index, chunk] of chunks.entries()) {
    try {
      const payload = await fetchJson(new URL("/predict", bertBaseUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          samples: chunk.map((comment) => ({ sample_id: comment.sampleId, text: comment.text }))
        })
      }, 90_000);
      const rows = Array.isArray(payload.body?.labels) ? payload.body.labels : [];
      results.push(...rows.map(normalizeLabelRow).filter(Boolean));
    } catch (error) {
      warnings.push(`本地 BERT 第 ${index + 1}/${chunks.length} 批失败，已使用保守兜底：${error instanceof Error ? error.message : String(error)}`);
      results.push(...chunk.map(heuristicLabel));
    }
  }
  return results;
}

async function labelWithLlm(comments, warnings) {
  if (!process.env.OPENAI_API_KEY) {
    warnings.push("本地未配置 OPENAI_API_KEY，已使用保守兜底标注。");
    return comments.map(heuristicLabel);
  }
  const chunks = chunkArray(comments, 20);
  const results = [];
  for (const [index, chunk] of chunks.entries()) {
    try {
      const payload = await fetchJson(`${openaiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: openaiModel,
          temperature: 0,
          max_tokens: 3000,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "你是网络舆情情绪标注器。返回 JSON: {\"labels\":[{\"sample_id\":\"...\",\"label\":\"positive|neutral|negative\",\"confidence\":0.0,\"reason_short\":\"...\"}]}" },
            { role: "user", content: JSON.stringify({ samples: chunk.map((comment) => ({ sample_id: comment.sampleId, text: comment.text })) }) }
          ]
        })
      }, 30_000);
      const content = payload.body?.choices?.[0]?.message?.content || "";
      const parsed = JSON.parse(content);
      const rows = Array.isArray(parsed.labels) ? parsed.labels : [];
      results.push(...rows.map(normalizeLabelRow).filter(Boolean));
    } catch (error) {
      warnings.push(`本地 LLM 第 ${index + 1}/${chunks.length} 批失败，已使用保守兜底：${error instanceof Error ? error.message : String(error)}`);
      results.push(...chunk.map(heuristicLabel));
    }
  }
  return results;
}

function buildAnalysisResponse(input) {
  const distribution = buildDistribution(input.labeledSamples);
  const totals = {
    posts: input.posts.length,
    comments: input.posts.reduce((sum, post) => sum + post.comments.length, 0),
    validSamples: input.labeledSamples.length
  };
  const summary = buildSummary(input.keyword, distribution, totals);
  const insights = buildInsights(distribution, totals, input.posts, input.labeledSamples);
  return {
    keyword: input.keyword,
    engine: input.engine,
    capturedAt: input.capturedAt,
    totals,
    distribution,
    posts: input.posts,
    labeledSamples: input.labeledSamples,
    samples: pickRepresentativeSamples(input.labeledSamples),
    warnings: input.warnings,
    summary,
    insights,
    report: {
      headline: `“${input.keyword}”小红书舆情分析`,
      executiveSummary: summary,
      keyFindings: insights,
      recommendedActions: buildRecommendedActions(distribution, totals, input.warnings),
      dataQuality: buildDataQuality(totals, input.warnings)
    },
    diagnostics: input.diagnostics,
    exports: buildExportInfo(input.keyword),
    sourceMode: "client"
  };
}

function buildDistribution(samples) {
  const total = samples.length || 1;
  return Object.fromEntries(labels.map((label) => {
    const matches = samples.filter((sample) => sample.label === label);
    const confidenceSum = matches.reduce((sum, sample) => sum + sample.confidence, 0);
    return [label, {
      label,
      count: matches.length,
      ratio: Number((matches.length / total).toFixed(4)),
      averageConfidence: matches.length ? Number((confidenceSum / matches.length).toFixed(4)) : 0
    }];
  }));
}

function buildSummary(keyword, distribution, totals) {
  if (totals.validSamples === 0) {
    return `“${keyword}”暂未获得可分析评论样本。`;
  }
  const dominant = Object.values(distribution).sort((left, right) => right.count - left.count)[0];
  return `当前样本由本地 WebUI 分析，“${keyword}”共分析 ${totals.validSamples} 条评论，${labelDisplayName(dominant.label)}情绪占比最高（${Math.round(dominant.ratio * 100)}%）。样本来自 ${totals.posts} 篇帖子。`;
}

function buildInsights(distribution, totals, posts, labeledSamples) {
  if (totals.validSamples === 0) {
    return [{ title: "暂无有效评论样本", detail: "本次导入没有可标注评论。", tone: "info" }];
  }
  const dominant = Object.values(distribution).sort((left, right) => right.count - left.count)[0];
  const negative = distribution.negative;
  const positive = distribution.positive;
  const activePost = posts.map((post) => ({ post, count: post.comments.length })).sort((left, right) => right.count - left.count)[0];
  const highConfidence = labeledSamples.filter((sample) => sample.confidence >= 0.75).length;
  return [
    { title: "主导情绪", detail: `${labelDisplayName(dominant.label)}评论 ${dominant.count} 条，占 ${Math.round(dominant.ratio * 100)}%。`, tone: dominant.label },
    { title: "负面风险", detail: negative.count === 0 ? "当前样本没有明显负向评论。" : `发现 ${negative.count} 条负向评论，占 ${Math.round(negative.ratio * 100)}%。`, tone: negative.ratio >= 0.3 ? "negative" : "neutral" },
    { title: "正向声量", detail: positive.count === 0 ? "当前样本中正向表达较少。" : `正向评论 ${positive.count} 条，占 ${Math.round(positive.ratio * 100)}%。`, tone: positive.ratio >= 0.3 ? "positive" : "neutral" },
    { title: "样本覆盖", detail: activePost ? `评论最多的帖子采集到 ${activePost.count} 条评论：${activePost.post.title || activePost.post.url}` : `本次覆盖 ${totals.posts} 篇帖子。`, tone: "info" },
    { title: "标注可信度", detail: `${highConfidence}/${totals.validSamples} 条样本置信度不低于 75%。`, tone: highConfidence / totals.validSamples >= 0.6 ? "positive" : "neutral" }
  ];
}

function buildRecommendedActions(distribution, totals, warnings) {
  if (totals.validSamples === 0) {
    return ["重新导入包含评论的 capture JSON。"];
  }
  const actions = ["查看代表样本，先核对高置信度评论是否符合业务判断。"];
  if (distribution.negative.ratio >= 0.3) {
    actions.push("优先梳理负向评论中的具体抱怨点。");
  }
  if (distribution.positive.ratio >= 0.3) {
    actions.push("提炼正向评论中的认可点。");
  }
  if (warnings.length > 0 || totals.validSamples < 20) {
    actions.push("当前样本量偏小，建议补充采集后复核结论。");
  }
  return actions;
}

function buildDataQuality(totals, warnings) {
  if (totals.validSamples === 0) {
    return { level: "weak", message: "没有有效评论样本，不能代表舆情趋势。" };
  }
  if (warnings.length > 0 || totals.validSamples < 20) {
    return { level: "limited", message: `有效样本 ${totals.validSamples} 条，适合快速判断方向。` };
  }
  return { level: "good", message: `有效样本 ${totals.validSamples} 条，覆盖 ${totals.posts} 篇帖子。` };
}

function flattenComments(posts) {
  const seen = new Set();
  const results = [];
  for (const post of posts) {
    for (const comment of post.comments) {
      const key = `${comment.postId}:${comment.text.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(comment);
    }
  }
  return results;
}

function heuristicLabel(comment) {
  const negative = /(差|烂|骂|坑|怒|烦|恶心|失望|不满|离谱|抵制|投诉|垃圾|无语|崩溃|讨厌)/u;
  const positive = /(好|棒|赞|喜欢|支持|开心|满意|推荐|优秀|舒服|期待|漂亮|厉害|感动)/u;
  if (negative.test(comment.text)) {
    return { sampleId: comment.sampleId, label: "negative", confidence: 0.62, reasonShort: "local-rules" };
  }
  if (positive.test(comment.text)) {
    return { sampleId: comment.sampleId, label: "positive", confidence: 0.62, reasonShort: "local-rules" };
  }
  return { sampleId: comment.sampleId, label: "neutral", confidence: 0.55, reasonShort: "local-rules" };
}

function normalizeLabelRow(row) {
  const sampleId = text(row?.sample_id || row?.sampleId);
  if (!sampleId) {
    return null;
  }
  return {
    sampleId,
    label: labels.includes(row?.label) ? row.label : "neutral",
    confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0.5)),
    reasonShort: text(row?.reason_short || row?.reasonShort || "local")
  };
}

async function serveStatic(rawPathname, response) {
  const pathname = decodeURIComponent(rawPathname);
  const candidate = path.resolve(staticRoot, pathname.replace(/^\/+/, ""));
  const file = candidate.startsWith(staticRoot) && existsSync(candidate) && !pathname.endsWith("/") ? candidate : path.join(staticRoot, "index.html");
  response.writeHead(200, { "Content-Type": contentType(file) });
  createReadStream(file).pipe(response);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const textBody = await response.text();
    let body = {};
    try {
      body = textBody ? JSON.parse(textBody) : {};
    } catch {
      body = { raw: textBody };
    }
    if (!response.ok) {
      const error = new Error(body.error || body.detail || `${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function writeJson(response, payload, status = 200) {
  writeCors(response, status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function writeText(response, content, type) {
  writeCors(response, 200, { "Content-Type": `${type}; charset=utf-8` });
  response.end(content);
}

function writeCors(response, status, headers = {}) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    ...headers
  });
}

function buildExportInfo(keyword) {
  const safeKeyword = keyword.replace(/[^\p{Script=Han}\w-]+/gu, "-").slice(0, 40) || "keyword";
  return {
    jsonFilename: `public-opinion-${safeKeyword}.json`,
    csvFilename: `public-opinion-${safeKeyword}.csv`,
    markdownFilename: `public-opinion-${safeKeyword}.md`
  };
}

function pickRepresentativeSamples(samples, perLabel = 4) {
  return labels.flatMap((label) => samples.filter((sample) => sample.label === label).sort((left, right) => right.confidence - left.confidence).slice(0, perLabel));
}

function labelDisplayName(label) {
  return { positive: "正向", neutral: "中性", negative: "负向" }[label] || "中性";
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function extractPostId(url) {
  return text(url).match(/\/(?:explore|discovery\/item)\/([^/?#]+)/)?.[1] || "";
}

function stableId(value, prefix) {
  return `${prefix}-${createHash("sha1").update(String(value)).digest("hex").slice(0, 16)}`;
}

function safeFilename(value) {
  return text(value).replace(/[^\p{Script=Han}\w-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "keyword";
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clamp(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(number)));
}

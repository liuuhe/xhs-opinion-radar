import type {
  AnalysisEngine,
  CapturedComment,
  CapturedPost,
  LabeledSample,
  SentimentLabel
} from "../src/shared/types";
import { ApiError, type Env } from "./env";
import {
  extractJsonObject,
  normalizeConfidence,
  normalizeLabel,
  normalizeText
} from "./text";

const SYSTEM_PROMPT = `你是网络舆情情绪标注器。任务是把评论标为 positive、neutral、negative 三类之一。

规则：
1. 只依据评论文本本身的显式情绪，不要依赖额外事件背景。
2. 表达支持、满意、赞同、开心、鼓励，标为 positive。
3. 客观陈述、信息补充、无明显情绪、无法确定，标为 neutral。
4. 表达不满、愤怒、批评、质疑、厌恶、明显讽刺，标为 negative。
5. 无法确定时优先选择 neutral。
6. 必须返回严格 JSON，格式为 {"labels":[{"sample_id":"...","label":"positive|neutral|negative","confidence":0.0,"reason_short":"..."}]}。`;

interface LabelResult {
  sampleId: string;
  label: SentimentLabel;
  confidence: number;
  reasonShort: string;
}

export async function labelComments(input: {
  env: Env;
  engine: AnalysisEngine;
  posts: CapturedPost[];
  warnings: string[];
}): Promise<LabeledSample[]> {
  const comments = flattenComments(input.posts);
  if (comments.length === 0) {
    return [];
  }

  const labels =
    input.engine === "bert"
      ? await labelWithBert(input.env, comments)
      : await labelWithLlm(input.env, comments, input.warnings);

  const labelById = new Map(labels.map((label) => [label.sampleId, label]));
  const titleByPostId = new Map(input.posts.map((post) => [post.postId, post.title || post.url]));

  return comments.map((comment) => {
    const result = labelById.get(comment.sampleId) || heuristicLabel(comment);
    return {
      ...comment,
      label: result.label,
      confidence: result.confidence,
      reasonShort: result.reasonShort,
      postTitle: titleByPostId.get(comment.postId) || "未提取标题"
    };
  });
}

function flattenComments(posts: CapturedPost[]): CapturedComment[] {
  const seen = new Set<string>();
  const results: CapturedComment[] = [];
  for (const post of posts) {
    for (const comment of post.comments) {
      const key = `${comment.postId}:${normalizeText(comment.text)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(comment);
    }
  }
  return results;
}

async function labelWithLlm(
  env: Env,
  comments: CapturedComment[],
  warnings: string[]
): Promise<LabelResult[]> {
  if (!env.OPENAI_API_KEY) {
    throw new ApiError(500, "缺少 OPENAI_API_KEY", "请先运行 `wrangler secret put OPENAI_API_KEY`。", "llm_failed");
  }

  const results: LabelResult[] = [];
  for (const chunk of chunkArray(comments, 20)) {
    try {
      results.push(...(await labelLlmChunk(env, chunk)));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`LLM 批次解析失败，${chunk.length} 条评论已使用本地保守兜底：${detail}`);
      results.push(...chunk.map(heuristicLabel));
    }
  }
  const labeledIds = new Set(results.map((result) => result.sampleId));
  const missing = comments.filter((comment) => !labeledIds.has(comment.sampleId));
  if (missing.length > 0) {
    warnings.push(`LLM 返回缺少 ${missing.length} 条样本，已对缺失样本使用保守兜底。`);
    results.push(...missing.map(heuristicLabel));
  }
  return results;
}

async function labelLlmChunk(env: Env, comments: CapturedComment[]): Promise<LabelResult[]> {
  const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  let response = await postChatCompletion(baseUrl, env, comments, true);

  if (!response.ok) {
    const body = await response.text();
    if ((response.status === 400 || response.status === 422) && body.includes("response_format")) {
      response = await postChatCompletion(baseUrl, env, comments, false);
      if (response.ok) {
        return parseLlmResponse(await response.json());
      }
      const retryBody = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${retryBody.slice(0, 300)}`);
    }
    throw new Error(`LLM request failed: ${response.status} ${body.slice(0, 300)}`);
  }

  return parseLlmResponse(await response.json());
}

function postChatCompletion(
  baseUrl: string,
  env: Env,
  comments: CapturedComment[],
  includeResponseFormat: boolean
): Promise<Response> {
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0,
      ...(includeResponseFormat ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify(
            {
              task: "classify_sentiment",
              samples: comments.map((comment) => ({
                sample_id: comment.sampleId,
                text: comment.text
              }))
            },
            null,
            2
          )
        }
      ]
    })
  });
}

function parseLlmResponse(payload: unknown): LabelResult[] {
  const typedPayload = payload as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = typedPayload.choices?.[0]?.message?.content;
  const textContent = Array.isArray(content)
    ? content
        .filter((block) => block.type === "text")
        .map((block) => block.text || "")
        .join("\n")
    : content || "";

  const parsed = extractJsonObject(textContent) as { labels?: unknown };
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.labels) ? parsed.labels : [];
  if (rows.length === 0) {
    throw new Error("LLM response does not include labels");
  }

  return rows
    .map((row) => normalizeLabelRow(row))
    .filter((row): row is LabelResult => Boolean(row));
}

async function labelWithBert(env: Env, comments: CapturedComment[]): Promise<LabelResult[]> {
  if (!env.BERT_INFERENCE_URL) {
    throw new ApiError(
      400,
      "BERT 推理服务未配置",
      "Cloudflare Worker 不能直接运行本地 PyTorch 模型。请配置 BERT_INFERENCE_URL，或选择 LLM 模式。"
    );
  }

  const response = await fetch(env.BERT_INFERENCE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      samples: comments.map((comment) => ({
        sample_id: comment.sampleId,
        text: comment.text
      }))
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(502, "BERT 推理服务请求失败", `${response.status} ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as { labels?: unknown };
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload.labels) ? payload.labels : [];
  return rows
    .map((row) => normalizeLabelRow(row))
    .filter((row): row is LabelResult => Boolean(row));
}

function normalizeLabelRow(row: unknown): LabelResult | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const item = row as Record<string, unknown>;
  const sampleId = String(item.sample_id || item.sampleId || "").trim();
  if (!sampleId) {
    return null;
  }
  const reason = String(item.reason_short || item.reasonShort || "").trim();
  return {
    sampleId,
    label: normalizeLabel(item.label),
    confidence: normalizeConfidence(item.confidence),
    reasonShort: reason.slice(0, 80) || "auto-labeled"
  };
}

function heuristicLabel(comment: CapturedComment): LabelResult {
  const text = comment.text;
  const negative = /(差|烂|骂|坑|怒|烦|恶心|失望|不满|离谱|抵制|投诉|垃圾|无语|崩溃|讨厌)/u;
  const positive = /(好|棒|赞|喜欢|支持|开心|满意|推荐|优秀|舒服|期待|漂亮|厉害|感动)/u;
  let label: SentimentLabel = "neutral";
  let reasonShort = "无明显情绪，保守标为中性";
  let confidence = 0.55;

  if (negative.test(text)) {
    label = "negative";
    reasonShort = "包含明显负向词";
    confidence = 0.62;
  } else if (positive.test(text)) {
    label = "positive";
    reasonShort = "包含明显正向词";
    confidence = 0.62;
  }

  return {
    sampleId: comment.sampleId,
    label,
    confidence,
    reasonShort
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

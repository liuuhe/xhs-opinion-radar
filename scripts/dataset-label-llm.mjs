#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const VALID_LABELS = new Set(["negative", "neutral", "positive"]);
const DEFAULT_CHUNK_SIZE = 20;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT = `你是网络舆情情绪标注器。任务是把中文社交媒体评论标为 positive、neutral、negative 三类之一。
规则：
1. 只根据评论文本本身的显式情绪判断，不要依赖关键词、帖子标题或外部背景。
2. 表达支持、满意、赞同、开心、鼓励、推荐、喜欢，标为 positive。
3. 客观陈述、信息补充、提问、无明显情绪、正负混合且难以判断，标为 neutral。
4. 表达不满、愤怒、批评、质疑、厌恶、失望、踩雷、不推荐、明显讽刺，标为 negative。
5. “还行但不会再去”“一般”“没必要”“不值”“排队久”“服务差”等弱负面，优先标为 negative。
6. 无法确定时优先选择 neutral。
必须返回严格 JSON，格式为 {"labels":[{"sample_id":"...","label":"positive|neutral|negative","confidence":0.0,"reason_short":"..."}]}。`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.input || !options.output) {
    throw new Error("Usage: node scripts/dataset-label-llm.mjs --input <review.csv> --output <llm.csv>");
  }
  if (!options.localApiUrl && !options.apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Set it in the environment or pass --api-key.");
  }

  const csv = parseCsv(await readFile(options.input, "utf8"));
  requireColumns(csv, ["text", "label"]);
  const rows = csv.rows.map((row) => ({ ...row }));
  const pending = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => normalizeText(row.text) && !VALID_LABELS.has(normalizeText(row.label).toLowerCase()));

  const chunks = chunkArray(pending, options.chunkSize);
  let labeled = 0;
  let failed = 0;

  const labeler = options.localApiUrl ? labelLocalApiChunk : labelOpenAiChunk;
  const activeChunks = options.localApiUrl ? chunkForLocalApi(pending) : chunks;

  await mapWithConcurrency(activeChunks, options.localApiUrl ? 1 : options.concurrency, async (chunk, chunkIndex) => {
    try {
      const labels = await labeler(options, chunk);
      for (const item of chunk) {
        const result = labels.get(sampleId(item.index));
        if (!result) {
          failed += 1;
          continue;
        }
        item.row.label = result.label;
        item.row.notes = mergeNotes(item.row.notes, `llm_confidence=${result.confidence.toFixed(2)}; llm_reason=${result.reasonShort}`);
        labeled += 1;
      }
      console.log(`LLM chunk ${chunkIndex + 1}/${activeChunks.length}: labeled=${chunk.length}`);
    } catch (error) {
      failed += chunk.length;
      console.warn(`LLM chunk ${chunkIndex + 1}/${activeChunks.length} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (options.failFast) {
        throw error;
      }
    }
  });

  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await writeFile(options.output, writeCsv(rows, csv.fieldnames), "utf8");
  console.log(`Wrote ${options.output} (rows=${rows.length}, labeled=${labeled}, failed=${failed}, skipped=${rows.length - pending.length})`);
}

function parseArgs(argv) {
  const options = {
    input: "",
    output: "",
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL,
    model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
    localApiUrl: "",
    chunkSize: DEFAULT_CHUNK_SIZE,
    concurrency: DEFAULT_CONCURRENCY,
    failFast: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [key, inlineValue] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const nextValue = () => inlineValue ?? argv[++index] ?? "";
    switch (key) {
      case "--input":
      case "-i":
        options.input = nextValue();
        break;
      case "--output":
      case "-o":
        options.output = nextValue();
        break;
      case "--api-key":
        options.apiKey = nextValue();
        break;
      case "--base-url":
        options.baseUrl = nextValue();
        break;
      case "--model":
        options.model = nextValue();
        break;
      case "--local-api-url":
        options.localApiUrl = nextValue().replace(/\/+$/, "");
        break;
      case "--chunk-size":
        options.chunkSize = clampNumber(nextValue(), DEFAULT_CHUNK_SIZE, 1, 50);
        break;
      case "--concurrency":
        options.concurrency = clampNumber(nextValue(), DEFAULT_CONCURRENCY, 1, 8);
        break;
      case "--fail-fast":
        options.failFast = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${raw}`);
    }
  }
  options.baseUrl = options.baseUrl.replace(/\/+$/, "");
  return options;
}

function printHelp() {
  console.log(`
Fill label values in a review CSV using an OpenAI-compatible Chat Completions API.

Environment:
  OPENAI_API_KEY   required unless --api-key is provided
  OPENAI_BASE_URL  optional, defaults to ${DEFAULT_BASE_URL}
  OPENAI_MODEL     optional, defaults to ${DEFAULT_MODEL}

Examples:
  npm run dataset:label-llm -- --input "bert/data/archive-wsl/exports/new_samples.review.csv" --output "bert/data/archive-wsl/exports/new_samples.llm.csv"
  npm run dataset:label-llm -- --base-url "https://openrouter.ai/api/v1" --model "openai/gpt-4o-mini" --input "bert/data/archive-wsl/exports/new_samples.review.csv" --output "bert/data/archive-wsl/exports/new_samples.llm.csv"
  npm run dataset:label-llm -- --local-api-url "http://127.0.0.1:8788" --input "bert/data/archive-wsl/exports/new_samples.review.csv" --output "bert/data/archive-wsl/exports/new_samples.llm.csv"
`);
}

async function labelOpenAiChunk(options, chunk) {
  let response = await postChatCompletion(options, chunk, true);
  if (!response.ok) {
    const body = await response.text();
    if ((response.status === 400 || response.status === 422) && body.includes("response_format")) {
      response = await postChatCompletion(options, chunk, false);
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

async function labelLocalApiChunk(options, chunk) {
  const posts = [];
  const postById = new Map();
  for (const item of chunk) {
    const postId = normalizeText(item.row.post_id || `dataset-post-${posts.length + 1}`);
    let post = postById.get(postId);
    if (!post) {
      post = {
        postId,
        url: normalizeText(item.row.post_url || ""),
        title: normalizeText(item.row.source_keyword || "dataset labeling"),
        description: "",
        authorHash: "dataset-labeler",
        tags: [],
        comments: []
      };
      postById.set(postId, post);
      posts.push(post);
    }
    post.comments.push({
      sampleId: sampleId(item.index),
      commentId: normalizeText(item.row.comment_id || sampleId(item.index)),
      postId,
      postUrl: normalizeText(item.row.post_url || post.url || ""),
      text: item.row.text,
      userHash: "dataset-labeler",
      commentLevel: 1,
      captureSource: "dom"
    });
  }

  const response = await fetch(`${options.localApiUrl}/api/analyze/captured`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keyword: "dataset-labeling",
      engine: "llm",
      maxPosts: 30,
      commentsPerPost: 80,
      pageUrl: "dataset-labeling",
      posts
    })
  });
  if (!response.ok) {
    throw new Error(`Local API labeling failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }

  const payload = await response.json();
  const labelsByText = new Map();
  for (const sample of Array.isArray(payload.labeledSamples) ? payload.labeledSamples : []) {
    const textKey = dedupeKey(sample.text || "");
    const label = normalizeText(sample.label || "").toLowerCase();
    if (!textKey || !VALID_LABELS.has(label)) {
      continue;
    }
    labelsByText.set(textKey, {
      label,
      confidence: normalizeConfidence(sample.confidence),
      reasonShort: normalizeText(sample.reasonShort || sample.reason_short || "local-api-llm-labeled").slice(0, 120)
    });
  }

  const labels = new Map();
  for (const item of chunk) {
    const result = labelsByText.get(dedupeKey(item.row.text));
    if (result) {
      labels.set(sampleId(item.index), result);
    }
  }
  return labels;
}

function postChatCompletion(options, chunk, includeResponseFormat) {
  return fetch(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0,
      ...(includeResponseFormat ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify(
            {
              task: "classify_sentiment_for_training_dataset",
              labels: ["positive", "neutral", "negative"],
              samples: chunk.map((item) => ({
                sample_id: sampleId(item.index),
                text: item.row.text
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

function parseLlmResponse(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content.filter((block) => block.type === "text").map((block) => block.text || "").join("\n")
    : String(content || "");
  const parsed = extractJsonObject(text);
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.labels) ? parsed.labels : [];
  if (rows.length === 0) {
    throw new Error("LLM response does not include labels");
  }

  const labels = new Map();
  for (const row of rows) {
    const id = normalizeText(row?.sample_id || row?.sampleId || "");
    const label = normalizeText(row?.label || "").toLowerCase();
    if (!id || !VALID_LABELS.has(label)) {
      continue;
    }
    labels.set(id, {
      label,
      confidence: normalizeConfidence(row?.confidence),
      reasonShort: normalizeText(row?.reason_short || row?.reasonShort || "llm-labeled").slice(0, 120)
    });
  }
  return labels;
}

function extractJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("LLM response is not valid JSON");
  }
}

function parseCsv(content) {
  const text = content.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1].every((value) => value === "")) {
    rows.pop();
  }
  if (rows.length === 0) {
    throw new Error("CSV has no header");
  }

  const fieldnames = rows[0];
  const dataRows = rows.slice(1).map((values) => {
    const item = {};
    for (let index = 0; index < fieldnames.length; index += 1) {
      item[fieldnames[index]] = values[index] ?? "";
    }
    return item;
  });
  return { fieldnames, rows: dataRows };
}

function requireColumns(csv, columns) {
  for (const column of columns) {
    if (!csv.fieldnames.includes(column)) {
      throw new Error(`CSV is missing required column: ${column}`);
    }
  }
}

function writeCsv(rows, fieldnames) {
  const lines = [fieldnames.join(",")];
  for (const row of rows) {
    lines.push(fieldnames.map((field) => csvCell(row[field] ?? "")).join(","));
  }
  return `\uFEFF${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

async function mapWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function chunkForLocalApi(items) {
  const chunks = [];
  let chunk = [];
  let postIds = new Set();
  let countsByPost = new Map();
  for (const item of items) {
    const postId = normalizeText(item.row.post_id || `dataset-post-${item.index + 1}`);
    const nextPostIds = new Set(postIds);
    nextPostIds.add(postId);
    const nextCount = (countsByPost.get(postId) || 0) + 1;
    if (chunk.length > 0 && (nextPostIds.size > 30 || nextCount > 80)) {
      chunks.push(chunk);
      chunk = [];
      postIds = new Set();
      countsByPost = new Map();
    }
    chunk.push(item);
    postIds.add(postId);
    countsByPost.set(postId, (countsByPost.get(postId) || 0) + 1);
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

function mergeNotes(existing, next) {
  return [normalizeText(existing), normalizeText(next)].filter(Boolean).join(" | ");
}

function sampleId(index) {
  return `sample-${index + 1}`;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function dedupeKey(text) {
  return normalizeText(text).toLowerCase();
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, number));
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

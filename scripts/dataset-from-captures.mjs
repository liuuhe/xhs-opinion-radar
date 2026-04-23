#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const FIELDNAMES = ["text", "label", "source_keyword", "post_id", "post_url", "comment_id", "capture_file", "notes"];
const JUNK_TEXT = new Set([
  "展开",
  "收起",
  "回复",
  "评论",
  "点赞",
  "分享",
  "收藏",
  "登录",
  "关注",
  "更多",
  "查看更多",
  "暂无评论",
  "蹲",
  "求链接",
  "链接",
  "在哪",
  "地址",
  "哈哈",
  "哈哈哈"
]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.inputs.length === 0 || !options.output) {
    throw new Error("Usage: node scripts/dataset-from-captures.mjs --input <capture-glob> --output <review.csv>");
  }

  const files = await expandInputs(options.inputs);
  if (files.length === 0) {
    throw new Error(`No capture files matched: ${options.inputs.join(", ")}`);
  }

  const rows = [];
  const seenTexts = new Set();
  const stats = { files: 0, posts: 0, comments: 0, kept: 0, duplicate: 0, filtered: 0 };

  for (const file of files) {
    const payload = JSON.parse(await readFile(file, "utf8"));
    stats.files += 1;
    const keyword = normalizeText(payload.keyword || "");
    const posts = Array.isArray(payload.posts) ? payload.posts : [];
    stats.posts += posts.length;

    for (const post of posts) {
      const comments = Array.isArray(post?.comments) ? post.comments : [];
      stats.comments += comments.length;
      for (const comment of comments) {
        const text = normalizeText(comment?.text || "");
        if (!isUsefulText(text)) {
          stats.filtered += 1;
          continue;
        }
        const key = dedupeKey(text);
        if (seenTexts.has(key)) {
          stats.duplicate += 1;
          continue;
        }
        seenTexts.add(key);
        rows.push({
          text: text.slice(0, 300),
          label: "",
          source_keyword: keyword,
          post_id: normalizeText(post?.postId || comment?.postId || ""),
          post_url: normalizeText(comment?.postUrl || post?.url || ""),
          comment_id: normalizeText(comment?.commentId || ""),
          capture_file: path.basename(file),
          notes: ""
        });
        stats.kept += 1;
      }
    }
  }

  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await writeFile(options.output, writeCsv(rows, FIELDNAMES), "utf8");
  console.log(
    `Wrote ${stats.kept} review rows to ${options.output} ` +
      `(files=${stats.files}, posts=${stats.posts}, comments=${stats.comments}, duplicate=${stats.duplicate}, filtered=${stats.filtered})`
  );
}

function parseArgs(argv) {
  const options = { inputs: [], output: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [key, inlineValue] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const nextValue = () => inlineValue ?? argv[++index] ?? "";
    switch (key) {
      case "--input":
      case "-i":
        options.inputs.push(nextValue());
        break;
      case "--output":
      case "-o":
        options.output = nextValue();
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${raw}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`
Create a manual-label review CSV from capture JSON files.

Example:
  npm run dataset:from-captures -- --input "data/captures/xhs-*-001.json" --output "bert/data/archive-wsl/exports/new_samples.review.csv"
`);
}

async function expandInputs(inputs) {
  const files = [];
  for (const input of inputs) {
    if (!input.includes("*")) {
      files.push(path.resolve(input));
      continue;
    }
    const directory = path.resolve(path.dirname(input));
    const basenamePattern = path.basename(input);
    const matcher = wildcardMatcher(basenamePattern);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && matcher.test(entry.name)) {
        files.push(path.join(directory, entry.name));
      }
    }
  }
  return Array.from(new Set(files)).sort((left, right) => left.localeCompare(right));
}

function wildcardMatcher(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
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

function isUsefulText(text) {
  if (text.length < 2 || text.length > 300) {
    return false;
  }
  if (JUNK_TEXT.has(text)) {
    return false;
  }
  if (/^[\d\s[:：.,，。!！?？~～、/\\|_-]+$/.test(text)) {
    return false;
  }
  if (/^哈{2,}$/.test(text)) {
    return false;
  }
  return true;
}

function dedupeKey(text) {
  return normalizeText(text).toLowerCase();
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

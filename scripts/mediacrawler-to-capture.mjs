#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_OUTPUT_DIR = "data/captures";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const contentFiles = await resolveInputFiles(options.contents, options.inputDir, /(?:^|[/\\])(?:search|detail)_contents_[^/\\]+\.(jsonl|json|csv)$/i);
  const commentFiles = await resolveInputFiles(options.comments, options.inputDir, /(?:^|[/\\])(?:search|detail)_comments_[^/\\]+\.(jsonl|json|csv)$/i);

  if (contentFiles.length === 0 && commentFiles.length === 0) {
    throw new Error("No MediaCrawler contents/comments files found. Pass --input-dir or --contents/--comments.");
  }

  const contentRows = (await Promise.all(contentFiles.map(readStructuredFile))).flat();
  const commentRows = (await Promise.all(commentFiles.map(readStructuredFile))).flat();
  const capture = buildCapture({
    keyword: options.keyword,
    contentRows,
    commentRows,
    maxPosts: options.maxPosts,
    commentsPerPost: options.commentsPerPost,
    pageUrl: options.pageUrl,
    sourceFiles: [...contentFiles, ...commentFiles]
  });

  const output = options.output || defaultOutputPath(capture.keyword);
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, `${JSON.stringify(capture, null, 2)}\n`, "utf8");

  const totalComments = capture.posts.reduce((sum, post) => sum + post.comments.length, 0);
  console.log(`Wrote ${capture.posts.length} posts and ${totalComments} comments to ${output}`);
}

function buildCapture({ keyword, contentRows, commentRows, maxPosts, commentsPerPost, pageUrl, sourceFiles }) {
  const notesById = new Map();
  for (const row of contentRows) {
    const noteId = text(row.note_id || row.noteId || row.id);
    if (!noteId || notesById.has(noteId)) {
      continue;
    }
    notesById.set(noteId, row);
  }

  const commentsByNote = new Map();
  for (const row of commentRows) {
    const noteId = text(row.note_id || row.noteId || row.aweme_id || row.post_id);
    const content = text(row.content || row.comment_text || row.text);
    if (!noteId || !content) {
      continue;
    }
    if (!commentsByNote.has(noteId)) {
      commentsByNote.set(noteId, []);
    }
    commentsByNote.get(noteId).push(row);
  }

  for (const noteId of commentsByNote.keys()) {
    if (!notesById.has(noteId)) {
      notesById.set(noteId, { note_id: noteId });
    }
  }

  const sourceKeyword = text(keyword) || inferKeyword(contentRows, sourceFiles) || "mediacrawler";
  const posts = [];
  for (const [noteId, note] of notesById.entries()) {
    if (posts.length >= maxPosts) {
      break;
    }
    const noteUrl = text(note.note_url || note.noteUrl || note.url) || `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`;
    const postComments = [];
    const seenTexts = new Set();
    for (const comment of commentsByNote.get(noteId) || []) {
      if (postComments.length >= commentsPerPost) {
        break;
      }
      const commentText = text(comment.content || comment.comment_text || comment.text).slice(0, 300);
      const dedupeKey = normalize(commentText);
      if (!commentText || seenTexts.has(dedupeKey)) {
        continue;
      }
      seenTexts.add(dedupeKey);
      const commentId = text(comment.comment_id || comment.commentId || comment.id) || stableId(`${noteId}:${commentText}`, "mc-comment");
      const parentCommentId = text(comment.parent_comment_id || comment.parentCommentId || "");
      postComments.push({
        sampleId: `mediacrawler-${stableId(`${noteId}:${commentId}:${commentText}`, "sample")}`,
        commentId,
        postId: noteId,
        postUrl: noteUrl,
        text: commentText,
        userHash: text(comment.user_id || comment.userId || comment.nickname) || "mediacrawler-user",
        commentLevel: parentCommentId && parentCommentId !== "0" ? 2 : 1,
        captureSource: "network"
      });
    }

    posts.push({
      postId: noteId,
      url: noteUrl,
      title: text(note.title || note.desc || "").slice(0, 160) || `${sourceKeyword} 相关帖子`,
      description: text(note.desc || "").slice(0, 500),
      authorHash: text(note.user_id || note.userId || note.nickname) || "mediacrawler-author",
      tags: parseTags(note.tag_list || note.tagList || note.tags),
      comments: postComments
    });
  }

  return {
    keyword: sourceKeyword,
    maxPosts,
    commentsPerPost,
    pageUrl: text(pageUrl),
    captureSource: "mediacrawler",
    capturedAt: new Date().toISOString(),
    source: {
      name: "MediaCrawler",
      repository: "https://github.com/NanmiCoder/MediaCrawler",
      files: sourceFiles.map((file) => path.basename(file))
    },
    posts
  };
}

function parseArgs(argv) {
  const options = {
    inputDir: "",
    contents: [],
    comments: [],
    output: "",
    keyword: "",
    pageUrl: "",
    maxPosts: 30,
    commentsPerPost: 80,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [key, inlineValue] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const nextValue = () => inlineValue ?? argv[++index] ?? "";
    switch (key) {
      case "--input-dir":
        options.inputDir = nextValue();
        break;
      case "--contents":
        options.contents.push(nextValue());
        break;
      case "--comments":
        options.comments.push(nextValue());
        break;
      case "--output":
      case "-o":
        options.output = nextValue();
        break;
      case "--keyword":
        options.keyword = nextValue();
        break;
      case "--page-url":
        options.pageUrl = nextValue();
        break;
      case "--max-posts":
        options.maxPosts = clamp(Number(nextValue()), 1, 200, 30);
        break;
      case "--comments-per-post":
        options.commentsPerPost = clamp(Number(nextValue()), 0, 500, 80);
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
Convert MediaCrawler Xiaohongshu output into this project's capture JSON.

Examples:
  npm run mediacrawler:to-capture -- --input-dir "../MediaCrawler/data/xhs/jsonl" --keyword "酒店 避雷"
  npm run mediacrawler:to-capture -- --contents "data/xhs/jsonl/search_contents_*.jsonl" --comments "data/xhs/jsonl/search_comments_*.jsonl" --output "data/captures/xhs-mediacrawler-hotel.json"
`);
}

async function resolveInputFiles(explicitInputs, inputDir, fallbackPattern) {
  const explicit = await expandInputs(explicitInputs);
  if (explicit.length > 0 || !inputDir) {
    return explicit;
  }
  const root = path.resolve(inputDir);
  const files = await walkFiles(root);
  return files.filter((file) => fallbackPattern.test(file.replaceAll(path.sep, "/"))).sort((left, right) => left.localeCompare(right));
}

async function expandInputs(inputs) {
  const files = [];
  for (const input of inputs) {
    if (!input.includes("*")) {
      files.push(path.resolve(input));
      continue;
    }
    const directory = path.resolve(path.dirname(input));
    const matcher = wildcardMatcher(path.basename(input));
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && matcher.test(entry.name)) {
        files.push(path.join(directory, entry.name));
      }
    }
  }
  return Array.from(new Set(files)).sort((left, right) => left.localeCompare(right));
}

async function walkFiles(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(fullPath)));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function wildcardMatcher(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

async function readStructuredFile(file) {
  const content = await readFile(file, "utf8");
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jsonl") {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  if (ext === ".json") {
    const parsed = JSON.parse(content || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  if (ext === ".csv") {
    return parseCsv(content);
  }
  throw new Error(`Unsupported MediaCrawler file type: ${file}`);
}

function parseCsv(content) {
  const rows = [];
  const cells = [];
  let current = "";
  let row = [];
  let inQuotes = false;
  const pushCell = () => {
    row.push(current);
    current = "";
  };
  const pushRow = () => {
    cells.push(row);
    row = [];
  };
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      pushCell();
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      pushCell();
      pushRow();
    } else {
      current += char;
    }
  }
  if (current || row.length > 0) {
    pushCell();
    pushRow();
  }
  const [header = [], ...dataRows] = cells.filter((item) => item.some((cell) => cell.trim()));
  const normalizedHeader = header.map((cell) => cell.replace(/^\uFEFF/, "").trim());
  for (const dataRow of dataRows) {
    const item = {};
    normalizedHeader.forEach((key, index) => {
      item[key] = dataRow[index] ?? "";
    });
    rows.push(item);
  }
  return rows;
}

function inferKeyword(contentRows, sourceFiles) {
  for (const row of contentRows) {
    const keyword = text(row.source_keyword || row.keyword);
    if (keyword) {
      return keyword;
    }
  }
  for (const file of sourceFiles) {
    const match = path.basename(file).match(/xhs[-_](.+?)[-_](?:contents|comments)/i);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

function parseTags(value) {
  if (Array.isArray(value)) {
    return value.map(text).filter(Boolean).slice(0, 12);
  }
  const raw = text(value);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(text).filter(Boolean).slice(0, 12);
    }
  } catch {
    // MediaCrawler commonly stores tags as a comma-separated string.
  }
  return raw
    .split(/[,，#\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function stableId(value, prefix) {
  return `${prefix}-${createHash("sha1").update(String(value)).digest("hex").slice(0, 16)}`;
}

function defaultOutputPath(keyword) {
  const safeKeyword = text(keyword).replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "xhs";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return path.join(DEFAULT_OUTPUT_DIR, `xhs-mediacrawler-${safeKeyword}-${stamp}.json`);
}

function normalize(value) {
  return text(value).toLowerCase();
}

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

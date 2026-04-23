#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const VALID_LABELS = new Set(["negative", "neutral", "positive"]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.base || !options.new || !options.output) {
    throw new Error("Usage: node scripts/dataset-merge.mjs --base <train.csv> --new <review.csv> --output <train.v3.csv>");
  }

  const baseCsv = parseCsv(await readFile(options.base, "utf8"));
  const newCsv = parseCsv(await readFile(options.new, "utf8"));
  requireColumns(baseCsv, ["label"]);
  requireColumns(newCsv, ["text", "label"]);

  const baseTextColumn = baseCsv.fieldnames.includes("text_norm") ? "text_norm" : "text";
  if (!baseCsv.fieldnames.includes(baseTextColumn)) {
    throw new Error(`Base CSV must include text or text_norm column: ${options.base}`);
  }

  const outputFieldnames = baseCsv.fieldnames;
  const outputRows = baseCsv.rows.map((row) => ({ ...row }));
  const seenTexts = new Set(outputRows.map((row) => dedupeKey(row[baseTextColumn] || row.text || "")).filter(Boolean));
  const stats = { base: outputRows.length, considered: 0, added: 0, duplicate: 0, emptyLabel: 0, invalidLabel: 0, emptyText: 0 };

  for (const row of newCsv.rows) {
    stats.considered += 1;
    const text = normalizeText(row.text || row.text_norm || "");
    const label = normalizeText(row.label || row.manual_label || "").toLowerCase();
    if (!text) {
      stats.emptyText += 1;
      continue;
    }
    if (!label) {
      stats.emptyLabel += 1;
      continue;
    }
    if (!VALID_LABELS.has(label)) {
      stats.invalidLabel += 1;
      continue;
    }
    const key = dedupeKey(text);
    if (seenTexts.has(key)) {
      stats.duplicate += 1;
      continue;
    }
    seenTexts.add(key);
    outputRows.push(buildOutputRow(outputFieldnames, text, label));
    stats.added += 1;
  }

  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await writeFile(options.output, writeCsv(outputRows, outputFieldnames), "utf8");
  console.log(
    `Wrote ${outputRows.length} rows to ${options.output} ` +
      `(base=${stats.base}, added=${stats.added}, duplicate=${stats.duplicate}, emptyLabel=${stats.emptyLabel}, invalidLabel=${stats.invalidLabel}, emptyText=${stats.emptyText})`
  );
}

function parseArgs(argv) {
  const options = { base: "", new: "", output: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [key, inlineValue] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const nextValue = () => inlineValue ?? argv[++index] ?? "";
    switch (key) {
      case "--base":
        options.base = nextValue();
        break;
      case "--new":
        options.new = nextValue();
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
Merge manually labeled review rows into a training CSV.

Example:
  npm run dataset:merge -- --base "bert/data/archive-wsl/exports/train.corrected.v2.csv" --new "bert/data/archive-wsl/exports/new_samples.review.csv" --output "bert/data/archive-wsl/exports/train.corrected.v3.csv"
`);
}

function requireColumns(csv, columns) {
  for (const column of columns) {
    if (!csv.fieldnames.includes(column)) {
      throw new Error(`CSV is missing required column: ${column}`);
    }
  }
}

function buildOutputRow(fieldnames, text, label) {
  const row = Object.fromEntries(fieldnames.map((field) => [field, ""]));
  if (fieldnames.includes("sample_id")) {
    row.sample_id = `new-${hashText(text)}`;
  }
  if (fieldnames.includes("text_norm")) {
    row.text_norm = text.slice(0, 300);
  } else if (fieldnames.includes("text")) {
    row.text = text.slice(0, 300);
  }
  row.label = label;
  return row;
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

function dedupeKey(text) {
  return normalizeText(text).toLowerCase();
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

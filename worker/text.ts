import type { SentimentLabel } from "../src/shared/types";

const NOISE_TEXTS = new Set(["作者赞过", "置顶", "展开", "查看更多回复", "更多回复"]);

export function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

export function isMeaningfulComment(text: string): boolean {
  const normalized = normalizeText(text);
  if (normalized.length < 2 || normalized.length > 300) {
    return false;
  }
  if (NOISE_TEXTS.has(normalized)) {
    return false;
  }
  return /[\p{Script=Han}A-Za-z0-9]/u.test(normalized);
}

export async function hashIdentifier(value: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${value}`)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function normalizeLabel(value: unknown): SentimentLabel {
  const label = String(value || "").trim().toLowerCase();
  if (label === "positive" || label === "neutral" || label === "negative") {
    return label;
  }
  return "neutral";
}

export function normalizeConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, parsed));
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart !== -1 && objectEnd > objectStart) {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1));
    }

    const arrayStart = trimmed.indexOf("[");
    const arrayEnd = trimmed.lastIndexOf("]");
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1));
    }

    throw new Error("Model output is not JSON");
  }
}

import type { AnalysisDiagnostics, SessionStatusResponse } from "../src/shared/types";
import type { Env } from "./env";

interface StorageStateCookie {
  expires?: number;
}

interface StorageStatePayload {
  cookies?: StorageStateCookie[];
  origins?: unknown[];
}

interface SessionMetadata {
  uploadedAt?: string;
}

interface SessionDiagnosticRecord {
  checkedAt: string;
  diagnostics: AnalysisDiagnostics;
}

export async function getSessionStatus(env: Env): Promise<SessionStatusResponse> {
  const key = getStorageStateKey(env);
  const checkedAt = new Date().toISOString();
  if (!env.PUBLIC_OPINION_KV) {
    return {
      hasSession: false,
      key,
      checkedAt,
      message: "当前环境没有绑定 PUBLIC_OPINION_KV，无法检查登录态。"
    };
  }

  const { value, metadata } = await env.PUBLIC_OPINION_KV.getWithMetadata<SessionMetadata>(key, "text");

  if (!value) {
    return {
      hasSession: false,
      key,
      checkedAt,
      message: `KV key ${key} 暂无登录态。请在本地确认 sessions/xiaohongshu_storage_state.json 已存在后运行 npm run cf:upload-session。`
    };
  }

  const parsed = parseStorageState(value);
  const lastDiagnostic = await getLastSessionDiagnostic(env);
  const expiries = (parsed.cookies || [])
    .map((cookie) => cookie.expires)
    .filter((expires): expires is number => typeof expires === "number" && expires > 0)
    .sort((left, right) => left - right);

  return {
    hasSession: true,
    key,
    checkedAt,
    uploadedAt: metadata?.uploadedAt,
    lastCheckedAt: lastDiagnostic?.checkedAt,
    lastErrorCode: lastDiagnostic?.diagnostics.errorCode,
    lastAdvice: lastDiagnostic?.diagnostics.advice,
    cookieCount: parsed.cookies?.length || 0,
    originCount: parsed.origins?.length || 0,
    storageBytes: new TextEncoder().encode(value).byteLength,
    earliestCookieExpiry: expiries[0] ? new Date(expiries[0] * 1000).toISOString() : undefined,
    latestCookieExpiry: expiries.at(-1) ? new Date(expiries.at(-1)! * 1000).toISOString() : undefined,
    message: buildSessionMessage(key, lastDiagnostic)
  };
}

export async function recordSessionDiagnostic(env: Env, diagnostics: AnalysisDiagnostics): Promise<void> {
  if (!env.PUBLIC_OPINION_KV) {
    return;
  }

  if (!diagnostics.errorCode) {
    await env.PUBLIC_OPINION_KV.delete(getSessionDiagnosticKey(env)).catch(() => undefined);
    return;
  }

  const payload: SessionDiagnosticRecord = {
    checkedAt: new Date().toISOString(),
    diagnostics
  };
  await env.PUBLIC_OPINION_KV.put(getSessionDiagnosticKey(env), JSON.stringify(payload), {
    expirationTtl: 3600
  }).catch(() => undefined);
}

function parseStorageState(value: string): StorageStatePayload {
  try {
    const payload = JSON.parse(value) as StorageStatePayload;
    return {
      cookies: Array.isArray(payload.cookies) ? payload.cookies : [],
      origins: Array.isArray(payload.origins) ? payload.origins : []
    };
  } catch {
    return { cookies: [], origins: [] };
  }
}

function getStorageStateKey(env: Env): string {
  return env.XHS_STORAGE_STATE_KEY || "xhs:storage_state";
}

async function getLastSessionDiagnostic(env: Env): Promise<SessionDiagnosticRecord | null> {
  try {
    const value = await env.PUBLIC_OPINION_KV.get(getSessionDiagnosticKey(env));
    return value ? (JSON.parse(value) as SessionDiagnosticRecord) : null;
  } catch {
    return null;
  }
}

function buildSessionMessage(key: string, lastDiagnostic: SessionDiagnosticRecord | null): string {
  if (lastDiagnostic?.diagnostics.errorCode === "login_required") {
    return `KV key ${key} 已存在，但最近一次远程抓取显示登录态失效。请重新登录并上传 sessions/xiaohongshu_storage_state.json。`;
  }

  return `KV key ${key} 已存在，分析任务会直接复用该登录态。`;
}

function getSessionDiagnosticKey(env: Env): string {
  return `${getStorageStateKey(env)}:last_diagnostic`;
}

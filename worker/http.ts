import { ApiError } from "./env";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

export function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...(init.headers || {})
    }
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonResponse(
      {
        error: error.message,
        details: error.details,
        code: error.code,
        diagnostics: error.diagnostics
      },
      { status: error.status }
    );
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  return jsonResponse(
    {
      error: "分析失败",
      details: message
    },
    { status: 500 }
  );
}

export function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Max-Age": "86400"
    }
  });
}

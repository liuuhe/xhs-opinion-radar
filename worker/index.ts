import type { AnalyzeRequest, ClientCapturedAnalyzeRequest } from "../src/shared/types";
import { analyzeClientCapture, analyzeFixtureRequest } from "./analyze";
import { ApiError, type Env } from "./env";
import { errorResponse, jsonResponse, optionsResponse } from "./http";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return optionsResponse();
    }

    if (url.pathname === "/api/health") {
      return jsonResponse({
        ok: true,
        mode: "local-playwright-capture",
        llmConfigured: Boolean(env.OPENAI_API_KEY),
        bertConfigured: Boolean(env.BERT_INFERENCE_URL),
        fixtureEnabled: ["1", "true", "yes"].includes(String(env.LOCAL_FIXTURE_ENABLED || "").toLowerCase()),
        model: env.OPENAI_MODEL || "gpt-4o-mini"
      });
    }

    if (url.pathname === "/api/analyze" && request.method === "POST") {
      try {
        const body = (await parseJsonBody(request)) as AnalyzeRequest;
        return jsonResponse(await analyzeFixtureRequest(env, body));
      } catch (error) {
        return errorResponse(error);
      }
    }

    if (url.pathname === "/api/analyze/captured" && request.method === "POST") {
      try {
        const body = (await parseJsonBody(request)) as ClientCapturedAnalyzeRequest;
        return jsonResponse(await analyzeClientCapture(env, body));
      } catch (error) {
        return errorResponse(error);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    return new Response(null, { status: 404 });
  }
} satisfies ExportedHandler<Env>;

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "请求体不是合法 JSON");
  }
}

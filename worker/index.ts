import type { AnalyzeRequest, ClientCapturedAnalyzeRequest, RemoteLoginActionRequest } from "../src/shared/types";
import { analyzeClientCapture, analyzeKeyword, streamAnalyzeKeyword } from "./analyze";
import { ApiError, type Env } from "./env";
import { errorResponse, jsonResponse, optionsResponse } from "./http";
import { handleRemoteLoginAction, streamRemoteLogin } from "./login";
import { getSessionStatus } from "./session";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return optionsResponse();
    }

    if (url.pathname === "/api/health") {
      return jsonResponse({
        ok: true,
        browserBinding: Boolean(env.BROWSER),
        kvBinding: Boolean(env.PUBLIC_OPINION_KV),
        llmConfigured: Boolean(env.OPENAI_API_KEY),
        bertConfigured: Boolean(env.BERT_INFERENCE_URL),
        remoteLoginConfigured: Boolean(env.LOGIN_ADMIN_TOKEN),
        fixtureEnabled: ["1", "true", "yes"].includes(String(env.LOCAL_FIXTURE_ENABLED || "").toLowerCase()),
        model: env.OPENAI_MODEL || "gpt-4o-mini"
      });
    }

    if (url.pathname === "/api/analyze/stream" && request.method === "GET") {
      return streamAnalyzeKeyword(env, url);
    }

    if (url.pathname === "/api/analyze" && request.method === "POST") {
      try {
        const body = (await parseJsonBody(request)) as AnalyzeRequest;
        return jsonResponse(await analyzeKeyword(env, body));
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

    if (url.pathname === "/api/session/status" && request.method === "GET") {
      try {
        return jsonResponse(await getSessionStatus(env));
      } catch (error) {
        return errorResponse(error);
      }
    }

    if (url.pathname === "/api/login/stream" && request.method === "GET") {
      return streamRemoteLogin(env, url);
    }

    if (url.pathname === "/api/login/action" && request.method === "POST") {
      try {
        const body = (await parseJsonBody(request)) as RemoteLoginActionRequest;
        return jsonResponse(await handleRemoteLoginAction(env, body));
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

import type { AnalysisDiagnostics, AnalysisErrorCode } from "../src/shared/types";

export interface Env {
  BROWSER: unknown;
  PUBLIC_OPINION_KV: KVNamespace;
  ASSETS?: Fetcher;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  BERT_INFERENCE_URL?: string;
  XHS_STORAGE_STATE_KEY?: string;
  ANALYSIS_CACHE_TTL_SECONDS?: string;
  BROWSER_RATE_LIMIT_COOLDOWN_SECONDS?: string;
  LOCAL_FIXTURE_ENABLED?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: string,
    public readonly code?: AnalysisErrorCode,
    public readonly diagnostics?: AnalysisDiagnostics
  ) {
    super(message);
  }
}

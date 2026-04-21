import type { AnalysisDiagnostics, AnalysisErrorCode } from "../src/shared/types";

export interface Env {
  ASSETS?: Fetcher;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  BERT_INFERENCE_URL?: string;
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

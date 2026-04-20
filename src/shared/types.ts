export type SentimentLabel = "positive" | "neutral" | "negative";
export type AnalysisEngine = "llm" | "bert";
export type AnalysisStage =
  | "started"
  | "searching"
  | "posts_captured"
  | "comments_captured"
  | "labeling"
  | "completed"
  | "failed";
export type AnalysisErrorCode =
  | "missing_storage_state"
  | "login_required"
  | "browser_rate_limited"
  | "search_no_posts"
  | "comment_empty"
  | "llm_failed"
  | "unknown";

export interface AnalyzeRequest {
  keyword: string;
  engine?: AnalysisEngine;
  maxPosts?: number;
  commentsPerPost?: number;
  useFixture?: boolean;
}

export interface ClientCapturedAnalyzeRequest extends AnalyzeRequest {
  pageUrl?: string;
  posts: CapturedPost[];
}

export interface CapturedPost {
  postId: string;
  url: string;
  title: string;
  description: string;
  authorHash: string;
  tags: string[];
  comments: CapturedComment[];
}

export interface CapturedComment {
  sampleId: string;
  commentId: string;
  postId: string;
  postUrl: string;
  text: string;
  userHash: string;
  commentLevel: number;
  captureSource: "network" | "global" | "dom";
}

export interface LabeledSample extends CapturedComment {
  label: SentimentLabel;
  confidence: number;
  reasonShort: string;
  postTitle: string;
}

export interface SentimentBucket {
  label: SentimentLabel;
  count: number;
  ratio: number;
  averageConfidence: number;
}

export interface AnalysisTotals {
  posts: number;
  comments: number;
  validSamples: number;
}

export interface AnalysisDiagnostics {
  errorCode?: AnalysisErrorCode;
  pageUrl?: string;
  pageTitle?: string;
  bodyExcerpt?: string;
  hasLoginGate?: boolean;
  extractedLinkCount?: number;
  networkPayloadCount?: number;
  commentCountsByPost?: Record<string, number>;
  advice?: string;
  retryAfterSeconds?: number;
  cooldownUntil?: string;
}

export interface AnalysisExportInfo {
  jsonFilename: string;
  csvFilename: string;
  markdownFilename: string;
}

export interface AnalysisResponse {
  keyword: string;
  engine: AnalysisEngine;
  capturedAt: string;
  totals: AnalysisTotals;
  distribution: Record<SentimentLabel, SentimentBucket>;
  posts: CapturedPost[];
  labeledSamples: LabeledSample[];
  samples: LabeledSample[];
  warnings: string[];
  summary: string;
  diagnostics?: AnalysisDiagnostics;
  exports: AnalysisExportInfo;
  sourceMode: "live" | "fixture" | "cache" | "client";
}

export interface ApiErrorResponse {
  error: string;
  details?: string;
  code?: AnalysisErrorCode;
  diagnostics?: AnalysisDiagnostics;
  warnings?: string[];
}

export interface AnalysisStreamEvent {
  stage: AnalysisStage;
  message: string;
  progress: number;
  result?: AnalysisResponse;
  error?: string;
  code?: AnalysisErrorCode;
  diagnostics?: AnalysisDiagnostics;
}

export interface SessionStatusResponse {
  hasSession: boolean;
  key: string;
  checkedAt: string;
  uploadedAt?: string;
  lastCheckedAt?: string;
  lastErrorCode?: AnalysisErrorCode;
  lastAdvice?: string;
  cookieCount?: number;
  originCount?: number;
  storageBytes?: number;
  earliestCookieExpiry?: string;
  latestCookieExpiry?: string;
  message: string;
}

export type RemoteLoginStage =
  | "login_started"
  | "login_screenshot"
  | "login_action"
  | "login_authenticated"
  | "login_expired"
  | "login_error";

export interface RemoteLoginStreamEvent {
  stage: RemoteLoginStage;
  message: string;
  progress: number;
  loginId?: string;
  screenshotDataUrl?: string;
  qrImageDataUrl?: string;
  expiresAt?: string;
  savedAt?: string;
  error?: string;
  code?: AnalysisErrorCode | "unauthorized" | "login_in_progress";
}

export interface RemoteLoginActionRequest {
  token: string;
  loginId: string;
  action: "request_code" | "submit_code";
  code?: string;
}

export interface RemoteLoginActionResponse {
  ok: boolean;
  message: string;
  loginId: string;
}

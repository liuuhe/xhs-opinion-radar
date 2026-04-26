export type SentimentLabel = "positive" | "neutral" | "negative";
export type AnalysisEngine = "llm" | "bert";
export type AnalysisErrorCode =
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

export interface AnalysisInsight {
  title: string;
  detail: string;
  tone: "positive" | "neutral" | "negative" | "info";
}

export interface AnalysisReport {
  headline: string;
  executiveSummary: string;
  keyFindings: AnalysisInsight[];
  recommendedActions: string[];
  dataQuality: {
    level: "good" | "limited" | "weak";
    message: string;
  };
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
  insights: AnalysisInsight[];
  report: AnalysisReport;
  diagnostics?: AnalysisDiagnostics;
  exports: AnalysisExportInfo;
  sourceMode: "fixture" | "client";
}

export interface ApiErrorResponse {
  error: string;
  details?: string;
  code?: AnalysisErrorCode;
  diagnostics?: AnalysisDiagnostics;
  warnings?: string[];
}

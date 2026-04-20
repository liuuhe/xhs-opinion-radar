import type {
  AnalysisDiagnostics,
  AnalysisEngine,
  AnalysisResponse,
  AnalysisTotals,
  CapturedPost,
  LabeledSample,
  SentimentBucket,
  SentimentLabel
} from "../src/shared/types";

const LABELS: SentimentLabel[] = ["positive", "neutral", "negative"];

export function buildDistribution(
  samples: LabeledSample[]
): Record<SentimentLabel, SentimentBucket> {
  const total = samples.length || 1;

  return LABELS.reduce(
    (accumulator, label) => {
      const matches = samples.filter((sample) => sample.label === label);
      const confidenceSum = matches.reduce((sum, sample) => sum + sample.confidence, 0);
      accumulator[label] = {
        label,
        count: matches.length,
        ratio: Number((matches.length / total).toFixed(4)),
        averageConfidence: matches.length
          ? Number((confidenceSum / matches.length).toFixed(4))
          : 0
      };
      return accumulator;
    },
    {} as Record<SentimentLabel, SentimentBucket>
  );
}

export function pickRepresentativeSamples(samples: LabeledSample[], perLabel = 4): LabeledSample[] {
  return LABELS.flatMap((label) =>
    samples
      .filter((sample) => sample.label === label)
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, perLabel)
  );
}

export function buildAnalysisResponse(input: {
  keyword: string;
  engine: AnalysisEngine;
  capturedAt: string;
  posts: CapturedPost[];
  labeledSamples: LabeledSample[];
  warnings: string[];
  diagnostics?: AnalysisDiagnostics;
  sourceMode?: "live" | "fixture" | "cache";
}): AnalysisResponse {
  const totals: AnalysisTotals = {
    posts: input.posts.length,
    comments: input.posts.reduce((sum, post) => sum + post.comments.length, 0),
    validSamples: input.labeledSamples.length
  };

  return {
    keyword: input.keyword,
    engine: input.engine,
    capturedAt: input.capturedAt,
    totals,
    distribution: buildDistribution(input.labeledSamples),
    posts: input.posts,
    labeledSamples: input.labeledSamples,
    samples: pickRepresentativeSamples(input.labeledSamples),
    warnings: input.warnings,
    summary: buildSummary({
      keyword: input.keyword,
      distribution: buildDistribution(input.labeledSamples),
      totals,
      diagnostics: input.diagnostics,
      sourceMode: input.sourceMode || "live"
    }),
    diagnostics: input.diagnostics,
    exports: buildExportInfo(input.keyword),
    sourceMode: input.sourceMode || "live"
  };
}

export function buildSummary(input: {
  keyword: string;
  distribution: Record<SentimentLabel, SentimentBucket>;
  totals: AnalysisTotals;
  diagnostics?: AnalysisDiagnostics;
  sourceMode: "live" | "fixture" | "cache";
}): string {
  if (input.totals.validSamples === 0) {
    const advice = input.diagnostics?.advice || "建议检查登录态、关键词结果和页面结构后重试。";
    return `“${input.keyword}”暂未获得可分析评论样本。${advice}`;
  }

  const dominant = Object.values(input.distribution).sort((left, right) => right.count - left.count)[0];
  const labelName = {
    positive: "正向",
    neutral: "中性",
    negative: "负向"
  }[dominant.label];
  const sourceNote = input.sourceMode === "fixture" ? "当前为本地演示数据，" : "";
  return `${sourceNote}“${input.keyword}”共分析 ${input.totals.validSamples} 条评论，${labelName}情绪占比最高（${Math.round(
    dominant.ratio * 100
  )}%）。样本来自 ${input.totals.posts} 篇帖子，结论应结合抓取样本量和平台个性化推荐偏差解读。`;
}

function buildExportInfo(keyword: string) {
  const safeKeyword = keyword.replace(/[^\p{Script=Han}\w-]+/gu, "-").slice(0, 40) || "keyword";
  return {
    jsonFilename: `public-opinion-${safeKeyword}.json`,
    csvFilename: `public-opinion-${safeKeyword}.csv`,
    markdownFilename: `public-opinion-${safeKeyword}.md`
  };
}

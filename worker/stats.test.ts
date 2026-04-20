import { describe, expect, it } from "vitest";
import type { LabeledSample } from "../src/shared/types";
import { buildAnalysisResponse, buildDistribution, pickRepresentativeSamples } from "./stats";

const baseSample = {
  sampleId: "s1",
  commentId: "c1",
  postId: "p1",
  postUrl: "https://example.com/p1",
  text: "很好",
  userHash: "u1",
  commentLevel: 1,
  captureSource: "dom" as const,
  postTitle: "post"
};

describe("sentiment statistics", () => {
  it("builds distribution with counts, ratios, and average confidence", () => {
    const samples: LabeledSample[] = [
      { ...baseSample, sampleId: "s1", label: "positive", confidence: 0.9, reasonShort: "good" },
      { ...baseSample, sampleId: "s2", label: "neutral", confidence: 0.7, reasonShort: "flat" },
      { ...baseSample, sampleId: "s3", label: "negative", confidence: 0.8, reasonShort: "bad" },
      { ...baseSample, sampleId: "s4", label: "negative", confidence: 0.6, reasonShort: "bad" }
    ];

    const distribution = buildDistribution(samples);

    expect(distribution.positive.count).toBe(1);
    expect(distribution.negative.ratio).toBe(0.5);
    expect(distribution.negative.averageConfidence).toBe(0.7);
  });

  it("selects high-confidence representative samples by label", () => {
    const samples: LabeledSample[] = [
      { ...baseSample, sampleId: "s1", label: "positive", confidence: 0.5, reasonShort: "good" },
      { ...baseSample, sampleId: "s2", label: "positive", confidence: 0.9, reasonShort: "great" },
      { ...baseSample, sampleId: "s3", label: "neutral", confidence: 0.7, reasonShort: "flat" }
    ];

    const selected = pickRepresentativeSamples(samples, 1);

    expect(selected.map((sample) => sample.sampleId)).toEqual(["s2", "s3"]);
  });

  it("builds the public analysis response shape", () => {
    const sample: LabeledSample = {
      ...baseSample,
      label: "positive",
      confidence: 0.9,
      reasonShort: "good"
    };

    const response = buildAnalysisResponse({
      keyword: "咖啡",
      engine: "llm",
      capturedAt: "2026-04-20T00:00:00.000Z",
      posts: [
        {
          postId: "p1",
          url: "https://example.com/p1",
          title: "post",
          description: "",
          authorHash: "",
          tags: [],
          comments: [sample]
        }
      ],
      labeledSamples: [sample],
      warnings: []
    });

    expect(response.totals.posts).toBe(1);
    expect(response.totals.comments).toBe(1);
    expect(response.distribution.positive.ratio).toBe(1);
    expect(response.summary).toContain("咖啡");
    expect(response.labeledSamples).toHaveLength(1);
    expect(response.exports.jsonFilename).toContain("咖啡");
  });
});

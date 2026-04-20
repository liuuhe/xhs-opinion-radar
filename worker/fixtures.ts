import type { AnalysisEngine, AnalysisResponse, CapturedPost, LabeledSample } from "../src/shared/types";
import { buildAnalysisResponse } from "./stats";

const fixturePosts: CapturedPost[] = [
  {
    postId: "fixture-p1",
    url: "https://www.xiaohongshu.com/explore/fixture-p1",
    title: "春日咖啡探店，拿铁香气很稳",
    description: "店内环境舒服，适合周末短暂停留。",
    authorHash: "fixture-author-1",
    tags: ["#咖啡", "#探店", "#拿铁"],
    comments: [
      comment("fixture-c1", "fixture-p1", "这家拿铁真的很顺滑，服务也很耐心，下次还会去。"),
      comment("fixture-c2", "fixture-p1", "环境不错，但是排队时间有点久。"),
      comment("fixture-c3", "fixture-p1", "价格略高，不过味道确实稳定。"),
      comment("fixture-c4", "fixture-p1", "拍照很好看，适合周末和朋友坐一会儿。"),
      comment("fixture-c5", "fixture-p1", "杯子有点小，性价比一般。"),
      comment("fixture-c6", "fixture-p1", "店员推荐的豆子很香，挺惊喜的。")
    ]
  },
  {
    postId: "fixture-p2",
    url: "https://www.xiaohongshu.com/explore/fixture-p2",
    title: "通勤路上的平价咖啡测评",
    description: "对比几家连锁品牌的美式和冷萃。",
    authorHash: "fixture-author-2",
    tags: ["#通勤咖啡", "#美式"],
    comments: [
      comment("fixture-c7", "fixture-p2", "每天早上来一杯很方便，出杯速度快。"),
      comment("fixture-c8", "fixture-p2", "冷萃偏酸，我个人不是很喜欢。"),
      comment("fixture-c9", "fixture-p2", "优惠券之后价格可以接受。"),
      comment("fixture-c10", "fixture-p2", "门店太吵了，坐着办公不太合适。"),
      comment("fixture-c11", "fixture-p2", "美式口味中规中矩，没有特别惊艳。"),
      comment("fixture-c12", "fixture-p2", "外带杯密封很好，通勤不容易洒。")
    ]
  },
  {
    postId: "fixture-p3",
    url: "https://www.xiaohongshu.com/explore/fixture-p3",
    title: "手冲咖啡入门器具分享",
    description: "从滤杯、手冲壶到磨豆机的基础选择。",
    authorHash: "fixture-author-3",
    tags: ["#手冲咖啡", "#咖啡器具"],
    comments: [
      comment("fixture-c13", "fixture-p3", "讲得很清楚，新手照着买不容易踩坑。"),
      comment("fixture-c14", "fixture-p3", "磨豆机预算还是有点高，先收藏。"),
      comment("fixture-c15", "fixture-p3", "终于知道为什么之前总是萃取过度了。"),
      comment("fixture-c16", "fixture-p3", "内容实用，比很多广告帖靠谱。"),
      comment("fixture-c17", "fixture-p3", "滤纸推荐可以再多一点。"),
      comment("fixture-c18", "fixture-p3", "看完想马上试试浅烘豆。")
    ]
  },
  {
    postId: "fixture-p4",
    url: "https://www.xiaohongshu.com/explore/fixture-p4",
    title: "某网红咖啡店踩雷记录",
    description: "排队很久，但体验没有达到预期。",
    authorHash: "fixture-author-4",
    tags: ["#避雷", "#咖啡店"],
    comments: [
      comment("fixture-c19", "fixture-p4", "我也觉得有点失望，味道很普通。"),
      comment("fixture-c20", "fixture-p4", "服务态度一般，问问题也不太耐烦。"),
      comment("fixture-c21", "fixture-p4", "装修确实好看，但咖啡不值这个价格。"),
      comment("fixture-c22", "fixture-p4", "排队一个小时真的离谱。"),
      comment("fixture-c23", "fixture-p4", "可能适合拍照，不适合认真喝咖啡。"),
      comment("fixture-c24", "fixture-p4", "我去的时候还可以，可能不同门店差异大。")
    ]
  },
  {
    postId: "fixture-p5",
    url: "https://www.xiaohongshu.com/explore/fixture-p5",
    title: "办公室咖啡机使用一个月反馈",
    description: "记录自动咖啡机的维护、豆耗和口味反馈。",
    authorHash: "fixture-author-5",
    tags: ["#办公室咖啡", "#咖啡机"],
    comments: [
      comment("fixture-c25", "fixture-p5", "公司有咖啡机真的幸福感提升。"),
      comment("fixture-c26", "fixture-p5", "清洁频率太高会有点麻烦。"),
      comment("fixture-c27", "fixture-p5", "豆子换了以后味道提升明显。"),
      comment("fixture-c28", "fixture-p5", "机器噪音有点大，早会前会影响别人。"),
      comment("fixture-c29", "fixture-p5", "总体满意，比外卖咖啡省钱。"),
      comment("fixture-c30", "fixture-p5", "维护成本需要提前算进去。")
    ]
  }
];

const labels: Record<string, Pick<LabeledSample, "label" | "confidence" | "reasonShort">> = {
  "fixture-c1": { label: "positive", confidence: 0.91, reasonShort: "表达味道和服务满意" },
  "fixture-c2": { label: "neutral", confidence: 0.74, reasonShort: "正负信息混合" },
  "fixture-c3": { label: "neutral", confidence: 0.76, reasonShort: "价格和味道评价并列" },
  "fixture-c4": { label: "positive", confidence: 0.88, reasonShort: "认可环境和社交场景" },
  "fixture-c5": { label: "negative", confidence: 0.82, reasonShort: "表达性价比不满" },
  "fixture-c6": { label: "positive", confidence: 0.87, reasonShort: "表达惊喜和认可" },
  "fixture-c7": { label: "positive", confidence: 0.84, reasonShort: "认可便利和效率" },
  "fixture-c8": { label: "negative", confidence: 0.81, reasonShort: "明确表达不喜欢" },
  "fixture-c9": { label: "neutral", confidence: 0.72, reasonShort: "客观描述价格条件" },
  "fixture-c10": { label: "negative", confidence: 0.86, reasonShort: "表达环境噪音不满" },
  "fixture-c11": { label: "neutral", confidence: 0.8, reasonShort: "中规中矩评价" },
  "fixture-c12": { label: "positive", confidence: 0.83, reasonShort: "认可外带体验" },
  "fixture-c13": { label: "positive", confidence: 0.9, reasonShort: "明确认可内容质量" },
  "fixture-c14": { label: "neutral", confidence: 0.73, reasonShort: "预算顾虑但无强烈情绪" },
  "fixture-c15": { label: "positive", confidence: 0.86, reasonShort: "获得帮助的正向反馈" },
  "fixture-c16": { label: "positive", confidence: 0.89, reasonShort: "认可实用和靠谱" },
  "fixture-c17": { label: "neutral", confidence: 0.78, reasonShort: "提出补充建议" },
  "fixture-c18": { label: "positive", confidence: 0.85, reasonShort: "表达尝试意愿" },
  "fixture-c19": { label: "negative", confidence: 0.86, reasonShort: "表达失望" },
  "fixture-c20": { label: "negative", confidence: 0.9, reasonShort: "批评服务态度" },
  "fixture-c21": { label: "negative", confidence: 0.88, reasonShort: "认为价格不值" },
  "fixture-c22": { label: "negative", confidence: 0.91, reasonShort: "强烈不满排队时间" },
  "fixture-c23": { label: "neutral", confidence: 0.7, reasonShort: "区分拍照和饮用场景" },
  "fixture-c24": { label: "neutral", confidence: 0.74, reasonShort: "提供差异解释" },
  "fixture-c25": { label: "positive", confidence: 0.88, reasonShort: "表达幸福感提升" },
  "fixture-c26": { label: "negative", confidence: 0.76, reasonShort: "指出维护麻烦" },
  "fixture-c27": { label: "positive", confidence: 0.84, reasonShort: "认可口味提升" },
  "fixture-c28": { label: "negative", confidence: 0.83, reasonShort: "指出噪音影响" },
  "fixture-c29": { label: "positive", confidence: 0.86, reasonShort: "总体满意" },
  "fixture-c30": { label: "neutral", confidence: 0.72, reasonShort: "提醒计算成本" }
};

export function buildFixtureAnalysis(input: {
  keyword: string;
  engine: AnalysisEngine;
  maxPosts: number;
  commentsPerPost: number;
}): AnalysisResponse {
  const posts = fixturePosts.slice(0, input.maxPosts).map((post) => ({
    ...post,
    title: post.title.replace("咖啡", input.keyword),
    description: post.description.replace("咖啡", input.keyword),
    comments: post.comments.slice(0, input.commentsPerPost)
  }));

  const titleByPostId = new Map(posts.map((post) => [post.postId, post.title]));
  const labeledSamples: LabeledSample[] = posts.flatMap((post) =>
    post.comments.map((commentItem) => ({
      ...commentItem,
      ...(labels[commentItem.commentId] || {
        label: "neutral",
        confidence: 0.6,
        reasonShort: "演示样本保守标注"
      }),
      postTitle: titleByPostId.get(commentItem.postId) || "演示帖子"
    }))
  );

  return buildAnalysisResponse({
    keyword: input.keyword,
    engine: input.engine,
    capturedAt: new Date().toISOString(),
    posts,
    labeledSamples,
    warnings: ["当前结果来自本地 fixture 演示数据，仅用于开发和答辩彩排。"],
    diagnostics: {
      advice: "本地 fixture 模式已启用，线上环境不会自动使用该数据。",
      extractedLinkCount: posts.length,
      networkPayloadCount: 0,
      commentCountsByPost: Object.fromEntries(posts.map((post) => [post.postId, post.comments.length]))
    },
    sourceMode: "fixture"
  });
}

function comment(commentId: string, postId: string, text: string) {
  return {
    sampleId: `fixture-sample-${commentId}`,
    commentId,
    postId,
    postUrl: `https://www.xiaohongshu.com/explore/${postId}`,
    text,
    userHash: `fixture-user-${commentId}`,
    commentLevel: 1,
    captureSource: "dom" as const
  };
}

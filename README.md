# Public Opinion Pipeline

小红书关键词舆情分析项目。当前架构保持精简：

- 本地 Playwright：负责登录、搜索帖子、打开详情页、滚动评论区和生成采集 JSON。
- Cloudflare Worker：只接收本地采集 JSON，执行 LLM/BERT 情绪标注并返回报告。
- React Web：展示本地采集命令、上传 JSON、查看图表、样本和导出报告。

这样避免 Cloudflare Browser Run 的 429 限流，也避免 Chrome 扩展依赖小红书前端 DOM 跳转。

## Quick Start

安装依赖：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
playwright install chromium
npm install
```

首次登录小红书，保存本机浏览器登录态：

```bash
python -m app doctor_browser
python -m app login
```

采集关键词并直接请求线上 Worker 分析：

```bash
python -m app collect \
  --keyword "咖啡" \
  --posts 10 \
  --comments 30 \
  --worker-url https://public-opinion-cloudflare.liuuhe.workers.dev \
  --engine llm
```

输出文件：

- `data/captures/public-opinion-<关键词>-capture.json`：本地 Playwright 采集结果，可上传到网页重新分析。
- `data/reports/public-opinion-<关键词>-analysis.json`：Worker 分析结果，可上传到网页直接查看报告。

## Cloudflare

配置 LLM secret：

```bash
wrangler secret put OPENAI_API_KEY
```

如果使用 OpenRouter 或其他 OpenAI 兼容服务，在 `wrangler.jsonc` 中配置：

```json
{
  "vars": {
    "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
    "OPENAI_MODEL": "openai/gpt-4o-mini"
  }
}
```

本地开发与部署：

```bash
npm run dev
npm run build
npm run deploy
```

网页默认支持两种输入：

- 上传 `data/captures/*-capture.json`：网页会调用 `/api/analyze/captured` 生成新报告。
- 上传 `data/reports/*-analysis.json`：网页直接渲染已生成报告，适合答辩复现。

## API

`POST /api/analyze/captured`

请求体：

```json
{
  "keyword": "咖啡",
  "engine": "llm",
  "maxPosts": 10,
  "commentsPerPost": 30,
  "pageUrl": "https://www.xiaohongshu.com/search_result?...",
  "posts": [
    {
      "postId": "note id",
      "url": "https://www.xiaohongshu.com/explore/...",
      "title": "帖子标题",
      "description": "正文摘要",
      "authorHash": "匿名作者标识",
      "tags": ["#咖啡"],
      "comments": [
        {
          "sampleId": "sample id",
          "commentId": "comment id",
          "postId": "note id",
          "postUrl": "https://www.xiaohongshu.com/explore/...",
          "text": "评论文本",
          "userHash": "匿名用户标识",
          "commentLevel": 1,
          "captureSource": "network"
        }
      ]
    }
  ]
}
```

`POST /api/analyze` 仅在 `LOCAL_FIXTURE_ENABLED=true` 时返回 fixture 演示报告；真实抓取统一走本地 Playwright。

## Notes

- 采集基于个人登录态和小红书个性化推荐，论文和答辩中需要说明样本偏差。
- 若小红书要求扫码、短信或滑块验证，直接在本地 Playwright 弹出的浏览器中完成，再继续执行采集。
- BERT 模式需要配置 `BERT_INFERENCE_URL` 指向外部 HTTP 推理服务；Worker 不运行本地 PyTorch 模型。
- Chrome 扩展和 Cloudflare Browser Run 链路已移除，避免多套不稳定采集路径同时维护。

# Public Opinion Pipeline

小红书关键词舆情分析项目。实际使用优先走浏览器插件：在用户自己的登录态里采集帖子和评论，发送到 Cloudflare Worker 分析，再在网页端查看和导出报告。补充 dataset 时优先使用 MediaCrawler，本项目只负责把它的输出转换成可分析的 capture JSON。

线上入口：

```text
https://opinion.liuhe.me
```

本地入口也可独立运行，不依赖 Cloudflare：

```powershell
npm run local
```

打开：

```text
http://127.0.0.1:8788
```

完整本地运行说明见 `docs/local-runtime.md`。

## Main Flow

1. 在 Chrome/Edge 扩展管理页启用开发者模式。
2. 选择“加载已解压的扩展程序”，目录选择 `browser-extension`。
3. 在正常浏览器里登录小红书，打开小红书页面。
4. 点击扩展，填写关键词、帖子数、每帖评论数和随机延迟。
5. 点击“自动逐帖”，插件会复用当前登录态逐帖采集评论。
6. 采集完成后点击“发送分析”，或“导出数据”后在网页工作台导入。
7. 在网页中查看摘要、关键发现、情绪分布、样本评论，并导出 JSON、Markdown、CSV 或 PDF。

插件默认 Worker 地址保持为：

```text
https://opinion.liuhe.me
```

## Web App

网页支持两种 JSON 输入：

- 插件导出的 `xhs-opinion-*-capture.json`：调用 `/api/analyze/captured` 生成新报告。
- Worker 返回的 analysis JSON：直接渲染已生成报告，适合答辩复现和归档。

本地开发与部署：

```bash
npm install
npm run dev
npm run build
npm run deploy
```

## Worker API

`POST /api/analyze/captured`

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

Health endpoints:

```text
GET /api/health
GET /api/bert/health
```

`POST /api/analyze` 仅在 `LOCAL_FIXTURE_ENABLED=true` 时返回 fixture 演示报告。

## BERT Status

当前线上最佳模型先作为可交付基线：

| Metric | Value |
| --- | ---: |
| Test macro F1 | 0.8295 |
| Test accuracy | 0.8542 |
| Negative F1 | 0.7727 |
| Neutral F1 | 0.8946 |
| Positive F1 | 0.8212 |

最近的 LLM 预标注 v3 训练没有超过该基线，因此不部署、不替换线上模型。后续新模型只有在冻结测试集上超过 `test_macro_f1 = 0.8295`，才进入 ONNX export、package 和 Cloudflare Containers 部署。

Cloudflare Containers 部署：

```bash
npm run deploy:bert:cf
```

如果本机不想安装 Docker，可以运行：

```bash
npm run package:bert:model
```

然后把 `.deploy/xhs-bert-sentiment.zip` 上传到 GitHub Release `bert-model`，再手动运行 GitHub Actions 里的 `Deploy Cloudflare Containers`。

## MediaCrawler Dataset Collector

小红书采集训练数据时优先使用本仓库 vendored 的 MediaCrawler 小红书子集。源码位于 `vendor/mediacrawler-xhs`，保留原项目 LICENSE，只保留本项目需要的小红书路径。

```powershell
npm run mediacrawler:xhs -- --keywords "酒店 避雷" --max_comments_count_singlenotes 80
```

采集完成后，把 MediaCrawler 的 `contents/comments` 输出转换为 capture JSON：

```powershell
npm run mediacrawler:to-capture -- --input-dir "data\mediacrawler\xhs\jsonl" --keyword "酒店 避雷" --output "data/captures/xhs-mediacrawler-酒店-避雷.json"
```

也可以显式指定文件：

```powershell
npm run mediacrawler:to-capture -- `
  --contents "data\mediacrawler\xhs\jsonl\search_contents_2026-04-26.jsonl" `
  --comments "data\mediacrawler\xhs\jsonl\search_comments_2026-04-26.jsonl" `
  --keyword "酒店 避雷" `
  --output "data/captures/xhs-mediacrawler-酒店-避雷.json"
```

生成的 JSON 可直接上传网页分析，也可进入 dataset 流水线。更详细说明见 `docs/mediacrawler-integration.md`。

## Dataset Loop

从 capture JSON 生成待标注样本：

```powershell
npm run dataset:from-captures -- --input "data/captures/xhs-*-001.json" --output "bert/data/archive-wsl/exports/new_samples.review.csv"
```

用 LLM 预标注：

```powershell
npm run dataset:label-llm -- --input "bert/data/archive-wsl/exports/new_samples.review.csv" --output "bert/data/archive-wsl/exports/new_samples.llm.csv" --worker-url "https://opinion.liuhe.me"
```

合并到训练集：

```powershell
npm run dataset:merge -- --base "bert/data/archive-wsl/exports/train.corrected.v2.csv" --new "bert/data/archive-wsl/exports/new_samples.llm.csv" --output "bert/data/archive-wsl/exports/train.corrected.v3.csv"
```

GPU 训练验证：

```powershell
cd bert
.\.venv\Scripts\python.exe train.py `
  --data data/archive-wsl/exports/train.corrected.v3.csv `
  --eval-data data/archive-wsl/exports/val.corrected.v2.csv `
  --test-data data/archive-wsl/exports/test.corrected.v2.csv `
  --output models/xhs-bert-sentiment-v3 `
  --epochs 5 `
  --batch-size 16 `
  --eval-batch-size 32 `
  --learning-rate 2e-5 `
  --warmup-ratio 0.1 `
  --max-length 256 `
  --seed 42 `
  --class-weights none
```

验证集和测试集继续冻结。LLM 标签只能作为预标注候选，不能默认视为真实标签；如果新模型没有超过线上基线，不部署。

## Notes

- 采集基于个人登录态和小红书个性化推荐，论文和答辩中需要说明样本偏差。
- 若小红书要求扫码、短信或滑块验证，直接在日常浏览器中完成，再重新运行插件采集。
- 采集保持单线程和随机延迟，不做绕过平台风控的并发或反爬逻辑。
- MediaCrawler 使用非商业学习许可；vendored 代码保留在 `vendor/mediacrawler-xhs`，使用前需要确认场景符合其 LICENSE。

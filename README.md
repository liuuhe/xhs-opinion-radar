# Public Opinion Local Pipeline

小红书关键词舆情分析本地工作台。当前产品路径是：

```text
MediaCrawler 采集 -> capture JSON -> 本地 BERT/LLM 分析 -> WebUI 报告导出
```

旧的远端部署路径不再作为项目主流程。

## 一键启动

```powershell
npm run local
```

打开：

```text
http://127.0.0.1:8788
```

一键启动会构建本地前端、启动本地 BERT、启动本地 WebUI/API，并自动打开浏览器。

常用参数：

```powershell
npm run local -- -SkipBuild
npm run local -- -NoBrowser
npm run local -- -Runtime torch
npm run local -- -BertPort 7860 -WebPort 8788
```

## WebUI 功能

- 在页面中填写关键词、帖子数、每帖评论数。
- 点击“开始采集”，由本地 WebUI 启动 vendored MediaCrawler。
- 采集完成后自动转换为 `data/captures/*.json`。
- 点击“载入结果”，再用本地 BERT 或本地 LLM 生成报告。
- 报告支持 JSON、Markdown、CSV 和打印 PDF。

## 命令行采集

如果不通过 WebUI，也可以直接运行：

```powershell
npm run mediacrawler:xhs -- --keywords "酒店 避雷" --max_notes_count 10 --max_comments_count_singlenotes 80
```

转换为 capture JSON：

```powershell
npm run mediacrawler:to-capture -- --input-dir "data\mediacrawler\xhs\jsonl" --keyword "酒店 避雷" --output "data\captures\xhs-mediacrawler-酒店-避雷.json"
```

## Dataset Loop

从 capture JSON 生成待标注样本：

```powershell
npm run dataset:from-captures -- --input "data/captures/*.json" --output "bert/data/archive-wsl/exports/new_samples.review.csv"
```

LLM 预标注：

```powershell
npm run dataset:label-llm -- --input "bert/data/archive-wsl/exports/new_samples.review.csv" --output "bert/data/archive-wsl/exports/new_samples.llm.csv"
```

合并到训练集：

```powershell
npm run dataset:merge -- --base "bert/data/archive-wsl/exports/train.corrected.v2.csv" --new "bert/data/archive-wsl/exports/new_samples.llm.csv" --output "bert/data/archive-wsl/exports/train.corrected.v3.csv"
```

## BERT Baseline

当前最佳模型先作为本地分析基线：

| Metric | Value |
| --- | ---: |
| Test macro F1 | 0.8295 |
| Test accuracy | 0.8542 |
| Negative F1 | 0.7727 |
| Neutral F1 | 0.8946 |
| Positive F1 | 0.8212 |

最近的 LLM 预标注 v3 训练没有超过该基线，因此暂不替换当前模型。后续优化重点仍然是数据质量，尤其是负向和中性评论边界。

## Notes

- MediaCrawler 使用非商业学习许可，见 `vendor/mediacrawler-xhs/LICENSE`。
- 采集保持低并发，默认 `--max_concurrency_num 1`。
- 如果小红书要求扫码、短信或滑块验证，在 MediaCrawler 打开的真实浏览器里完成后继续。

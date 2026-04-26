# Project Status

## Current Direction

项目已收口为全本地运行方案：

```text
MediaCrawler -> capture JSON -> local BERT/LLM -> WebUI report
```

旧的远端部署和自研采集路径不再作为当前产品路径。

## Implemented

- 一键本地启动：`npm run local`
- 本地 BERT FastAPI：`npm run local:bert`
- 本地 WebUI/API：`npm run local:webui`
- WebUI 内置 MediaCrawler 启动、状态日志、结果载入。
- MediaCrawler 输出转换：`npm run mediacrawler:to-capture`
- Dataset 补充流水线：from-captures、LLM 预标注、merge。

## Model Baseline

当前最佳模型作为本地分析基线：

| Metric | Value |
| --- | ---: |
| Test macro F1 | 0.8295 |
| Test accuracy | 0.8542 |
| Negative F1 | 0.7727 |
| Neutral F1 | 0.8946 |
| Positive F1 | 0.8212 |

LLM 预标注 v3 训练没有超过该基线，因此不替换当前模型。后续优化优先补充和复核数据。

## Next Useful Work

- 用 MediaCrawler 收集更多跨主题评论。
- 对 LLM 预标注结果抽样人工复核。
- 针对负向/中性混淆补充样本。
- 只有新模型超过冻结测试集 `test_macro_f1 = 0.8295` 时才替换本地默认模型。

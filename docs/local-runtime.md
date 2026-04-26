# Local Runtime

项目现在可以完全本地运行：

- WebUI：Vite 构建后由本地 Node API 服务托管。
- 采集：`vendor/mediacrawler-xhs` 中的 MediaCrawler 小红书子集。
- 分析：本地 `bert/app.py` FastAPI 服务，或本地 WebUI 通过 `OPENAI_API_KEY` 调用 LLM。
- 输出：报告 JSON、Markdown、CSV、打印 PDF，以及可进入 dataset 流水线的 capture JSON。

## 一键启动

```powershell
npm run local
```

启动完成后打开：

```text
http://127.0.0.1:8788
```

常用参数：

```powershell
npm run local -- -SkipBuild
npm run local -- -NoBrowser
npm run local -- -Runtime torch
npm run local -- -Runtime onnx
npm run local -- -BertPort 7860 -WebPort 8788
```

日志位置：

```text
.local\logs
```

## 分开启动

先启动本地 BERT：

```powershell
npm run local:bert
```

再启动本地 WebUI：

```powershell
npm run local:webui
```

默认模型目录：

```text
bert\models\xhs-bert-sentiment-oldflow-v2-seed42-e5-b16-lr2e5
```

默认 `BERT_RUNTIME=torch`，本机 CUDA PyTorch 可用时会使用 GPU。

## MediaCrawler

WebUI 可以直接启动 MediaCrawler。命令行等价写法：

```powershell
npm run mediacrawler:xhs -- --keywords "酒店 避雷" --max_notes_count 10 --max_comments_count_singlenotes 80
```

默认输出：

```text
data\mediacrawler\xhs\jsonl
```

转换 capture JSON：

```powershell
npm run mediacrawler:to-capture -- `
  --input-dir "data\mediacrawler\xhs\jsonl" `
  --keyword "酒店 避雷" `
  --output "data\captures\xhs-mediacrawler-酒店-避雷.json"
```

## LLM 标注

如果使用 LLM，需要设置：

```powershell
$env:OPENAI_API_KEY = "..."
$env:OPENAI_MODEL = "gpt-4o-mini"
npm run local
```

未配置 `OPENAI_API_KEY` 时，WebUI 会使用保守规则兜底，适合调试流程，不适合作为最终标签。

# Local Runtime

项目完全本地运行：

- WebUI：Vite 构建后由本地 Node API 服务托管。
- 采集：`vendor/mediacrawler-xhs` 中的 MediaCrawler 小红书子集。
- 分析：本地 `bert/app.py` FastAPI 服务。
- 输出：报告 JSON、Markdown、CSV、打印 PDF，以及可进入 dataset 流水线的 capture JSON。

## 一键启动

```powershell
npm run local
```

```powershell
npm run local:stop
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

转换 capture JSON：

```powershell
npm run mediacrawler:to-capture -- `
  --input-dir "data\mediacrawler\xhs\jsonl" `
  --keyword "酒店 避雷" `
  --output "data\captures\xhs-mediacrawler-酒店-避雷.json"
```

WebUI 的文件上传也支持直接导入 MediaCrawler 原始 `search_comments_*.jsonl`、`search_contents_*.jsonl`、`.json` 或 `.csv` 文件，导入时会先自动转换成 capture JSON。
MediaCrawler 采集结束后，WebUI 也会自动把转换后的 capture JSON 载入分析区，不需要再手动载入结果。

WebUI 的“暂停采集”会停止当前 crawler 进程，并尝试把已经写入的 JSONL 转换成 capture JSON。如果日志持续显示 CDP 端口不可访问，需要先用远程调试端口启动 Chrome/Edge，或关闭 MediaCrawler 的“连接已有浏览器”配置。
现在 WebUI 会在开始采集前自动启动带 `--remote-debugging-port=9222` 的 Chrome/Edge 专用采集浏览器。首次使用时需要在这个新浏览器窗口里登录小红书。

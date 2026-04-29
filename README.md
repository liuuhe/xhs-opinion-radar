# XHS Opinion Radar

小红书关键词舆情分析本地工作台。项目目标是把采集、格式转换、本地情绪推理和报告导出放在同一个本地 WebUI 中完成。

```text
MediaCrawler 采集 -> capture JSON -> 本地 BERT 分析 -> WebUI 报告导出
```

## 功能

- 在本地 WebUI 中按关键词采集小红书帖子和评论。
- 使用 vendored `MediaCrawler` 小红书子集作为采集模块。
- 自动把 MediaCrawler JSONL 输出转换为项目统一的 capture JSON。
- 调用本地 BERT FastAPI 服务完成 `negative / neutral / positive` 三分类。
- 生成舆情报告，并支持 JSON、Markdown、CSV 和打印 PDF 导出。

当前最佳本地模型基线：`test_macro_f1 = 0.8295`。后续新模型只有超过该冻结测试集基线才建议替换默认模型。

## 环境要求

推荐环境：

- Windows 10/11 + PowerShell
- Node.js 22 LTS
- Python 3.11
- Git
- Chrome 或 Edge
- `uv`，用于运行 MediaCrawler
- 可选：NVIDIA GPU + CUDA 版 PyTorch，用于本地 BERT 加速

安装 `uv`：

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

安装完成后重新打开 PowerShell，确认：

```powershell
node -v
npm -v
python --version
uv --version
git --version
```

## 安装

克隆仓库：

```powershell
git clone https://github.com/liuuhe/xhs-opinion-radar.git
cd xhs-opinion-radar
```

安装前端和本地 WebUI 依赖：

```powershell
npm ci
```

创建 BERT Python 虚拟环境并安装依赖：

```powershell
npm run setup:bert
```

如果你希望使用 GPU，请先按 PyTorch 官网命令安装与你 CUDA 版本匹配的 `torch`，再安装其余依赖。当前脚本会按 `bert/requirements.txt` 安装通用依赖。

## 模型文件

公开仓库不包含训练好的 BERT 模型、采集数据、论文材料或本地日志。默认启动脚本会寻找：

```text
bert\models\xhs-bert-sentiment-oldflow-v2-seed42-e5-b16-lr2e5
```

你可以使用自己的模型目录启动：

```powershell
npm run local -- -ModelDir "bert\models\your-model-dir"
```

模型目录需要是 Hugging Face `AutoModelForSequenceClassification` 可读取的格式，通常包含 `config.json`、`model.safetensors` 或 `pytorch_model.bin`、`tokenizer.json` 等文件。

如果没有本地模型，`bert/app.py` 会回退到 `google-bert/bert-base-chinese`，但这不是已微调的情绪分类模型，只适合验证服务能启动，不适合作为实际分析结果。

## 一键启动

```powershell
npm run local
```

启动过程会：

1. 清理上一次留下的本地 WebUI / BERT / 采集浏览器进程。
2. 构建本地前端。
3. 启动本地 BERT FastAPI 服务。
4. 启动本地 WebUI/API。
5. 打开 `http://127.0.0.1:8788`。

停止：

```powershell
npm run local:stop
```

常用参数：

```powershell
npm run local -- -SkipBuild
npm run local -- -NoBrowser
npm run local -- -Runtime torch
npm run local -- -Runtime onnx
npm run local -- -BertPort 7860 -WebPort 8788
```

日志目录：

```text
.local\logs
```

## WebUI 使用

1. 打开 `http://127.0.0.1:8788`。
2. 在 MediaCrawler 面板填写关键词、目标帖子数和每帖评论数。
3. 点击“开始采集”。
4. 第一次使用时，在自动打开的 Chrome/Edge 采集浏览器里登录小红书。
5. 采集完成后，WebUI 会自动转换并载入 capture JSON。
6. 点击本地 BERT 分析，生成报告。

采集中可以点击“暂停采集”。暂停会终止当前 MediaCrawler 进程，并尝试转换已经写出的 JSONL。

## 命令行采集

WebUI 是推荐入口。也可以直接使用 CLI：

```powershell
npm run mediacrawler:xhs -- --keywords "酒店 避雷" --max_notes_count 10 --max_comments_count_singlenotes 80
```

转换为 capture JSON：

```powershell
npm run mediacrawler:to-capture -- --input-dir "data\mediacrawler\xhs\jsonl" --keyword "酒店 避雷" --output "data\captures\xhs-mediacrawler-酒店-避雷.json"
```

## Dataset Loop

这部分用于后续补充训练数据，不是日常 WebUI 使用的必要步骤。

从 capture JSON 生成复核样本：

```powershell
npm run dataset:from-captures -- --input "data/captures/*.json" --output "bert/data/archive-wsl/exports/new_samples.review.csv"
```

复核并填写 `negative/neutral/positive` 标签后合并到训练集：

```powershell
npm run dataset:merge -- --base "bert/data/archive-wsl/exports/train.corrected.v2.csv" --new "bert/data/archive-wsl/exports/new_samples.review.csv" --output "bert/data/archive-wsl/exports/train.corrected.v3.csv"
```

## 本地私有目录

以下目录不会提交到公开仓库：

- `data/`：采集数据和报告
- `bert/models/`：本地模型
- `docs/thesis/`：论文和学校模板
- `.local/`：运行日志、PID 和临时文件
- `vendor/mediacrawler-xhs/browser_data/`：采集浏览器数据

## 开发检查

```powershell
npm run check
npm run build
```

## 许可说明

- 如果准备公开发布，建议在仓库根目录补充明确的开源 LICENSE。
- `vendor/mediacrawler-xhs` 来源于 [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)，保留原项目 LICENSE。
- 使用小红书采集能力时，请遵守平台规则和相关法律法规，保持低频、低并发、学习研究用途。

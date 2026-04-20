# Public Opinion Pipeline

用于毕业设计的数据流水线，包含：
- 小红书首页推流帖子与评论采集
- 评论清洗与去重
- 基于 OpenAI 兼容接口的三分类情绪标注
- 质量校验与训练集导出

## Quick Start

1. 创建虚拟环境并安装依赖：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
playwright install chromium
```

2. 配置环境变量：

```bash
cp .env.example .env
```

3. 首次登录小红书并持久化会话：

```bash
python -m app doctor_browser
python -m app login
```

4. 采集首页推流评论：

```bash
python -m app crawl_home_feed --batches 3 --posts-per-batch 10 --comments-per-post 40
```

5. 清洗、标注、校验、导出：

```bash
python -m app clean
python -m app label
python -m app validate
python -m app export_dataset
```

6. 微调 BERT 情绪分类模型：

```bash
python -m app train_bert
```

## Cloudflare Web App

新增的网页成品部署在 Cloudflare Workers + Static Assets 上：

- 前端：React + Vite，输入关键词并展示情绪比例、评论样本和帖子来源。
- 后端：Cloudflare Worker 的 `/api/analyze`，使用 Browser Run 抓取小红书搜索结果。
- 登录态：优先在网页中启动 Cloudflare 远程扫码登录；本地 `sessions/xiaohongshu_storage_state.json` 上传到 KV 作为兜底。
- 情绪判断：默认使用 OpenAI 兼容 LLM；BERT 模式需要额外配置外部推理服务 `BERT_INFERENCE_URL`。
- UI：使用 shadcn/ui + Tailwind，包含阶段进度、情绪图表、诊断面板和 JSON/CSV/Markdown 导出。

1. 安装前端和 Worker 依赖：

```bash
npm install
```

2. 创建 KV namespace，并把输出的 `id` 填入 `wrangler.jsonc` 的 `PUBLIC_OPINION_KV`：

```bash
npm run cf:kv:create
```

3. 配置 Cloudflare secrets：

```bash
wrangler secret put OPENAI_API_KEY
wrangler secret put LOGIN_ADMIN_TOKEN
```

如果使用兼容 OpenAI 的服务，可在 `wrangler.jsonc` 修改 `OPENAI_BASE_URL` 和 `OPENAI_MODEL`。

4. 登录小红书：

推荐使用网页右侧“远程扫码刷新”。输入 `LOGIN_ADMIN_TOKEN` 后启动 Cloudflare 远程浏览器，用小红书 App 扫码确认，成功后 Worker 会把远程浏览器登录态保存到 KV。这样生成的登录态和后续抓取使用同一个 Cloudflare 环境。如果小红书要求短信验证码，验证码通常会在扫码后自动发送，可在网页的“短信验证码”区域填写手机收到的验证码并提交到远程浏览器。

本地上传仍作为兜底。如果本地已经有 `sessions/xiaohongshu_storage_state.json`，只需要运行上传命令。这个命令只读本地文件并写入 Cloudflare KV，不会打开浏览器窗口：


```bash
npm run cf:upload-session
```

只有本地登录态文件不存在或已经失效时，才需要手动重新登录一次。这个命令会打开 Playwright 浏览器窗口用于扫码：

```bash
python -m app login
npm run cf:upload-session
```

网页中的“KV 已就绪”只代表登录态文件存在。若诊断显示 `login_required`，说明 Cloudflare 远程浏览器已经被小红书要求重新登录，优先使用“远程扫码刷新”重新保存登录态。

5. 本地开发、构建和部署：

```bash
npm run dev
npm run build
npm run deploy
```

如需本地稳定演示完整报告，可在本地 `.dev.vars` 中启用 fixture：

```bash
LOCAL_FIXTURE_ENABLED=true
```

fixture 仅用于本地开发和答辩彩排；线上配置默认关闭，真实抓取失败时会展示诊断信息而不是自动返回演示数据。

本地开发时如果要通过 Cloudflare Browser Run 观察真实浏览器，可按 Cloudflare 文档使用 `X_BROWSER_HEADFUL=true npm run dev`。部署前需要确认账号已启用 Browser Run，并且 `wrangler.jsonc` 中的 Browser binding 保持为 `BROWSER`。

## Output Layout

- `data/raw/raw_posts.jsonl`
- `data/raw/raw_comments.jsonl`
- `data/clean/clean_comments.jsonl`
- `data/labeled/labeled_comments.jsonl`
- `data/exports/train.csv`
- `data/exports/val.csv`
- `data/exports/test.csv`
- `data/exports/validation_report.json`
- `data/models/bert_finetune/`
- Cloudflare 网页构建产物：`dist/`

## Notes

- 采集基于登录态与时间窗口抽样，结果具有个性化偏差，需要在论文中说明。
- 代码默认只做教学与研究用途，执行前自行确认平台规则与数据使用边界。
- 小红书页面结构会变化，`app/crawler.py` 中保留了多套 DOM / 全局状态提取兜底逻辑，必要时需要按实际页面微调。
- 如果 `login` 报 `ERR_CONNECTION_CLOSED`，先运行 `python -m app doctor_browser`，再根据输出调整 `config.yaml` 中的 `browser.launch_args`、`login_candidates` 或本地网络环境。
- Cloudflare Worker 端不会直接运行本地 PyTorch/BERT 模型；BERT 推理需要外部 HTTP 服务，网页默认使用 LLM 模式。
- `/api/analyze/stream` 会返回阶段事件和诊断信息，前端优先使用该接口展示分析进度。
- 如果分析报 `Cloudflare Browser Run 当前被限流` 或 `code: 429`，说明 Cloudflare 暂时拒绝创建新的远程浏览器。系统会在 KV 中记录短暂冷却期，等待页面提示的时间后再重试，避免连续点击拉长限流。

## Chrome Extension Capture

`browser-extension/` 提供一个 Manifest V3 扩展，用于把采集动作放回用户自己的已登录浏览器：

- 老师或演示者只需要 Chrome / Edge 等 Chromium 浏览器，不需要安装 Python、Node 或 Playwright。
- 用户先正常登录小红书，再打开搜索页或帖子详情页。
- 扩展会从当前标签页的 DOM 和页面网络 JSON 中提取帖子与评论。
- 扩展调用 Worker 的 `/api/analyze/captured`，Worker 只做情绪标注和报告生成，不再创建 Cloudflare Browser Run。

安装方式：

1. 打开 `chrome://extensions`。
2. 开启 Developer mode。
3. 点击 Load unpacked。
4. 选择本仓库的 `browser-extension/` 目录。

使用方式：

1. 打开并登录 `https://www.xiaohongshu.com`。
2. 搜索关键词，或打开某个帖子详情页。
3. 滚动页面，让帖子或评论加载出来。
4. 点击扩展图标，先点“采集当前页”，再点“发送分析”。

扩展默认使用线上 Worker：

```text
https://public-opinion-cloudflare.liuuhe.workers.dev
```

如果是本地 Worker，可以在扩展弹窗里把 Worker 地址改成对应的本地地址。

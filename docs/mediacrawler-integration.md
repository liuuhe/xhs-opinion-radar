# MediaCrawler Integration

本项目不再继续扩展自研 Playwright 小红书采集逻辑。采集训练数据时优先使用 [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)，本仓库只维护一个格式适配层，把 MediaCrawler 输出转换成现有 Worker/Web 能直接导入的 capture JSON。

## Recommended Flow

1. 在本仓库旁边克隆 MediaCrawler：

```powershell
cd C:\Users\xlyytcy\codespace
git clone https://github.com/NanmiCoder/MediaCrawler.git
cd MediaCrawler
uv sync
```

2. 按 MediaCrawler README 配置 Chrome CDP。推荐使用真实 Chrome 登录态，避免标准无痕 Playwright 浏览器触发更高风控。

3. 在 MediaCrawler 中配置 `config/base_config.py`：

```python
PLATFORM = "xhs"
SAVE_DATA_OPTION = "jsonl"
ENABLE_GET_COMMENTS = True
ENABLE_GET_SUB_COMMENTS = False
CRAWLER_MAX_NOTES_COUNT = 10
CRAWLER_MAX_COMMENTS_COUNT_SINGLENOTES = 80
MAX_CONCURRENCY_NUM = 1
CDP_CONNECT_EXISTING = True
```

4. 运行小红书关键词采集：

```powershell
uv run main.py --platform xhs --lt qrcode --type search
```

MediaCrawler 默认会把小红书数据写到类似路径：

```text
data/xhs/jsonl/search_contents_YYYY-MM-DD.jsonl
data/xhs/jsonl/search_comments_YYYY-MM-DD.jsonl
```

5. 回到本项目，把 MediaCrawler 输出转成 capture JSON：

```powershell
cd C:\Users\xlyytcy\codespace\public_opinion
npm run mediacrawler:to-capture -- --input-dir "..\MediaCrawler\data\xhs\jsonl" --keyword "酒店 避雷" --output "data/captures/xhs-mediacrawler-酒店-避雷.json"
```

6. 生成的 capture JSON 可以直接：

- 在 `https://opinion.liuhe.me` 网页上传分析；
- 发送到 `/api/analyze/captured`；
- 进入 `dataset:from-captures -> dataset:label-llm -> dataset:merge -> bert/train.py` 数据补充流水线。

## Converter Commands

自动扫描 MediaCrawler 输出目录：

```powershell
npm run mediacrawler:to-capture -- --input-dir "..\MediaCrawler\data\xhs\jsonl" --keyword "酒店 避雷"
```

显式指定 contents/comments 文件：

```powershell
npm run mediacrawler:to-capture -- `
  --contents "..\MediaCrawler\data\xhs\jsonl\search_contents_2026-04-26.jsonl" `
  --comments "..\MediaCrawler\data\xhs\jsonl\search_comments_2026-04-26.jsonl" `
  --keyword "酒店 避雷" `
  --output "data/captures/xhs-mediacrawler-酒店-避雷.json"
```

控制导入规模：

```powershell
npm run mediacrawler:to-capture -- `
  --input-dir "..\MediaCrawler\data\xhs\jsonl" `
  --keyword "健身房 值不值" `
  --max-posts 20 `
  --comments-per-post 100
```

## Notes

- MediaCrawler 的 LICENSE 是非商业学习许可，使用前需要确认你的使用场景符合其条款。
- 不要做大规模并发采集。即使用成熟项目，也建议保留 `MAX_CONCURRENCY_NUM = 1`、较小批次和真实 Chrome 登录态。
- 本仓库旧的 `npm run collect:xhs` 仍保留为 fallback，但不再作为 dataset 补充的推荐路径。

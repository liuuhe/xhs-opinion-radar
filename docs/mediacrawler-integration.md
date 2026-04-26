# MediaCrawler Integration

本项目使用 vendored MediaCrawler 小红书子集作为唯一推荐采集路径。源码位于：

```text
vendor\mediacrawler-xhs
```

保留原项目 LICENSE，只保留本项目需要的小红书路径。

## WebUI 采集

启动：

```powershell
npm run local
```

在页面填写关键词、帖子数和每帖评论数，点击“开始采集”。采集完成后 WebUI 会自动调用转换脚本，生成：

```text
data\captures\xhs-mediacrawler-*.json
```

点击“载入结果”后即可用本地 BERT/LLM 生成报告。

## CLI 采集

```powershell
npm run mediacrawler:xhs -- --keywords "酒店 避雷" --max_notes_count 10 --max_comments_count_singlenotes 80
```

输出目录：

```text
data\mediacrawler\xhs\jsonl
```

转换：

```powershell
npm run mediacrawler:to-capture -- --input-dir "data\mediacrawler\xhs\jsonl" --keyword "酒店 避雷"
```

## Notes

- 默认低并发：`--max_concurrency_num 1`。
- 推荐使用真实浏览器登录态。
- 如果出现验证，直接在 MediaCrawler 打开的浏览器里完成。
- MediaCrawler 使用非商业学习许可，使用前确认场景符合 `vendor\mediacrawler-xhs\LICENSE`。

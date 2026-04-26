# Legacy Xiaohongshu Playwright Collector

The browser extension remains the preferred path for actual product use. For dataset expansion, prefer MediaCrawler plus `npm run mediacrawler:to-capture`; see `docs/mediacrawler-integration.md`.

This legacy Playwright collector is kept only as a fallback tool for:

- reproducing collection runs with a local script,
- fallback collection when both the extension and MediaCrawler path are temporarily unavailable.

It writes the same capture JSON shape accepted by the web app and `/api/analyze/captured`.

The collector is intentionally conservative: one visible browser session, one post at a time, persistent login state, randomized delays, checkpoint output after each post, and stop-on-verification behavior. It does not try to bypass verification, CAPTCHAs, or platform rate limits.

## Install

```powershell
npm install
npx playwright install chromium
```

## Login Once

```powershell
npm run collect:xhs -- --login
```

Log in manually in the opened Chromium window, wait until Xiaohongshu is usable, then press Enter in the terminal. The profile is saved under `sessions/xhs-playwright/`.

## Collect By Keyword

```powershell
npm run collect:xhs -- --keyword "酒店 避雷" --max-posts 10 --comments-per-post 80
```

Output defaults to `data/captures/xhs-playwright-<keyword>-<timestamp>.json`.

If you have already opened the right Xiaohongshu search result page in the Playwright browser, collect from the current page instead of constructing a new URL:

```powershell
npm run collect:xhs -- --current-page --keyword "酒店 避雷"
```

If Xiaohongshu changes the search URL shape, copy the browser address bar URL and pass it directly:

```powershell
npm run collect:xhs -- --search-url "https://www.xiaohongshu.com/search_result?keyword=..."
```

## Collect From Known Note URLs

```powershell
npm run collect:xhs -- --urls-file data/note-urls.txt --keyword "酒店 避雷"
```

`data/note-urls.txt` should contain one Xiaohongshu note URL per line. Blank lines and `#` comments are ignored.

## Reuse Existing Chrome With CDP

If you prefer using your normal Chrome profile, start Chrome with remote debugging enabled yourself, then run:

```powershell
npm run collect:xhs -- --cdp http://127.0.0.1:9222 --keyword "酒店 避雷"
```

This follows the same high-level pattern as MediaCrawler: reuse a real logged-in browser context and avoid extra reverse engineering. Keep collection small and pause when verification appears.

## Dataset Use

After collection, convert captures into a review CSV:

```powershell
npm run dataset:from-captures -- --input "data/captures/xhs-*.json" --output "bert/data/archive-wsl/exports/new_samples.review.csv"
```

Run LLM pre-labeling through the production Worker:

```powershell
npm run dataset:label-llm -- --input "bert/data/archive-wsl/exports/new_samples.review.csv" --output "bert/data/archive-wsl/exports/new_samples.llm.csv" --worker-url "https://opinion.liuhe.me"
```

Merge valid labels into a new training CSV:

```powershell
npm run dataset:merge -- --base "bert/data/archive-wsl/exports/train.corrected.v2.csv" --new "bert/data/archive-wsl/exports/new_samples.llm.csv" --output "bert/data/archive-wsl/exports/train.corrected.v3.csv"
```

LLM labels should be treated as pre-label candidates. A new model should not be deployed unless it beats the current frozen test baseline of `test_macro_f1 = 0.8295`.

## Useful Options

```text
--max-posts 10
--comments-per-post 80
--search-scroll-rounds 8
--detail-scroll-rounds 8
--delay-min-ms 9000
--delay-max-ms 22000
--output data/captures/my-capture.json
--keep-open
```

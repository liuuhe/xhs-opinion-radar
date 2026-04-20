const DEFAULT_WORKER_URL = "https://public-opinion-cloudflare.liuuhe.workers.dev";

const elements = {
  workerUrl: document.querySelector("#workerUrl"),
  keyword: document.querySelector("#keyword"),
  maxPosts: document.querySelector("#maxPosts"),
  commentsPerPost: document.querySelector("#commentsPerPost"),
  engine: document.querySelector("#engine"),
  captureBtn: document.querySelector("#captureBtn"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  status: document.querySelector("#status"),
  result: document.querySelector("#result")
};

let currentCapture = null;

loadSettings();

elements.captureBtn.addEventListener("click", () => void captureCurrentTab());
elements.analyzeBtn.addEventListener("click", () => void analyzeCapture());

for (const key of ["workerUrl", "keyword", "maxPosts", "commentsPerPost", "engine"]) {
  elements[key].addEventListener("change", saveSettings);
}

async function loadSettings() {
  const saved = await chrome.storage.sync.get({
    workerUrl: DEFAULT_WORKER_URL,
    keyword: "",
    maxPosts: 10,
    commentsPerPost: 30,
    engine: "llm"
  });
  elements.workerUrl.value = saved.workerUrl;
  elements.keyword.value = saved.keyword;
  elements.maxPosts.value = saved.maxPosts;
  elements.commentsPerPost.value = saved.commentsPerPost;
  elements.engine.value = saved.engine;
}

function saveSettings() {
  void chrome.storage.sync.set({
    workerUrl: elements.workerUrl.value.trim() || DEFAULT_WORKER_URL,
    keyword: elements.keyword.value.trim(),
    maxPosts: Number(elements.maxPosts.value) || 10,
    commentsPerPost: Number(elements.commentsPerPost.value) || 30,
    engine: elements.engine.value
  });
}

async function captureCurrentTab() {
  setStatus("正在读取当前小红书标签页...");
  elements.analyzeBtn.disabled = true;
  elements.result.hidden = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/www\.xiaohongshu\.com\//.test(tab.url || "")) {
    setStatus("请先切换到已登录的小红书搜索页或帖子详情页。");
    return;
  }

  try {
    currentCapture = await chrome.tabs.sendMessage(tab.id, { type: "XHS_CAPTURE_GET" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    currentCapture = await chrome.tabs.sendMessage(tab.id, { type: "XHS_CAPTURE_GET" });
  }

  if (!currentCapture?.ok) {
    setStatus("采集失败，请刷新小红书页面后重试。");
    return;
  }

  if (!elements.keyword.value.trim()) {
    elements.keyword.value = currentCapture.keywordGuess || "";
    saveSettings();
  }

  elements.analyzeBtn.disabled = currentCapture.totals.comments === 0;
  setStatus(
    `已采集当前页。\n帖子：${currentCapture.totals.posts}\n评论：${currentCapture.totals.comments}\n网络包：${currentCapture.networkPayloadCount}\n${
      currentCapture.totals.comments === 0 ? "未采集到评论，请打开帖子详情页并滚动评论区后重试。" : "可以发送到 Worker 分析。"
    }`
  );
}

async function analyzeCapture() {
  if (!currentCapture) {
    setStatus("请先采集当前页。");
    return;
  }
  const workerUrl = elements.workerUrl.value.trim().replace(/\/+$/, "");
  const keyword = elements.keyword.value.trim() || currentCapture.keywordGuess || "小红书";

  setStatus("正在发送到 Worker 做情绪分析...");
  elements.analyzeBtn.disabled = true;

  try {
    const response = await fetch(`${workerUrl}/api/analyze/captured`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyword,
        engine: elements.engine.value,
        maxPosts: Number(elements.maxPosts.value) || 10,
        commentsPerPost: Number(elements.commentsPerPost.value) || 30,
        pageUrl: currentCapture.pageUrl,
        posts: currentCapture.posts
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error([payload.error, payload.details].filter(Boolean).join("："));
    }
    renderResult(payload);
    setStatus("分析完成。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "分析失败");
  } finally {
    elements.analyzeBtn.disabled = false;
  }
}

function renderResult(result) {
  const distribution = result.distribution || {};
  elements.result.hidden = false;
  elements.result.innerHTML = [
    metric("关键词", result.keyword),
    metric("摘要", result.summary),
    metric("帖子", result.totals?.posts ?? 0),
    metric("评论", result.totals?.comments ?? 0),
    metric("正向", distribution.positive?.count ?? 0),
    metric("中性", distribution.neutral?.count ?? 0),
    metric("负向", distribution.negative?.count ?? 0)
  ].join("");
}

function metric(label, value) {
  return `<div class="metric"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(String(value))}</span></div>`;
}

function setStatus(message) {
  elements.status.textContent = message;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

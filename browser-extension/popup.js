const DEFAULT_WORKER_URL = "https://public-opinion-cloudflare.liuuhe.workers.dev";

const elements = {
  workerUrl: document.querySelector("#workerUrl"),
  keyword: document.querySelector("#keyword"),
  maxPosts: document.querySelector("#maxPosts"),
  commentsPerPost: document.querySelector("#commentsPerPost"),
  engine: document.querySelector("#engine"),
  captureBtn: document.querySelector("#captureBtn"),
  autoCaptureBtn: document.querySelector("#autoCaptureBtn"),
  pauseBtn: document.querySelector("#pauseBtn"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  status: document.querySelector("#status"),
  result: document.querySelector("#result")
};

let currentCapture = null;
let statusTimer = null;
let lastAutoStatus = null;

loadSettings();
void refreshAutoStatus();

elements.captureBtn.addEventListener("click", () => void captureCurrentTab());
elements.autoCaptureBtn.addEventListener("click", () => void startAutoCapture());
elements.pauseBtn.addEventListener("click", () => void toggleAutoPause());
elements.analyzeBtn.addEventListener("click", () => void analyzeCapture());

for (const key of ["workerUrl", "keyword", "maxPosts", "commentsPerPost", "engine"]) {
  elements[key].addEventListener("change", saveSettings);
}

async function loadSettings() {
  const saved = await chrome.storage.sync.get({
    workerUrl: DEFAULT_WORKER_URL,
    keyword: "",
    maxPosts: 10,
    commentsPerPost: 20,
    engine: "llm"
  });
  elements.workerUrl.value = saved.workerUrl;
  elements.keyword.value = saved.keyword;
  elements.maxPosts.value = saved.maxPosts;
  elements.commentsPerPost.value = saved.commentsPerPost;
  elements.engine.value = saved.engine;
}

function saveSettings() {
  const limits = readLimits();
  void chrome.storage.sync.set({
    workerUrl: elements.workerUrl.value.trim() || DEFAULT_WORKER_URL,
    keyword: elements.keyword.value.trim(),
    maxPosts: limits.maxPosts,
    commentsPerPost: limits.commentsPerPost,
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
  currentCapture = limitCapture(currentCapture, readLimits());

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

async function startAutoCapture() {
  saveSettings();
  setStatus("正在启动自动逐帖采集...");
  elements.autoCaptureBtn.disabled = true;
  elements.captureBtn.disabled = true;
  elements.pauseBtn.disabled = true;
  elements.analyzeBtn.disabled = true;
  elements.result.hidden = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/www\.xiaohongshu\.com\//.test(tab.url || "")) {
    setStatus("请先切换到已登录的小红书搜索页。");
    elements.autoCaptureBtn.disabled = false;
    elements.captureBtn.disabled = false;
    elements.pauseBtn.disabled = true;
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "XHS_AUTO_CAPTURE_START",
    options: {
      activeTabId: tab.id,
      workerUrl: elements.workerUrl.value.trim() || DEFAULT_WORKER_URL,
      keyword: decodeText(elements.keyword.value.trim()),
      ...readLimits(),
      engine: elements.engine.value
    }
  });
  if (!response?.ok) {
    setStatus(response?.error || "自动采集启动失败。");
    elements.autoCaptureBtn.disabled = false;
    elements.captureBtn.disabled = false;
    elements.pauseBtn.disabled = true;
    return;
  }
  renderAutoStatus(response.status);
  startStatusPolling();
}

async function toggleAutoPause() {
  const paused = Boolean(lastAutoStatus?.paused);
  const response = await chrome.runtime.sendMessage({
    type: paused ? "XHS_AUTO_CAPTURE_RESUME" : "XHS_AUTO_CAPTURE_PAUSE"
  });
  if (!response?.ok) {
    setStatus(response?.error || "暂停状态切换失败。");
    return;
  }
  renderAutoStatus(response.status);
}

async function analyzeCapture() {
  if (!currentCapture) {
    setStatus("请先采集当前页。");
    return;
  }
  const workerUrl = elements.workerUrl.value.trim().replace(/\/+$/, "");
  const keyword = decodeText(elements.keyword.value.trim() || currentCapture.keywordGuess || "小红书");
  const limits = readLimits();
  const capture = limitCapture(currentCapture, limits);

  setStatus("正在发送到 Worker 做情绪分析...");
  elements.analyzeBtn.disabled = true;

  try {
    const response = await fetch(`${workerUrl}/api/analyze/captured`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyword,
        engine: elements.engine.value,
        maxPosts: limits.maxPosts,
        commentsPerPost: limits.commentsPerPost,
        pageUrl: capture.pageUrl,
        posts: capture.posts
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
    metric("负向", distribution.negative?.count ?? 0),
    result.savedReport?.url
      ? metric("完整报告", `<a href="${escapeHtml(result.savedReport.url)}" target="_blank">打开网页报告</a>`, true)
      : ""
  ].join("");
}

function metric(label, value, html = false) {
  const safeValue = html ? String(value) : escapeHtml(String(value));
  return `<div class="metric"><strong>${escapeHtml(label)}</strong><span>${safeValue}</span></div>`;
}

function setStatus(message) {
  elements.status.textContent = message;
}

function readLimits() {
  return {
    maxPosts: clampNumber(elements.maxPosts.value, 10, 1, 30),
    commentsPerPost: clampNumber(elements.commentsPerPost.value, 20, 0, 80)
  };
}

function limitCapture(capture, limits) {
  const posts = (capture.posts || []).slice(0, limits.maxPosts).map((post) => ({
    ...post,
    comments: (post.comments || []).slice(0, limits.commentsPerPost)
  }));
  return {
    ...capture,
    posts,
    totals: {
      posts: posts.length,
      comments: posts.reduce((sum, post) => sum + (post.comments?.length || 0), 0)
    }
  };
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
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

function decodeText(value) {
  let decoded = String(value || "");
  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded.trim();
}

function startStatusPolling() {
  if (statusTimer) {
    clearInterval(statusTimer);
  }
  statusTimer = setInterval(() => void refreshAutoStatus(), 1000);
}

async function refreshAutoStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AUTO_CAPTURE_STATUS" });
    if (response?.ok) {
      renderAutoStatus(response.status);
    }
  } catch {
    // Background service worker may still be waking up.
  }
}

function renderAutoStatus(status) {
  lastAutoStatus = status || null;
  if (!status || status.phase === "idle") {
    elements.autoCaptureBtn.disabled = false;
    elements.captureBtn.disabled = false;
    elements.pauseBtn.disabled = true;
    elements.pauseBtn.textContent = "暂停";
    return;
  }

  const lines = [
    status.message,
    status.discoveredPosts ? `发现帖子：${status.discoveredPosts}` : "",
    status.currentIndex ? `当前进度：${status.currentIndex}/${status.discoveredPosts || status.targetPosts}` : "",
    `已采集：${status.capturedPosts || 0} 篇 / ${status.capturedComments || 0} 条评论`,
    status.warnings?.length ? `提示：${status.warnings.at(-1)}` : "",
    status.error ? `错误：${status.error}` : ""
  ].filter(Boolean);
  setStatus(lines.join("\n"));

  if (status.result) {
    renderResult(status.result);
  }

  const running = Boolean(status.running);
  elements.autoCaptureBtn.disabled = running;
  elements.captureBtn.disabled = running;
  elements.pauseBtn.disabled = !running;
  elements.pauseBtn.textContent = status.paused ? "继续" : "暂停";
  elements.analyzeBtn.disabled = running || !currentCapture || currentCapture.totals.comments === 0;

  if (!running && statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
    elements.pauseBtn.disabled = true;
    elements.pauseBtn.textContent = "暂停";
  }
}

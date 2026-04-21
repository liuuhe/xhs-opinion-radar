const DEFAULT_STATUS = {
  running: false,
  phase: "idle",
  message: "等待开始自动采集。",
  discoveredPosts: 0,
  targetPosts: 0,
  currentIndex: 0,
  capturedPosts: 0,
  capturedComments: 0,
  warnings: [],
  result: null,
  reportUrl: "",
  error: "",
  paused: false
};

let taskStatus = { ...DEFAULT_STATUS };
let taskCancelled = false;
let taskPaused = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "XHS_AUTO_CAPTURE_START") {
    if (taskStatus.running) {
      sendResponse({ ok: false, status: taskStatus, error: "已有自动采集任务正在运行。" });
      return false;
    }
    taskCancelled = false;
    taskPaused = false;
    void runAutoCapture(message.options || {});
    sendResponse({ ok: true, status: taskStatus });
    return false;
  }

  if (message?.type === "XHS_AUTO_CAPTURE_STATUS") {
    sendResponse({ ok: true, status: taskStatus });
    return false;
  }

  if (message?.type === "XHS_AUTO_CAPTURE_CANCEL") {
    taskCancelled = true;
    updateStatus({ running: false, phase: "cancelled", message: "自动采集已取消。" });
    sendResponse({ ok: true, status: taskStatus });
    return false;
  }

  if (message?.type === "XHS_AUTO_CAPTURE_PAUSE") {
    if (!taskStatus.running) {
      sendResponse({ ok: false, status: taskStatus, error: "当前没有正在运行的自动采集任务。" });
      return false;
    }
    taskPaused = true;
    updateStatus({ paused: true, phase: "paused", message: "自动采集已暂停。点击继续后从下一篇帖子开始。" });
    sendResponse({ ok: true, status: taskStatus });
    return false;
  }

  if (message?.type === "XHS_AUTO_CAPTURE_RESUME") {
    if (!taskStatus.running) {
      sendResponse({ ok: false, status: taskStatus, error: "当前没有正在运行的自动采集任务。" });
      return false;
    }
    taskPaused = false;
    updateStatus({ paused: false, phase: "capturing", message: "自动采集已继续。" });
    sendResponse({ ok: true, status: taskStatus });
    return false;
  }

  return false;
});

async function runAutoCapture(options) {
  const targetPosts = clampNumber(options.maxPosts, 10, 1, 30);
  const commentsPerPost = clampNumber(options.commentsPerPost, 20, 0, 80);
  updateStatus({
    ...DEFAULT_STATUS,
    running: true,
    phase: "discovering",
    message: "正在从当前搜索页提取帖子链接和 xsec_token。",
    targetPosts
  });

  try {
    const activeTabId = Number(options.activeTabId);
    if (!activeTabId) {
      throw new Error("没有可用的小红书标签页。");
    }

    const keyword = decodeText(options.keyword || "");
    if (keyword) {
      updateStatus({
        phase: "searching",
        message: `正在打开关键词「${keyword}」的小红书搜索结果页。`
      });
      await openSearchPageForKeyword(activeTabId, keyword);
    }

    let searchCapture = await discoverCandidates(activeTabId, Math.min(5, targetPosts));
    const candidateQueue = [];
    const queuedCandidateKeys = new Set();
    enqueueCandidates(candidateQueue, queuedCandidateKeys, searchCapture?.posts || [], targetPosts);
    let candidates = candidateQueue.slice();

    if (candidates.length === 0) {
      throw new Error(buildDiscoveryError(searchCapture));
    }

    updateStatus({
      phase: "capturing",
      message: `已发现 ${candidates.length} 篇帖子，开始用后台详情页逐帖采集评论。`,
      discoveredPosts: candidates.length
    });

    const capturedPosts = [];
    const visitedCandidateKeys = new Set();
    let index = 0;
    while (capturedPosts.length < targetPosts) {
      if (taskCancelled) {
        throw new Error("自动采集已取消。");
      }
      await waitWhilePaused();

      if (candidateQueue.length === 0) {
        searchCapture = await discoverCandidates(activeTabId, Math.min(targetPosts, capturedPosts.length + 3), { light: true });
        enqueueCandidates(
          candidateQueue,
          queuedCandidateKeys,
          searchCapture?.posts || [],
          targetPosts - capturedPosts.length - candidateQueue.length
        );
        candidates = Array.from(queuedCandidateKeys);
      }

      const candidate = candidateQueue.shift();
      if (!candidate) {
        taskStatus.warnings.push(`当前搜索页只找到 ${capturedPosts.length} 篇可采集的帖子。`);
        break;
      }
      const candidateKey = getCandidateKey(candidate);
      if (visitedCandidateKeys.has(candidateKey)) {
        continue;
      }
      visitedCandidateKeys.add(candidateKey);
      index += 1;
      updateStatus({
        currentIndex: index,
        discoveredPosts: Math.max(taskStatus.discoveredPosts, queuedCandidateKeys.size),
        message: `正在后台打开第 ${index}/${targetPosts} 篇：${candidate.title || candidate.url}`
      });
      await waitWhilePaused();

      const capture = await capturePostInBackgroundTab({
        candidate,
        maxComments: commentsPerPost
      });
      const bestPost = pickBestPost(capture?.posts || [], candidate);
      if (!bestPost) {
        taskStatus.warnings.push(`第 ${index} 篇未采集到帖子内容：${candidate.url}`);
        await delay(350);
        continue;
      }

      capturedPosts.push({
        ...candidate,
        ...bestPost,
        url: bestPost.url || candidate.url,
        title: bestPost.title || candidate.title || "小红书帖子",
        comments: (bestPost.comments || []).slice(0, commentsPerPost)
      });

      updateStatus({
        capturedPosts: capturedPosts.length,
        capturedComments: capturedPosts.reduce((sum, post) => sum + (post.comments?.length || 0), 0)
      });
      if ((bestPost.comments || []).length === 0) {
        taskStatus.warnings.push(`第 ${index} 篇没有采集到评论，可能评论区未加载或该帖无评论。`);
      }
      await delay(250);
    }

    if (capturedPosts.length === 0) {
      throw new Error("没有采集到可分析帖子。请确认小红书已登录，并打开搜索结果页重试。");
    }

    updateStatus({
      phase: "analyzing",
      message: `已采集 ${capturedPosts.length} 篇帖子、${taskStatus.capturedComments} 条评论，正在发送 Worker 分析。`
    });
    await waitWhilePaused();

    const result = await analyzeCapturedPosts(options, searchCapture, capturedPosts);
    updateStatus({
      running: false,
      phase: "completed",
      message: "自动采集和分析完成。",
      result,
      reportUrl: result.savedReport?.url || ""
    });

    if (result.savedReport?.url) {
      await chrome.tabs.create({ url: result.savedReport.url, active: true });
    }
  } catch (error) {
    updateStatus({
      running: false,
      phase: "failed",
      message: error instanceof Error ? error.message : "自动采集失败",
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    // The active Xiaohongshu search tab is intentionally kept open for the user.
  }
}

async function discoverCandidates(activeTabId, minPosts, options = {}) {
  return sendCaptureMessage(activeTabId, {
    type: "XHS_CAPTURE_SEARCH_SCROLL_AND_GET",
    enableNetwork: true,
    delayMs: options.light ? 450 : 650,
    minPosts
  });
}

async function openSearchPageForKeyword(activeTabId, keyword) {
  const tab = await chrome.tabs.get(activeTabId);
  const currentUrl = tab.url || "";
  if (isSearchPageForKeyword(currentUrl, keyword)) {
    return;
  }

  await chrome.tabs.update(activeTabId, {
    url: buildSearchUrl(keyword)
  });
  await waitForSearchTabReady(activeTabId, keyword, 18000);
  await delay(900);
}

function isSearchPageForKeyword(tabUrl, keyword) {
  try {
    const url = new URL(tabUrl);
    if (url.hostname !== "www.xiaohongshu.com" || !url.pathname.startsWith("/search_result")) {
      return false;
    }
    return decodeText(url.searchParams.get("keyword") || "") === keyword;
  } catch {
    return false;
  }
}

function buildSearchUrl(keyword) {
  const url = new URL("https://www.xiaohongshu.com/search_result");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("source", "web_search_result_notes");
  return url.href;
}

async function waitForSearchTabReady(tabId, keyword, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && isSearchPageForKeyword(tab.url || "", keyword)) {
      return;
    }
    await delay(300);
  }
  throw new Error("关键词搜索页打开超时，请确认小红书页面可以正常访问。");
}

function enqueueCandidates(queue, seen, posts, limit = Infinity) {
  if (limit <= 0) {
    return;
  }
  for (const post of filterCandidatePosts(posts || [])) {
    const key = getCandidateKey(post);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    queue.push(post);
    if (queue.length >= limit) {
      return;
    }
  }
}

async function waitWhilePaused() {
  while (taskPaused) {
    if (taskCancelled) {
      throw new Error("自动采集已取消。");
    }
    await delay(300);
  }
}

async function capturePostInBackgroundTab({ candidate, maxComments }) {
  const url = normalizeCandidateUrl(candidate);
  if (!url) {
    throw new Error(`帖子 URL 无效：${candidate.postId || candidate.url || ""}`);
  }

  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForTabReady(tab.id, 18000);
    await delay(900);
    const capture = await sendCaptureMessage(tab.id, {
      type: "XHS_CAPTURE_SCROLL_AND_GET",
      enableNetwork: true,
      maxComments,
      scrollRounds: maxComments > 30 ? 5 : 4,
      scrollDelayMs: 520
    });
    const bestPost = pickBestPost(capture?.posts || [], candidate);
    return {
      ...capture,
      posts: bestPost ? [bestPost] : capture?.posts || []
    };
  } finally {
    if (tab?.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        // The user or browser may already have closed the tab.
      }
    }
  }
}

async function waitForTabReady(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && /^https:\/\/www\.xiaohongshu\.com\//.test(tab.url || "")) {
      return;
    }
    await delay(300);
  }
}

function normalizeCandidateUrl(candidate) {
  const url = String(candidate.url || "");
  if (/^https:\/\/www\.xiaohongshu\.com\/(?:explore|discovery\/item)\//.test(url)) {
    return url;
  }
  const searchMatch = url.match(/^https:\/\/www\.xiaohongshu\.com\/search_result\/([^/?#]+)(\?[^#]*)?/);
  if (searchMatch && url.includes("xsec_token=")) {
    return `https://www.xiaohongshu.com/explore/${searchMatch[1]}${searchMatch[2] || ""}`;
  }
  const postId = String(candidate.postId || "").trim();
  if (!postId) {
    return "";
  }
  const nextUrl = new URL(`https://www.xiaohongshu.com/explore/${postId}`);
  if (candidate.xsecToken) {
    nextUrl.searchParams.set("xsec_token", candidate.xsecToken);
  }
  nextUrl.searchParams.set("xsec_source", candidate.xsecSource || "pc_search");
  return nextUrl.href;
}

function buildDiscoveryError(searchCapture) {
  const url = searchCapture?.pageUrl || "";
  const title = searchCapture?.pageTitle || "";
  const networkCount = searchCapture?.networkPayloadCount ?? 0;
  return [
    "当前搜索页没有提取到帖子链接。",
    "请确认页面是小红书搜索结果页、账号已登录，并轻微滚动后重试。",
    url ? `当前 URL：${url}` : "",
    title ? `页面标题：${title}` : "",
    `网络包：${networkCount}`
  ].filter(Boolean).join("\n");
}

async function analyzeCapturedPosts(options, searchCapture, posts) {
  const workerUrl = String(options.workerUrl || "").replace(/\/+$/, "");
  if (!workerUrl) {
    throw new Error("请先配置 Worker 地址。");
  }

  const response = await fetch(`${workerUrl}/api/analyze/captured`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keyword: decodeText(options.keyword || searchCapture?.keywordGuess || "小红书"),
      engine: options.engine || "llm",
      maxPosts: clampNumber(options.maxPosts, 10, 1, 30),
      commentsPerPost: clampNumber(options.commentsPerPost, 20, 0, 80),
      pageUrl: searchCapture?.pageUrl || "",
      sourcePageUrl: searchCapture?.pageUrl || "",
      persistReport: true,
      posts
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error([payload.error, payload.details].filter(Boolean).join("："));
  }
  return payload;
}

async function sendCaptureMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await delay(500);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function pickBestPost(posts, candidate) {
  const candidateId = String(candidate.postId || "").trim();
  const exact = posts.find((post) => post.postId === candidateId);
  if (exact) {
    return exact;
  }
  const withComments = posts
    .filter((post) => (post.comments || []).length > 0)
    .sort((left, right) => (right.comments?.length || 0) - (left.comments?.length || 0));
  return withComments[0] || posts[0] || null;
}

function filterCandidatePosts(posts) {
  return dedupePosts(posts)
    .filter((post) => /^https:\/\/www\.xiaohongshu\.com\//.test(post.url || ""))
    .filter((post) => post.postId || post.url)
    .filter((post) => !/当前页|登录|通知|发布/.test(String(post.title || "")));
}

function dedupePosts(posts) {
  const seen = new Set();
  const results = [];
  for (const post of posts) {
    const key = getCandidateKey(post);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(post);
  }
  return results;
}

function getCandidateKey(post) {
  return String(post?.postId || post?.url || "").trim();
}

function updateStatus(patch) {
  taskStatus = {
    ...taskStatus,
    ...patch,
    updatedAt: new Date().toISOString()
  };
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

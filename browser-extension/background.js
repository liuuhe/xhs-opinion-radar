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
  error: ""
};

let taskStatus = { ...DEFAULT_STATUS };
let taskCancelled = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "XHS_AUTO_CAPTURE_START") {
    if (taskStatus.running) {
      sendResponse({ ok: false, status: taskStatus, error: "已有自动采集任务正在运行。" });
      return false;
    }
    taskCancelled = false;
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

  return false;
});

async function runAutoCapture(options) {
  updateStatus({
    ...DEFAULT_STATUS,
    running: true,
    phase: "discovering",
    message: "正在从当前搜索页提取帖子链接。",
    targetPosts: clampNumber(options.maxPosts, 10, 1, 30)
  });

  try {
    const activeTabId = Number(options.activeTabId);
    if (!activeTabId) {
      throw new Error("没有可用的小红书标签页。");
    }

    let searchCapture = await sendCaptureMessage(activeTabId, {
      type: "XHS_CAPTURE_SEARCH_SCROLL_AND_GET",
      rounds: 4,
      delayMs: 700,
      minPosts: Math.min(3, taskStatus.targetPosts)
    });
    let candidates = filterCandidatePosts(searchCapture?.posts || []);

    if (candidates.length === 0) {
      throw new Error("当前页没有提取到帖子链接。请先打开小红书搜索页并滚动加载结果。");
    }

    updateStatus({
      phase: "capturing",
      message: `已发现 ${candidates.length} 篇帖子，开始逐帖采集评论。`,
      discoveredPosts: candidates.length
    });

    const capturedPosts = [];
    const visitedPostIds = new Set();
    for (let index = 0; index < taskStatus.targetPosts; index += 1) {
      if (taskCancelled) {
        throw new Error("自动采集已取消。");
      }

      searchCapture = await sendCaptureMessage(activeTabId, {
        type: "XHS_CAPTURE_SEARCH_SCROLL_AND_GET",
        rounds: index === 0 ? 2 : 1,
        delayMs: 500,
        minPosts: 1
      });
      candidates = filterCandidatePosts(searchCapture?.posts || []);
      const candidate = candidates.find((post) => !visitedPostIds.has(post.postId || post.url));
      if (!candidate) {
        taskStatus.warnings.push(`当前搜索页只找到 ${capturedPosts.length} 篇可继续点击的帖子。`);
        break;
      }
      visitedPostIds.add(candidate.postId || candidate.url);
      updateStatus({
        currentIndex: index + 1,
        discoveredPosts: Math.max(taskStatus.discoveredPosts, candidates.length),
        message: `正在采集第 ${index + 1}/${taskStatus.targetPosts} 篇：${candidate.title || candidate.url}`
      });

      const capture = await sendCaptureMessage(activeTabId, {
        type: "XHS_CAPTURE_CLICK_AND_GET",
        candidate,
        maxComments: clampNumber(options.commentsPerPost, 20, 0, 80),
        scrollRounds: 3,
        scrollDelayMs: 550
      });
      const bestPost = pickBestPost(capture?.posts || [], candidate);
      if (!bestPost) {
        taskStatus.warnings.push(`第 ${index + 1} 篇未采集到帖子内容：${candidate.url}`);
        await delay(700);
        continue;
      }

      capturedPosts.push({
        ...candidate,
        ...bestPost,
        url: bestPost.url || candidate.url,
        title: bestPost.title || candidate.title || "小红书帖子",
        comments: (bestPost.comments || []).slice(0, clampNumber(options.commentsPerPost, 20, 0, 80))
      });

      updateStatus({
        capturedPosts: capturedPosts.length,
        capturedComments: capturedPosts.reduce((sum, post) => sum + (post.comments?.length || 0), 0)
      });
      await delay(700);
    }

    if (capturedPosts.length === 0) {
      throw new Error("没有采集到可分析帖子。请确认小红书已登录，并打开搜索结果页重试。");
    }

    updateStatus({
      phase: "analyzing",
      message: `已采集 ${capturedPosts.length} 篇帖子、${taskStatus.capturedComments} 条评论，正在发送 Worker 分析。`
    });

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
    // The active Xiaohongshu tab is intentionally kept open for the user.
  }
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
    .filter((post) => !/当前页|小红书|登录|通知|发布/.test(String(post.title || "")));
}

function dedupePosts(posts) {
  const seen = new Set();
  const results = [];
  for (const post of posts) {
    const key = post.postId || post.url;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(post);
  }
  return results;
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

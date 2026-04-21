(() => {
  if (window.__xhsOpinionContentInstalled) {
    return;
  }
  window.__xhsOpinionContentInstalled = true;

  const MAX_NETWORK_PAYLOADS = 80;
  const networkPayloads = [];

  if (localStorage.getItem("xhsOpinionCaptureNetwork") === "1") {
    injectBridge();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.type !== "XHS_OPINION_NETWORK_PAYLOAD") {
      return;
    }
    networkPayloads.push({
      source: event.data.source,
      url: event.data.url,
      payload: event.data.payload,
      capturedAt: Date.now()
    });
    if (networkPayloads.length > MAX_NETWORK_PAYLOADS) {
      networkPayloads.shift();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "XHS_CAPTURE_GET") {
      sendResponse(buildCapture());
      return false;
    }
    if (message?.type === "XHS_CAPTURE_SEARCH_SCROLL_AND_GET") {
      scrollSearchAndCapture(message).then(sendResponse).catch((error) => {
        sendResponse({
          ok: false,
          pageUrl: location.href,
          pageTitle: document.title,
          error: error instanceof Error ? error.message : String(error),
          posts: [],
          totals: { posts: 0, comments: 0 }
        });
      });
      return true;
    }
    if (message?.type === "XHS_CAPTURE_SCROLL_AND_GET") {
      scrollAndCapture(message).then(sendResponse).catch((error) => {
        sendResponse({
          ok: false,
          pageUrl: location.href,
          pageTitle: document.title,
          error: error instanceof Error ? error.message : String(error),
          posts: [],
          totals: { posts: 0, comments: 0 }
        });
      });
      return true;
    }
    if (message?.type === "XHS_CAPTURE_CLICK_AND_GET") {
      clickPostAndCapture(message).then(sendResponse).catch((error) => {
        sendResponse({
          ok: false,
          pageUrl: location.href,
          pageTitle: document.title,
          error: error instanceof Error ? error.message : String(error),
          posts: [],
          totals: { posts: 0, comments: 0 }
        });
      });
      return true;
    }
    return false;
  });

  function injectBridge() {
    if (window.__xhsOpinionBridgeInjected) {
      return;
    }
    window.__xhsOpinionBridgeInjected = true;
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.onload = () => script.remove();
    (document.documentElement || document.head || document.body).appendChild(script);
  }

  function buildCapture() {
    const networkPosts = normalizeNetworkPayloads(networkPayloads.map((item) => item.payload));
    const domPosts = extractDomPosts();
    const posts = mergePosts([...domPosts, ...networkPosts]);
    return {
      ok: true,
      pageUrl: location.href,
      pageTitle: document.title,
      keywordGuess: guessKeyword(),
      networkPayloadCount: networkPayloads.length,
      posts,
      totals: {
        posts: posts.length,
        comments: posts.reduce((sum, post) => sum + post.comments.length, 0)
      }
    };
  }

  async function scrollAndCapture(options) {
    if (options.enableNetwork) {
      injectBridge();
      await delay(250);
    }
    const scrollRounds = Number(options.scrollRounds || 3);
    const scrollDelayMs = Number(options.scrollDelayMs || 550);
    const maxComments = Number(options.maxComments || 80);
    for (let index = 0; index < scrollRounds; index += 1) {
      const scroller = findCommentScroller();
      scroller.scrollBy({ top: Math.max(600, scroller.clientHeight || 700), behavior: "smooth" });
      window.scrollBy({ top: 500, behavior: "smooth" });
      await delay(scrollDelayMs);
    }
    const capture = buildCapture();
    capture.posts = capture.posts.map((post) => ({
      ...post,
      comments: (post.comments || []).slice(0, maxComments)
    }));
    capture.totals = {
      posts: capture.posts.length,
      comments: capture.posts.reduce((sum, post) => sum + post.comments.length, 0)
    };
    return capture;
  }

  async function scrollSearchAndCapture(options) {
    if (options.enableNetwork) {
      injectBridge();
      await delay(250);
    }
    const rounds = Number(options.rounds || 4);
    const delayMs = Number(options.delayMs || 700);
    for (let index = 0; index < rounds; index += 1) {
      window.scrollBy({ top: Math.max(700, window.innerHeight * 0.8), behavior: "smooth" });
      await delay(delayMs);
      const capture = buildCapture();
      if (capture.posts.length >= Number(options.minPosts || 3)) {
        return capture;
      }
    }
    return buildCapture();
  }

  async function clickPostAndCapture(options) {
    const candidate = options.candidate || {};
    const startUrl = location.href;
    const anchor = findPostAnchor(candidate);
    if (!anchor) {
      throw new Error(`没有在当前搜索页找到帖子卡片：${candidate.postId || candidate.url || ""}`);
    }

    anchor.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await delay(450);
    anchor.removeAttribute("target");
    anchor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    anchor.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    anchor.click();

    await waitForPostOpen(candidate, startUrl, 8000);
    await delay(900);
    const capture = await scrollAndCapture(options);
    const postId = getPostIdFromUrl(location.href) || candidate.postId || getPostIdFromUrl(candidate.url || "");
    const bestPost = pickBestPost(capture.posts || [], postId);
    await returnToSearchPage(startUrl);

    return {
      ...capture,
      posts: bestPost ? [bestPost] : capture.posts
    };
  }

  function extractDomPosts() {
    const posts = [];
    const currentPostId = getPostIdFromUrl(location.href);
    if (currentPostId) {
      posts.push({
        postId: currentPostId,
        url: location.href,
        title: cleanText(document.querySelector("h1")?.textContent || document.title.replace(/ - 小红书$/, "")),
        description: cleanText(document.querySelector("[class*='desc'], [class*='content']")?.textContent || ""),
        authorHash: "dom-author",
        tags: extractTags(),
        comments: extractDomComments(currentPostId, location.href)
      });
    }

    const links = Array.from(document.querySelectorAll("a[href]"));
    for (const anchor of links) {
      const href = new URL(anchor.getAttribute("href"), location.href).href;
      const postId = getPostIdFromUrl(href);
      if (!postId) {
        continue;
      }
      posts.push({
        postId,
        url: href,
        title: cleanText(anchor.getAttribute("aria-label") || anchor.textContent || "小红书帖子"),
        description: "",
        authorHash: "dom-author",
        tags: [],
        comments: []
      });
    }
    posts.push(...extractPostsFromHtml());
    return posts;
  }

  function extractPostsFromHtml() {
    const htmlVariants = getHtmlUrlVariants(document.documentElement.innerHTML);
    const posts = [];
    const seen = new Set();
    const pattern = /(?:https?:\/\/www\.xiaohongshu\.com)?\/(?:explore|discovery\/item)\/([0-9a-fA-F]{12,32})(?:\?[^"'<>\\\s]*)?/g;
    for (const html of htmlVariants) {
      for (const match of html.matchAll(pattern)) {
        const postId = match[1];
        if (!postId || seen.has(postId)) {
          continue;
        }
        const url = normalizeExtractedPostUrl(match[0], postId);
        seen.add(postId);
        posts.push({
          postId,
          url,
          title: inferTitleNearPostId(postId) || "小红书帖子",
          description: "",
          authorHash: "dom-html-author",
          tags: [],
          comments: []
        });
      }
    }
    return posts;
  }

  function getHtmlUrlVariants(html) {
    const normalized = String(html || "")
      .replace(/&amp;/g, "&")
      .replace(/\\u002F/g, "/")
      .replace(/\\\//g, "/")
      .replace(/%2F/gi, "/")
      .replace(/%3F/gi, "?")
      .replace(/%26/gi, "&")
      .replace(/%3D/gi, "=");
    return Array.from(new Set([html, normalized, decodeText(normalized)]));
  }

  function normalizeExtractedPostUrl(rawUrl, postId) {
    const href = String(rawUrl || "");
    try {
      const url = new URL(href.startsWith("http") ? href : `https://www.xiaohongshu.com${href}`);
      if (url.hostname !== "www.xiaohongshu.com") {
        return makePostUrl(postId);
      }
      return url.href;
    } catch {
      return makePostUrl(postId);
    }
  }

  function inferTitleNearPostId(postId) {
    const node = Array.from(document.querySelectorAll("section, div, a"))
      .find((element) => element.innerHTML.includes(postId));
    return cleanText(node?.textContent || "").slice(0, 80);
  }

  function extractDomComments(postId, postUrl) {
    const nodes = getCommentTextNodes();
    const seen = new Set();
    return nodes
      .map((node, index) => ({
        sampleId: `dom-${postId}-${index}`,
        commentId: `dom-${postId}-${index}`,
        postId,
        postUrl,
        text: cleanText(node.textContent || ""),
        userHash: "dom-user",
        commentLevel: 1,
        captureSource: "dom"
      }))
      .filter((comment) => {
        if (!isMeaningfulComment(comment.text) || seen.has(comment.text)) {
          return false;
        }
        seen.add(comment.text);
        return true;
      })
      .slice(0, 80);
  }

  function getCommentTextNodes() {
    const preferred = Array.from(
      document.querySelectorAll(
        "[class*='comment'] [class*='content']:not([class*='author']):not([class*='info']), [class*='comment'] [class*='text']"
      )
    );
    if (preferred.length > 0) {
      return preferred;
    }
    return Array.from(document.querySelectorAll("[class*='comment'] span, [class*='comment'] p, .comment-item, .comment-inner-container"));
  }

  function normalizeNetworkPayloads(payloads) {
    const posts = new Map();
    const looseComments = [];
    for (const payload of payloads) {
      walk(payload, (node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) {
          return;
        }
        const post = parseNetworkPost(node);
        if (post && !posts.has(post.postId)) {
          posts.set(post.postId, post);
        }
        const comment = parseNetworkComment(node);
        if (comment) {
          const targetPostId = comment.postId || getPostIdFromUrl(location.href) || "network-current-post";
          comment.postId = targetPostId;
          comment.postUrl = comment.postUrl || makePostUrl(targetPostId);
          const target = posts.get(targetPostId) || {
            postId: targetPostId,
            url: comment.postUrl,
            title: document.title.replace(/ - 小红书$/, "") || "小红书帖子",
            description: "",
            authorHash: "network-author",
            tags: [],
            comments: []
          };
          target.comments.push(comment);
          posts.set(targetPostId, target);
          looseComments.push(comment);
        }
      });
    }
    return Array.from(posts.values()).map((post) => ({
      ...post,
      comments: dedupeComments(post.comments).slice(0, 80)
    }));
  }

  function parseNetworkPost(node) {
    const noteCard = node.note_card || node.noteCard || node;
    const postId = cleanText(node.note_id || node.noteId || noteCard.note_id || noteCard.noteId || noteCard.id || node.id);
    const title = cleanText(noteCard.display_title || noteCard.title || noteCard.name || "");
    const description = cleanText(noteCard.desc || noteCard.description || noteCard.content || "");
    const xsecToken = cleanText(node.xsec_token || node.xsecToken || noteCard.xsec_token || noteCard.xsecToken || "");
    const xsecSource = cleanText(node.xsec_source || node.xsecSource || noteCard.xsec_source || noteCard.xsecSource || "pc_search");
    const looksLikePost = postId && (title || description) && (
      "note_card" in node ||
      "noteCard" in node ||
      "display_title" in noteCard ||
      "interact_info" in noteCard ||
      String(node.type || "").includes("note")
    );
    if (!looksLikePost) {
      return null;
    }
    return {
      postId,
      url: makePostUrl(postId, { xsecToken, xsecSource }),
      title: title || description.slice(0, 40) || "小红书帖子",
      description,
      authorHash: cleanText(noteCard.user?.user_id || noteCard.user_info?.user_id || "network-author"),
      tags: [],
      comments: []
    };
  }

  function parseNetworkComment(node) {
    const text = cleanText(node.content || node.text || node.comment_content || "");
    const commentId = cleanText(node.comment_id || node.commentId || node.id || "");
    const postId = cleanText(node.note_id || node.noteId || node.note?.id || "");
    const looksLikeComment = text && (
      Boolean(commentId) ||
      "sub_comments" in node ||
      "comment_id" in node ||
      "commentId" in node ||
      String(node.type || "").includes("comment")
    );
    if (!looksLikeComment || !isMeaningfulComment(text)) {
      return null;
    }
    return {
      sampleId: `network-${commentId || hashText(text)}`,
      commentId: commentId || hashText(text),
      postId,
      postUrl: postId ? makePostUrl(postId) : location.href,
      text,
      userHash: cleanText(node.user_info?.user_id || node.user?.id || "network-user"),
      commentLevel: Number(node.level || node.comment_level || 1) || 1,
      captureSource: "network"
    };
  }

  function walk(value, visitor, depth = 0) {
    if (depth > 8 || value == null) {
      return;
    }
    visitor(value);
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, visitor, depth + 1));
    } else if (typeof value === "object") {
      Object.values(value).forEach((item) => walk(item, visitor, depth + 1));
    }
  }

  function mergePosts(posts) {
    const merged = new Map();
    for (const post of posts) {
      if (!post.postId) {
        continue;
      }
      const existing = merged.get(post.postId);
      if (!existing) {
        merged.set(post.postId, { ...post, comments: dedupeComments(post.comments || []) });
        continue;
      }
      existing.title = existing.title || post.title;
      existing.description = existing.description || post.description;
      if (shouldPreferPostUrl(post.url, existing.url)) {
        existing.url = post.url;
      }
      existing.comments = dedupeComments([...(existing.comments || []), ...(post.comments || [])]);
    }
    return Array.from(merged.values()).slice(0, 30);
  }

  function findPostAnchor(candidate) {
    const postId = String(candidate.postId || getPostIdFromUrl(candidate.url || "") || "");
    const targetUrl = String(candidate.url || "");
    const anchors = Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => {
        const href = new URL(anchor.getAttribute("href"), location.href).href;
        const rect = anchor.getBoundingClientRect();
        return { anchor, href, rect };
      })
      .filter(({ href, rect }) => {
        if (!postId && !targetUrl) {
          return false;
        }
        return rect.width > 0 && rect.height > 0 && (href.includes(postId) || href === targetUrl);
      })
      .sort((left, right) => scorePostAnchor(right) - scorePostAnchor(left));
    return anchors[0]?.anchor || null;
  }

  function scorePostAnchor(item) {
    let score = 0;
    if (item.href.includes("xsec_token")) {
      score += 20;
    }
    score += Math.min(20, Math.round(item.rect.width / 20));
    score += Math.min(20, Math.round(item.rect.height / 20));
    return score;
  }

  function pickBestPost(posts, postId) {
    const exact = posts.find((post) => post.postId === postId);
    if (exact) {
      return exact;
    }
    return posts
      .filter((post) => (post.comments || []).length > 0)
      .sort((left, right) => (right.comments?.length || 0) - (left.comments?.length || 0))[0] || posts[0] || null;
  }

  async function waitForPostOpen(candidate, startUrl, timeoutMs) {
    const postId = String(candidate.postId || getPostIdFromUrl(candidate.url || "") || "");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const currentPostId = getPostIdFromUrl(location.href);
      const hasComments = document.body?.innerText?.includes("评论") || document.querySelector("[class*='comment']");
      if ((currentPostId && (!postId || currentPostId === postId)) || (location.href !== startUrl && hasComments)) {
        return;
      }
      await delay(250);
    }
  }

  async function returnToSearchPage(startUrl) {
    if (location.href !== startUrl) {
      history.back();
      await delay(900);
      return;
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" }));
    const closeNode = Array.from(document.querySelectorAll("button, div, span"))
      .find((node) => /关闭|返回|×|Close/i.test(cleanText(node.textContent || "")));
    closeNode?.click?.();
    await delay(500);
  }

  function dedupeComments(comments) {
    const seen = new Set();
    return comments.filter((comment) => {
      const text = cleanText(comment.text);
      if (!text || seen.has(text)) {
        return false;
      }
      seen.add(text);
      comment.text = text;
      return true;
    });
  }

  function guessKeyword() {
    const url = new URL(location.href);
    return cleanText(decodeText(url.searchParams.get("keyword") || document.title.split(" - ")[0] || "小红书"));
  }

  function extractTags() {
    return Array.from(document.querySelectorAll("a, span"))
      .map((node) => cleanText(node.textContent || ""))
      .filter((text) => /^#.{1,30}/.test(text))
      .slice(0, 12);
  }

  function getPostIdFromUrl(url) {
    return String(url || "").match(/\/(?:explore|discovery\/item)\/([^/?#]+)/)?.[1] || "";
  }

  function makePostUrl(postId, options = {}) {
    const url = new URL(`https://www.xiaohongshu.com/explore/${postId}`);
    if (options.xsecToken) {
      url.searchParams.set("xsec_token", options.xsecToken);
    }
    if (options.xsecSource) {
      url.searchParams.set("xsec_source", options.xsecSource);
    }
    return url.href;
  }

  function shouldPreferPostUrl(nextUrl, currentUrl) {
    const next = String(nextUrl || "");
    const current = String(currentUrl || "");
    if (!current) {
      return true;
    }
    if (next.includes("xsec_token") && !current.includes("xsec_token")) {
      return true;
    }
    if (next.includes("?") && !current.includes("?")) {
      return true;
    }
    return false;
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
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
    return decoded;
  }

  function isMeaningfulComment(text) {
    if (text.length < 4 || text.length > 300) {
      return false;
    }
    if (/^(回复|展开|收起|赞|分享|收藏|更多|登录|发布|关注|作者赞过|上海|北京|广东|山东|广西|浙江|江苏)$/u.test(text)) {
      return false;
    }
    if (/^\d+$/.test(text) || /^\d{2}-\d{2}$/.test(text) || /^赞\s*回复?$/.test(text)) {
      return false;
    }
    if (!/[，。！？!?、]/u.test(text) && text.length <= 6) {
      return false;
    }
    return /[\u4e00-\u9fa5A-Za-z0-9]/.test(text);
  }

  function hashText(text) {
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(31, hash) + text.charCodeAt(index) | 0;
    }
    return `h${Math.abs(hash)}`;
  }

  function findCommentScroller() {
    const candidates = Array.from(document.querySelectorAll("[class*='comment'], [class*='scroll'], main, body"));
    const scrollable = candidates.find((node) => {
      const element = node;
      return element.scrollHeight > element.clientHeight + 100;
    });
    return scrollable || document.scrollingElement || document.documentElement;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();

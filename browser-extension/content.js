(() => {
  const MAX_NETWORK_PAYLOADS = 80;
  const networkPayloads = [];

  injectBridge();

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
    if (message?.type !== "XHS_CAPTURE_GET") {
      return false;
    }
    sendResponse(buildCapture());
    return false;
  });

  function injectBridge() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.onload = () => script.remove();
    (document.documentElement || document.head || document.body).appendChild(script);
  }

  function buildCapture() {
    const networkPosts = normalizeNetworkPayloads(networkPayloads.map((item) => item.payload));
    const domPosts = extractDomPosts();
    const posts = mergePosts([...networkPosts, ...domPosts]);
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
    return posts;
  }

  function extractDomComments(postId, postUrl) {
    const nodes = Array.from(
      document.querySelectorAll(
        "[class*='comment'] [class*='content'], [class*='comment'] span, [class*='comment'] p, .comment-item, .comment-inner-container"
      )
    );
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
      url: makePostUrl(postId),
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
      existing.comments = dedupeComments([...(existing.comments || []), ...(post.comments || [])]);
    }
    return Array.from(merged.values()).slice(0, 30);
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
    return cleanText(url.searchParams.get("keyword") || document.title.split(" - ")[0] || "小红书");
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

  function makePostUrl(postId) {
    return `https://www.xiaohongshu.com/explore/${postId}`;
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isMeaningfulComment(text) {
    if (text.length < 2 || text.length > 300) {
      return false;
    }
    if (/^(回复|展开|收起|赞|分享|收藏|更多|登录|发布|关注|作者赞过)$/u.test(text)) {
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
})();

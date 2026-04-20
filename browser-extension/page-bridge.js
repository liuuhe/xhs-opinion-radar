(() => {
  if (window.__xhsOpinionBridgeInstalled) {
    return;
  }
  window.__xhsOpinionBridgeInstalled = true;

  const emit = (source, url, payload) => {
    try {
      window.postMessage(
        {
          type: "XHS_OPINION_NETWORK_PAYLOAD",
          source,
          url: String(url || location.href),
          payload
        },
        "*"
      );
    } catch {
      // Ignore non-cloneable payloads.
    }
  };

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    try {
      const clone = response.clone();
      const contentType = clone.headers.get("content-type") || "";
      if (contentType.includes("json")) {
        clone.json().then((payload) => emit("fetch", args[0]?.url || args[0], payload)).catch(() => undefined);
      }
    } catch {
      // Keep the page request path untouched.
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__xhsOpinionUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    this.addEventListener("load", () => {
      try {
        const contentType = this.getResponseHeader("content-type") || "";
        if (contentType.includes("json") && typeof this.responseText === "string") {
          emit("xhr", this.__xhsOpinionUrl, JSON.parse(this.responseText));
        }
      } catch {
        // Ignore parse failures.
      }
    });
    return originalSend.apply(this, args);
  };
})();

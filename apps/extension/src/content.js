const PAGE_SOURCE = "thumper-page";
const EXT_SOURCE = "thumper-extension";

function announceReady() {
  window.postMessage(
    { source: EXT_SOURCE, type: "extension-ready" },
    window.location.origin,
  );
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== PAGE_SOURCE) return;

  if (data.type === "ping") {
    announceReady();
    return;
  }

  if (data.type !== "sync-cookies") return;

  const requestId = data.requestId;
  const origin = window.location.origin;

  chrome.runtime.sendMessage(
    { type: "sync-all-cookies", origin },
    (response) => {
      const err = chrome.runtime.lastError;
      window.postMessage(
        {
          source: EXT_SOURCE,
          type: "sync-cookies-result",
          requestId,
          ...(err
            ? { ok: false, error: err.message || "Extension unavailable" }
            : response || { ok: false, error: "No response from extension" }),
        },
        window.location.origin,
      );
    },
  );
});

// Content scripts often run before React mounts — announce now and again shortly after.
announceReady();
setTimeout(announceReady, 250);
setTimeout(announceReady, 1000);

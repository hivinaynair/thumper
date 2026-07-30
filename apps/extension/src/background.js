const PROVIDERS = {
  youtube: [".youtube.com", ".google.com"],
  soundcloud: [".soundcloud.com"],
};

const AUTH_COOKIE_NAMES = {
  youtube: new Set([
    "SID",
    "SSID",
    "LOGIN_INFO",
    "__Secure-1PSID",
    "__Secure-3PSID",
  ]),
  soundcloud: new Set(["oauth_token", "oauth_token_refresh"]),
};

function getCookiesForDomains(domains) {
  return Promise.all(
    domains.map(
      (domain) =>
        new Promise((resolve) => {
          chrome.cookies.getAll({ domain }, (cookies) => resolve(cookies || []));
        }),
    ),
  ).then((groups) => groups.flat());
}

function toNetscape(cookies) {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Exported by Thumper Cookie Sync",
  ];
  for (const c of cookies) {
    const includeSub = c.domain?.startsWith(".") ? "TRUE" : "FALSE";
    const secure = c.secure ? "TRUE" : "FALSE";
    const exp = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    lines.push(
      [
        c.domain || "",
        includeSub,
        c.path || "/",
        secure,
        String(exp),
        c.name,
        c.value,
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

function looksLoggedIn(provider, cookies) {
  const names = AUTH_COOKIE_NAMES[provider];
  if (!names) return cookies.length > 0;
  return cookies.some((c) => names.has(c.name));
}

async function exportProvider(provider) {
  const domains = PROVIDERS[provider];
  if (!domains) throw new Error("Unknown provider");
  const cookies = await getCookiesForDomains(domains);
  return {
    cookies: toNetscape(cookies),
    count: cookies.length,
    loggedIn: looksLoggedIn(provider, cookies),
  };
}

async function uploadCookies(origin, provider, netscapeText) {
  const res = await fetch(`${origin}/api/cookies`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, cookies: netscapeText }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

async function syncAll(origin) {
  const results = {
    youtube: { status: "pending" },
    soundcloud: { status: "pending" },
  };

  const yt = await exportProvider("youtube");
  if (!yt.loggedIn) {
    results.youtube = {
      status: "skipped",
      reason: "Not signed in to YouTube in this browser",
    };
  } else {
    await uploadCookies(origin, "youtube", yt.cookies);
    results.youtube = { status: "synced" };
  }

  const sc = await exportProvider("soundcloud");
  if (!sc.loggedIn) {
    results.soundcloud = {
      status: "skipped",
      reason: "Not signed in to SoundCloud — skipped",
    };
  } else {
    await uploadCookies(origin, "soundcloud", sc.cookies);
    results.soundcloud = { status: "synced" };
  }

  const synced = ["youtube", "soundcloud"].filter(
    (p) => results[p].status === "synced",
  );
  if (synced.length === 0) {
    return {
      ok: false,
      error: "No signed-in sessions found for YouTube or SoundCloud",
      results,
    };
  }

  return { ok: true, results };
}

function summarize(results) {
  const parts = [];
  if (results.youtube.status === "synced") parts.push("YouTube synced");
  if (results.youtube.status === "skipped") parts.push("YouTube skipped");
  if (results.soundcloud.status === "synced") parts.push("SoundCloud synced");
  if (results.soundcloud.status === "skipped") parts.push("SoundCloud skipped");
  return parts.join(" · ");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "export-cookies") {
    exportProvider(message.provider)
      .then((data) => sendResponse(data))
      .catch((err) =>
        sendResponse({
          error: err instanceof Error ? err.message : "Export failed",
        }),
      );
    return true;
  }

  if (message?.type === "sync-all-cookies") {
    const origin = String(message.origin || "").replace(/\/$/, "");
    if (!origin) {
      sendResponse({ ok: false, error: "Missing Thumper origin" });
      return true;
    }
    syncAll(origin)
      .then((result) => {
        sendResponse({
          ...result,
          message: result.ok
            ? summarize(result.results)
            : result.error || "Sync failed",
        });
      })
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : "Sync failed",
        }),
      );
    return true;
  }

  return undefined;
});

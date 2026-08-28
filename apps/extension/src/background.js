const PROVIDERS = {
  youtube: [".youtube.com", ".google.com"],
  soundcloud: [".soundcloud.com"],
  // sp_dc lives on .spotify.com; accounts.* is needed for Hypeddit OAuth.
  spotify: [".spotify.com"],
  // sessionid lives on .instagram.com; used for Hypeddit Instagram follows.
  instagram: [".instagram.com", "instagram.com"],
};

const WARM_URLS = {
  youtube: "https://www.youtube.com/",
  soundcloud: "https://soundcloud.com/",
  spotify: "https://open.spotify.com/",
  instagram: "https://www.instagram.com/",
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
  spotify: new Set(["sp_dc", "sp_key"]),
  instagram: new Set(["sessionid", "ds_user_id"]),
};

const SYNC_PROVIDERS = ["youtube", "soundcloud", "spotify", "instagram"];

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

function getCookiesForUrl(url) {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ url }, (cookies) => resolve(cookies || []));
  });
}

function mergeCookies(...groups) {
  const byId = new Map();
  for (const cookies of groups) {
    for (const cookie of cookies) {
      byId.set(
        `${cookie.domain}\t${cookie.path}\t${cookie.name}`,
        cookie,
      );
    }
  }
  return [...byId.values()];
}

async function collectCookies(provider) {
  const domains = PROVIDERS[provider] || [];
  const fromDomains = await getCookiesForDomains(domains);
  const url = WARM_URLS[provider];
  const fromUrl = url ? await getCookiesForUrl(url) : [];
  return mergeCookies(fromDomains, fromUrl);
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

/**
 * Hit the site in a background tab so Chrome refreshes rotated session
 * cookies before we export. Google especially invalidates older exports
 * once you've browsed YouTube again.
 */
async function warmProvider(provider) {
  const url = WARM_URLS[provider];
  if (!url || !chrome.tabs?.create) return;

  let tabId;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    if (tabId == null) return;

    await new Promise((resolve) => {
      const done = () => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      };
      const onUpdated = (id, info) => {
        if (id === tabId && info.status === "complete") done();
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      setTimeout(done, 8_000);
    });
  } catch {
    /* best-effort — export whatever is in the jar */
  } finally {
    if (tabId != null) {
      await chrome.tabs.remove(tabId).catch(() => undefined);
    }
  }
}

async function exportProvider(provider, { warm = true } = {}) {
  const domains = PROVIDERS[provider];
  if (!domains) throw new Error("Unknown provider");
  if (warm) await warmProvider(provider);
  const cookies = await collectCookies(provider);
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

const SKIP_REASONS = {
  youtube: "Not signed in to YouTube in this browser",
  soundcloud: "Not signed in to SoundCloud — skipped",
  spotify: "Not signed in to Spotify — skipped",
  instagram: "Not signed in to Instagram — skipped",
};

async function syncAll(origin) {
  const results = {
    youtube: { status: "pending" },
    soundcloud: { status: "pending" },
    spotify: { status: "pending" },
    instagram: { status: "pending" },
  };

  for (const provider of SYNC_PROVIDERS) {
    const exported = await exportProvider(provider);
    if (!exported.loggedIn) {
      results[provider] = {
        status: "skipped",
        reason: SKIP_REASONS[provider],
      };
      continue;
    }
    await uploadCookies(origin, provider, exported.cookies);
    results[provider] = { status: "synced" };
  }

  const synced = SYNC_PROVIDERS.filter(
    (p) => results[p].status === "synced",
  );
  if (synced.length === 0) {
    return {
      ok: false,
      error:
        "No signed-in sessions found for YouTube, SoundCloud, Spotify, or Instagram",
      results,
    };
  }

  return { ok: true, results };
}

function summarize(results) {
  const parts = [];
  if (results.youtube.status === "synced") parts.push("YouTube refreshed");
  if (results.youtube.status === "skipped") parts.push("YouTube skipped");
  if (results.soundcloud.status === "synced") parts.push("SoundCloud refreshed");
  if (results.soundcloud.status === "skipped") parts.push("SoundCloud skipped");
  if (results.spotify.status === "synced") parts.push("Spotify refreshed");
  if (results.spotify.status === "skipped") parts.push("Spotify skipped");
  if (results.instagram?.status === "synced") parts.push("Instagram refreshed");
  if (results.instagram?.status === "skipped") parts.push("Instagram skipped");
  return parts.join(" · ");
}

function extensionVersion() {
  return chrome.runtime.getManifest().version;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "export-cookies") {
    exportProvider(message.provider, { warm: message.warm !== false })
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
          version: extensionVersion(),
          message: result.ok
            ? summarize(result.results)
            : result.error || "Sync failed",
        });
      })
      .catch((err) =>
        sendResponse({
          ok: false,
          version: extensionVersion(),
          error: err instanceof Error ? err.message : "Sync failed",
        }),
      );
    return true;
  }

  return undefined;
});

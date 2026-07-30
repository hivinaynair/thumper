const PROVIDERS = {
  youtube: [".youtube.com", ".google.com"],
  soundcloud: [".soundcloud.com"],
  patreon: [".patreon.com"],
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "export-cookies") return;
  const provider = message.provider;
  const domains = PROVIDERS[provider];
  if (!domains) {
    sendResponse({ error: "Unknown provider" });
    return true;
  }

  Promise.all(
    domains.map(
      (domain) =>
        new Promise((resolve) => {
          chrome.cookies.getAll({ domain }, (cookies) => resolve(cookies || []));
        }),
    ),
  ).then((groups) => {
    const cookies = groups.flat();
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
    sendResponse({ cookies: lines.join("\n") });
  });

  return true;
});

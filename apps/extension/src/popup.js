const originInput = document.getElementById("origin");
const providerSelect = document.getElementById("provider");
const msg = document.getElementById("msg");

chrome.storage.sync.get(["origin"], (data) => {
  originInput.value = data.origin || "http://localhost:3000";
});

document.getElementById("sync").addEventListener("click", async () => {
  const origin = originInput.value.replace(/\/$/, "");
  const provider = providerSelect.value;
  await chrome.storage.sync.set({ origin });
  msg.textContent = "Exporting…";

  chrome.runtime.sendMessage(
    { type: "export-cookies", provider },
    async (response) => {
      if (!response?.cookies) {
        msg.textContent = response?.error || "Export failed";
        return;
      }
      try {
        const res = await fetch(`${origin}/api/cookies`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, cookies: response.cookies }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          msg.textContent = data.error || `HTTP ${res.status}`;
          return;
        }
        msg.textContent = "Synced. Stay signed in to Thumper in this browser.";
      } catch (err) {
        msg.textContent = err instanceof Error ? err.message : "Request failed";
      }
    },
  );
});

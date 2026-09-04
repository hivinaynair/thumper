const originInput = document.getElementById("origin");
const msg = document.getElementById("msg");

const DEFAULT_ORIGIN = "https://thumper.vinaynair.dev";

chrome.storage.sync.get(["origin"], (data) => {
  originInput.value = data.origin || DEFAULT_ORIGIN;
});

document.getElementById("sync").addEventListener("click", async () => {
  const origin = originInput.value.replace(/\/$/, "");
  await chrome.storage.sync.set({ origin });
  msg.textContent = "Refreshing sessions…";

  chrome.runtime.sendMessage(
    { type: "sync-all-cookies", origin },
    (response) => {
      if (chrome.runtime.lastError) {
        msg.textContent = chrome.runtime.lastError.message || "Extension error";
        return;
      }
      if (!response?.ok) {
        msg.textContent = response?.error || response?.message || "Refresh failed";
        return;
      }
      msg.textContent =
        response.message ||
        "Refreshed. Stay signed in to YouTube/SoundCloud/Spotify in this browser.";
    },
  );
});

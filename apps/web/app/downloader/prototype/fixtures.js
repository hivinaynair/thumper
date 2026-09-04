// PROTOTYPE — paste this whole file into the devtools console on /downloader.
//
// Auth is bypassed in proxy.ts for local viewing, but /api/jobs guards itself
// with its own auth() call and still 401s — so without this the variants render
// empty, which is exactly the case they're least interesting in. This patches
// window.fetch so the page's 1.5s poll gets a queue worth judging: one Spotify
// playlist parent with five children spanning the whole verdict range, plus a
// standalone original and a manual-gate job.
(() => {
  const kid = (id, artist, title, status, result, error) => ({
    id, status,
    stage: status === "completed" ? "done" : status,
    progress: status === "completed" ? 100 : status === "running" ? 47 : 0,
    sourceUrl: `https://open.spotify.com/track/${id}`,
    matchedUrl: `https://soundcloud.com/x/${id}`,
    artist, title, audioFormat: "flac", destination: "browser",
    error: error ?? null, result: result ?? null,
  });

  const children = [
    kid("c1", "Skee Mask", "Rev8617", "completed", { fileId: "f1", soundcloudOriginal: true, matchScore: 96 }),
    kid("c2", "Burial", "Archangel", "completed", { fileId: "f2", djTier: "marginal", djHeadline: "Marginal — lossy source, rolls off at 18.2 kHz", matchScore: 88, cutoffHz: 18200 }),
    kid("c3", "Overmono", "So U Kno", "completed", { fileId: "f3", djTier: "master", qualityLabel: "FLAC 24/44.1", matchScore: 94 }),
    kid("c4", "Peverelist", "Roll With The Punches", "failed", { clubReadyOnly: true, qualityRejected: true }),
    kid("c5", "Tim Reaper", "Nu Style", "failed", null, "Sign in to confirm you are not a bot — cookies stale"),
  ];

  const jobs = [
    { id: "p1", status: "running", stage: "downloading", progress: 62,
      sourceUrl: "https://open.spotify.com/playlist/37i9dQZF1DX", matchedUrl: null,
      title: "Late Night Bass", artist: null, audioFormat: "flac",
      destination: "browser", error: null,
      result: { playlist: true, trackCount: 5, childJobIds: children.map((c) => c.id), unmatchedCount: 1 } },
    ...children,
    { id: "s1", status: "completed", stage: "done", progress: 100,
      sourceUrl: "https://soundcloud.com/artist/track", matchedUrl: null,
      title: "Voidwalker", artist: "Sully", audioFormat: "wav",
      destination: "both", error: null,
      result: { fileId: "f9", driveUrl: "https://drive.google.com/x", hypedditOriginal: true, qualityLabel: "WAV 24/44.1" } },
    { id: "s2", status: "completed", stage: "done", progress: 100,
      sourceUrl: "https://www.youtube.com/watch?v=abc", matchedUrl: null,
      title: "Untitled Dub", artist: "Unknown", audioFormat: "alac",
      destination: "browser", error: null,
      result: { manualDownloadUrl: "https://hypeddit.com/x", manualDownloadTitle: "Free DL" } },
  ];

  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const cookies = {
    youtube: { present: true, updatedAt: ago(3.6e6) },
    soundcloud: { present: true, updatedAt: ago(7.2e6) },
    spotify: { present: false, updatedAt: null },
    instagram: { present: true, updatedAt: ago(9e7) },
  };

  if (window.__thumperFixtures) return "already patched";
  window.__thumperFixtures = true;
  const real = window.fetch.bind(window);
  const json = (body) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (url.includes("/api/jobs")) return json({ jobs });
    if (url.includes("/api/cookies")) return json({ cookies });
    return real(input, init);
  };
  return `patched — ${jobs.length} fixture jobs, refresh lands within ~1.5s`;
})();

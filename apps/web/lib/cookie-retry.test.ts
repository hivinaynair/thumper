import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  cookieNeedsRefresh,
  cookieProvidersNeeded,
  jobsToRetry,
  type RetryableJob,
  retryButtonLabel,
  splitByCookieReadiness,
} from "./cookie-retry";

const BOT_CHECK =
  "YouTube blocked this download (bot check), even with your synced cookies. Re-sync fresh YouTube cookies from a signed-in browser and retry.";

function job(partial: Partial<RetryableJob> & Pick<RetryableJob, "id">): RetryableJob {
  return {
    status: "failed",
    error: null,
    result: null,
    ...partial,
  };
}

describe("cookieNeedsRefresh", () => {
  it("matches YouTube bot-check failures", () => {
    expect(cookieNeedsRefresh(BOT_CHECK)).toBe(true);
  });

  it("ignores quality-gate failures", () => {
    expect(cookieNeedsRefresh("Not club-ready — source rolls off at 16 kHz")).toBe(false);
  });
});

describe("jobsToRetry", () => {
  it("retries a single failed track that needs fresh cookies", () => {
    const failed = job({ id: "track-1", error: BOT_CHECK });
    expect(jobsToRetry(failed, [failed]).map((row) => row.id)).toEqual(["track-1"]);
  });

  it("retries every failed child of a still-running playlist", () => {
    const parent = job({
      id: "uk-140",
      status: "running",
      error: null,
      result: {
        playlist: true,
        childJobIds: ["ok", "fail-a", "fail-b", "quality", "pending"],
      },
    });
    const children = [
      job({ id: "ok", status: "completed", error: null }),
      job({ id: "fail-a", error: BOT_CHECK }),
      job({ id: "fail-b", error: BOT_CHECK }),
      job({
        id: "quality",
        error: "Rejected: not club-ready",
      }),
      job({ id: "pending", status: "running", error: null }),
    ];

    expect(jobsToRetry(parent, [parent, ...children]).map((row) => row.id)).toEqual([
      "fail-a",
      "fail-b",
      "quality",
    ]);
  });

  it("does not re-expand a playlist parent that already has children", () => {
    const parent = job({
      id: "uk-140",
      status: "failed",
      error: BOT_CHECK,
      result: { playlist: true, childJobIds: ["fail-a"] },
    });
    const child = job({ id: "fail-a", error: BOT_CHECK });
    expect(jobsToRetry(parent, [parent, child]).map((row) => row.id)).toEqual(["fail-a"]);
  });

  it("does not retry cancelled tracks", () => {
    const cancelled = job({
      id: "cancelled",
      status: "cancelled",
      error: BOT_CHECK,
    });
    expect(jobsToRetry(cancelled, [cancelled])).toEqual([]);
  });

  it("retries a child posted on its own id, with no parent in the catalog", () => {
    const child = job({ id: "fail-a", error: "ffmpeg exited with code 1" });
    expect(jobsToRetry(child, [child]).map((row) => row.id)).toEqual(["fail-a"]);
  });

  it("retries a playlist parent that failed before any children existed", () => {
    const parent = job({
      id: "uk-140",
      error: BOT_CHECK,
      result: { playlist: true, childJobIds: [] },
    });
    expect(jobsToRetry(parent, [parent]).map((row) => row.id)).toEqual(["uk-140"]);
  });
});

describe("splitByCookieReadiness", () => {
  const present = {
    youtube: { present: true, updatedAt: "2026-10-18T10:00:00.000Z" },
    soundcloud: { present: true, updatedAt: null },
  };
  const noYoutube = {
    youtube: { present: false, updatedAt: null },
    soundcloud: { present: true, updatedAt: null },
  };

  it("lets everything through when the needed cookies are synced", () => {
    const failed = job({ id: "track-1", error: BOT_CHECK });
    const split = splitByCookieReadiness([failed], present);
    expect(split.ready.map((row) => row.id)).toEqual(["track-1"]);
    expect(split.blocked).toEqual([]);
    expect(split.reason).toBeNull();
  });

  it("holds back only the tracks that actually need the missing cookies", () => {
    const botCheck = job({ id: "bot", error: BOT_CHECK });
    const throttled = job({ id: "slow", error: "HTTP Error 429: Too Many Requests" });
    const split = splitByCookieReadiness([botCheck, throttled], noYoutube);
    expect(split.ready.map((row) => row.id)).toEqual(["slow"]);
    expect(split.blocked.map((row) => row.id)).toEqual(["bot"]);
    expect(split.reason).toBe("Sync YouTube cookies to retry 1 more");
  });

  it("retries non-cookie failures even with no cookie status at all", () => {
    const throttled = job({ id: "slow", error: "HTTP Error 429: Too Many Requests" });
    const split = splitByCookieReadiness([throttled], null);
    expect(split.ready.map((row) => row.id)).toEqual(["slow"]);
    expect(split.reason).toBeNull();
  });

  it("names both providers when a batch needs both", () => {
    const yt = job({ id: "yt", error: BOT_CHECK });
    const sc = job({
      id: "sc",
      error: "SoundCloud session is no longer usable — refresh SoundCloud cookies and retry.",
    });
    const split = splitByCookieReadiness([yt, sc], {
      youtube: { present: false, updatedAt: null },
      soundcloud: { present: false, updatedAt: null },
    });
    expect(split.ready).toEqual([]);
    expect(split.reason).toBe("Sync YouTube and SoundCloud cookies to retry 2 more");
  });
});

describe("cookieProvidersNeeded", () => {
  it("asks for SoundCloud cookies on a SoundCloud session failure", () => {
    const error = "SoundCloud session is no longer usable — refresh SoundCloud cookies and retry.";
    expect(cookieNeedsRefresh(error)).toBe(true);
    expect(cookieProvidersNeeded(error)).toEqual(["soundcloud"]);
  });
});

describe("retryButtonLabel", () => {
  it("names a single retry plainly and a batch by its size", () => {
    expect(retryButtonLabel(1)).toBe("Retry");
    expect(retryButtonLabel(11)).toBe("Retry 11 failed");
  });
});

describe("downloader wiring", () => {
  it("retries cookie-failed jobs through POST /api/jobs/:id/retry after a cookie sync", async () => {
    const page = await fs.readFile(
      path.join(import.meta.dir, "../app/downloader/page.tsx"),
      "utf8",
    );
    expect(page).toContain("retryJob");
    expect(page).toContain("classifyFailure");
    expect(page).toContain("/api/jobs/${");
    expect(page).toContain("/retry");
    expect(page).toContain("requestExtensionSync");
    expect(page).toContain("retryButtonLabel");
  });

  it("requeues from the retry route using the shared helpers", async () => {
    const route = await fs.readFile(
      path.join(import.meta.dir, "../app/api/jobs/[id]/retry/route.ts"),
      "utf8",
    );
    expect(route).toContain("jobsToRetry");
    expect(route).toContain("splitByCookieReadiness");
    expect(route).toContain("requeueFields");
    expect(route).toContain("wakeModalJob");
    expect(route).toContain("downloadPayloadFromJob");
  });
});

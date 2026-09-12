import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { isCookieStale, shouldRefreshCookiesBeforeQueue } from "./cookie-freshness";

const NOW = Date.parse("2026-09-12T22:00:00.000Z");
const FRESH = "2026-09-12T16:00:00.000Z"; // 6h old
const STALE = "2026-09-12T09:00:00.000Z"; // 13h old

describe("isCookieStale", () => {
  it("treats a YouTube session older than 12 hours as stale", () => {
    expect(isCookieStale(STALE, NOW)).toBe(true);
  });

  it("keeps a session under 12 hours as fresh", () => {
    expect(isCookieStale(FRESH, NOW)).toBe(false);
  });

  it("does not treat a missing timestamp as stale", () => {
    expect(isCookieStale(null, NOW)).toBe(false);
  });
});

describe("shouldRefreshCookiesBeforeQueue", () => {
  it("refreshes only when YouTube cookies are present, stale, and the extension can sync", () => {
    expect(
      shouldRefreshCookiesBeforeQueue({
        youtubePresent: true,
        youtubeUpdatedAt: STALE,
        extensionReady: true,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("does not refresh a fresh YouTube session on Add to queue", () => {
    expect(
      shouldRefreshCookiesBeforeQueue({
        youtubePresent: true,
        youtubeUpdatedAt: FRESH,
        extensionReady: true,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("does not refresh when there is no YouTube session to refresh", () => {
    expect(
      shouldRefreshCookiesBeforeQueue({
        youtubePresent: false,
        youtubeUpdatedAt: null,
        extensionReady: true,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("does not refresh when the extension is not available to sync", () => {
    expect(
      shouldRefreshCookiesBeforeQueue({
        youtubePresent: true,
        youtubeUpdatedAt: STALE,
        extensionReady: false,
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("downloader wiring", () => {
  it("refreshes stale cookies from Add to queue before POST /api/jobs", async () => {
    const page = await fs.readFile(
      path.join(import.meta.dir, "../app/downloader/page.tsx"),
      "utf8",
    );
    const createJob = page.slice(
      page.indexOf("async function createJob"),
      page.indexOf("async function cancelJob"),
    );
    expect(createJob.indexOf("shouldRefreshCookiesBeforeQueue")).toBeGreaterThan(-1);
    expect(createJob.indexOf("requestExtensionSync")).toBeGreaterThan(-1);
    expect(createJob.indexOf("requestExtensionSync")).toBeLessThan(
      createJob.indexOf('fetch("/api/jobs"'),
    );
    expect(createJob).toContain("Refreshing cookies…");
  });
});

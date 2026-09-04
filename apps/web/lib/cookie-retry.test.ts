import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  cookieNeedsRefresh,
  cookieProvidersNeeded,
  jobsToRetry,
  missingCookiesForRetry,
  retryButtonLabel,
  type RetryableJob,
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
    expect(cookieNeedsRefresh("Not club-ready — source rolls off at 16 kHz")).toBe(
      false,
    );
  });
});

describe("jobsToRetry", () => {
  it("retries a single failed track that needs fresh cookies", () => {
    const failed = job({ id: "track-1", error: BOT_CHECK });
    expect(jobsToRetry(failed, [failed]).map((row) => row.id)).toEqual([
      "track-1",
    ]);
  });

  it("retries only cookie-failed children of a still-running playlist", () => {
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

    expect(
      jobsToRetry(parent, [parent, ...children]).map((row) => row.id),
    ).toEqual(["fail-a", "fail-b"]);
  });

  it("does not re-expand a playlist parent that already has children", () => {
    const parent = job({
      id: "uk-140",
      status: "failed",
      error: BOT_CHECK,
      result: { playlist: true, childJobIds: ["fail-a"] },
    });
    const child = job({ id: "fail-a", error: BOT_CHECK });
    expect(jobsToRetry(parent, [parent, child]).map((row) => row.id)).toEqual([
      "fail-a",
    ]);
  });

  it("does not retry cancelled tracks", () => {
    const cancelled = job({
      id: "cancelled",
      status: "cancelled",
      error: BOT_CHECK,
    });
    expect(jobsToRetry(cancelled, [cancelled])).toEqual([]);
  });

  it("retries a playlist parent that failed before any children existed", () => {
    const parent = job({
      id: "uk-140",
      error: BOT_CHECK,
      result: { playlist: true, childJobIds: [] },
    });
    expect(jobsToRetry(parent, [parent]).map((row) => row.id)).toEqual([
      "uk-140",
    ]);
  });
});

describe("missingCookiesForRetry", () => {
  it("requires YouTube cookies for bot-check retries", () => {
    const failed = job({ id: "track-1", error: BOT_CHECK });
    expect(
      missingCookiesForRetry([failed], {
        youtube: { present: false, updatedAt: null },
        soundcloud: { present: true, updatedAt: null },
        spotify: { present: false, updatedAt: null },
      }),
    ).toBe("Sync YouTube cookies before retrying");
  });

  it("is ready when the needed cookies are present", () => {
    const failed = job({ id: "track-1", error: BOT_CHECK });
    expect(
      missingCookiesForRetry([failed], {
        youtube: { present: true, updatedAt: "2026-08-28T10:00:00.000Z" },
        soundcloud: { present: true, updatedAt: null },
        spotify: { present: false, updatedAt: null },
      }),
    ).toBeNull();
  });
});

describe("cookieProvidersNeeded", () => {
  it("asks for Spotify cookies on a Hypeddit session failure", () => {
    expect(
      cookieProvidersNeeded(
        "Spotify session is no longer usable — refresh Spotify cookies and retry.",
      ),
    ).toEqual(["spotify"]);
  });

  it("asks for SoundCloud cookies on a ToneDen session failure", () => {
    const error =
      "SoundCloud session is no longer usable — refresh SoundCloud cookies and retry.";
    expect(cookieNeedsRefresh(error)).toBe(true);
    expect(cookieProvidersNeeded(error)).toEqual(["soundcloud"]);
  });
});

describe("retryButtonLabel", () => {
  it("names the cookie retry for one track or several", () => {
    expect(retryButtonLabel(1)).toBe("Retry with new cookies");
    expect(retryButtonLabel(4)).toBe("Retry 4 with new cookies");
  });
});

describe("downloader wiring", () => {
  it("retries cookie-failed jobs through POST /api/jobs/:id/retry after a cookie sync", async () => {
    const page = await fs.readFile(
      path.join(import.meta.dir, "../app/downloader/page.tsx"),
      "utf8",
    );
    expect(page).toContain("retryWithNewCookies");
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
    expect(route).toContain("missingCookiesForRetry");
    expect(route).toContain("requeueFields");
    expect(route).toContain("wakeModalJob");
    expect(route).toContain("downloadPayloadFromJob");
  });
});

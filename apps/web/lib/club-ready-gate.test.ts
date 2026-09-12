import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { clubReadyAllowed, clubReadyOnlyRejected } from "./club-ready-gate";

describe("clubReadyAllowed", () => {
  it("unlocks Club-ready only for a confirmed YouTube Premium session", () => {
    expect(clubReadyAllowed(true)).toBe(true);
  });

  it("keeps Club-ready off for Music-only, unsigned, or unknown sessions", () => {
    expect(clubReadyAllowed(false)).toBe(false);
    expect(clubReadyAllowed(null)).toBe(false);
    expect(clubReadyAllowed(undefined)).toBe(false);
  });
});

describe("clubReadyOnlyRejected", () => {
  it("lets a normal download through regardless of Premium", () => {
    expect(clubReadyOnlyRejected(false, false)).toBeNull();
  });

  it("blocks Club-ready only when Premium has not been confirmed", () => {
    expect(clubReadyOnlyRejected(true, true)).toBeNull();
    expect(clubReadyOnlyRejected(true, false)).toBe(
      "Club-ready only needs a synced YouTube Premium session",
    );
    expect(clubReadyOnlyRejected(true, null)).toBe(
      "Club-ready only needs a synced YouTube Premium session",
    );
  });
});

describe("downloader wiring", () => {
  it("gates Club-ready on YouTube Premium in the page and job API", async () => {
    const page = await fs.readFile(
      path.join(import.meta.dir, "../app/downloader/page.tsx"),
      "utf8",
    );
    expect(page).toContain("clubReadyAllowed");
    expect(page).toContain("needs a synced YouTube Premium session");

    const route = await fs.readFile(path.join(import.meta.dir, "../app/api/jobs/route.ts"), "utf8");
    expect(route).toContain("clubReadyOnlyRejected");
    expect(route.indexOf("clubReadyOnlyRejected")).toBeLessThan(route.indexOf("insert(jobs)"));
  });
});

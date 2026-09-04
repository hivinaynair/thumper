import { describe, expect, it } from "bun:test";
import {
  groupJobs,
  jobLabel,
  playlistRollup,
  rollupSummary,
  verdictOf,
  type Job,
} from "./job-view";

function job(partial: Partial<Job> & Pick<Job, "id">): Job {
  return {
    status: "completed",
    stage: "done",
    progress: 100,
    sourceUrl: `https://example.com/${partial.id}`,
    audioFormat: "flac",
    destination: "browser",
    error: null,
    result: null,
    ...partial,
  };
}

describe("jobLabel", () => {
  it("prefers artist and title over the raw URL", () => {
    expect(jobLabel(job({ id: "a", artist: "Sully", title: "Voidwalker" }))).toBe(
      "Sully - Voidwalker",
    );
  });

  it("falls back to the source URL when the track is unidentified", () => {
    expect(jobLabel(job({ id: "a", sourceUrl: "https://x.test/t" }))).toBe(
      "https://x.test/t",
    );
  });
});

describe("groupJobs", () => {
  const parent = job({
    id: "p",
    result: { playlist: true, childJobIds: ["c1", "c2"] },
  });
  const c1 = job({ id: "c1" });
  const c2 = job({ id: "c2", status: "failed" });
  const loner = job({ id: "s" });

  it("keeps children out of the top level so a playlist renders once", () => {
    const { topLevel } = groupJobs([parent, c1, c2, loner]);
    expect(topLevel.map((j) => j.id)).toEqual(["p", "s"]);
  });

  it("returns a parent's children in queue order", () => {
    const { childrenOf } = groupJobs([parent, c1, c2, loner]);
    expect(childrenOf("p").map((j) => j.id)).toEqual(["c1", "c2"]);
    expect(childrenOf("s")).toEqual([]);
  });

  it("leaves children top-level when the parent is not in the list", () => {
    // The API caps the queue at 100 rows, so a parent can drop off while its
    // children remain; orphans must still render rather than vanish.
    const { topLevel } = groupJobs([c1, c2]);
    expect(topLevel.map((j) => j.id)).toEqual(["c1", "c2"]);
  });
});

describe("playlistRollup", () => {
  const byId = (jobs: Job[]) => new Map(jobs.map((j) => [j.id, j]));

  it("counts children by state", () => {
    const children = [
      job({ id: "c1" }),
      job({ id: "c2", status: "failed" }),
      job({ id: "c3", status: "running" }),
    ];
    const parent = job({
      id: "p",
      result: { playlist: true, childJobIds: ["c1", "c2", "c3"] },
    });
    const rollup = playlistRollup(parent, byId([parent, ...children]))!;
    expect(rollup).toMatchObject({ total: 3, done: 1, failed: 1, pending: 1 });
    expect(rollup.failedTracks.map((j) => j.id)).toEqual(["c2"]);
  });

  it("is null for a non-playlist job", () => {
    expect(playlistRollup(job({ id: "s" }), byId([]))).toBeNull();
  });

  it("is null before any child row exists", () => {
    const parent = job({ id: "p", result: { playlist: true, childJobIds: ["c1"] } });
    expect(playlistRollup(parent, byId([parent]))).toBeNull();
  });

  it("summarises only the non-zero counts", () => {
    expect(
      rollupSummary({ total: 3, done: 3, failed: 0, pending: 0, failedTracks: [] }),
    ).toBe("3/3 downloaded");
    expect(
      rollupSummary({ total: 3, done: 1, failed: 1, pending: 1, failedTracks: [] }),
    ).toBe("1/3 downloaded · 1 failed · 1 in progress");
  });
});

describe("verdictOf", () => {
  it("reports a failure ahead of anything the result claims", () => {
    const v = verdictOf(
      job({ id: "a", status: "failed", error: "bot check", result: { fileId: "f" } }),
    );
    expect(v).toMatchObject({ tier: "unsuitable", lead: "failed", detail: "bot check" });
  });

  it("explains a quality rejection rather than just naming it", () => {
    const v = verdictOf(job({ id: "a", result: { qualityRejected: true } }));
    expect(v.tier).toBe("unsuitable");
    expect(v.detail).toContain("19 kHz");
  });

  it("treats a store page as needing manual work", () => {
    const v = verdictOf(
      job({ id: "a", result: { manualDownloadUrl: "https://gate.test" } }),
    );
    expect(v).toMatchObject({ tier: "unsuitable", lead: "manual" });
  });

  it("marks artist originals as provenance wins", () => {
    expect(verdictOf(job({ id: "a", result: { hypedditOriginal: true } })).tier).toBe(
      "original",
    );
    expect(verdictOf(job({ id: "b", result: { soundcloudOriginal: true } })).tier).toBe(
      "original",
    );
  });

  it("carries the dj tier and its headline", () => {
    const v = verdictOf(
      job({
        id: "a",
        result: { djTier: "marginal", djHeadline: "Marginal — rolls off at 18.2 kHz" },
      }),
    );
    expect(v).toMatchObject({ tier: "marginal", lead: "marginal" });
    expect(v.detail).toContain("18.2 kHz");
  });

  it("prefers provenance over a lower dj tier, losing the tier", () => {
    // Documents the ordering rather than endorsing it: an artist original that
    // also reads marginal reports only "original".
    const v = verdictOf(
      job({ id: "a", result: { soundcloudOriginal: true, djTier: "marginal" } }),
    );
    expect(v.tier).toBe("original");
  });

  it("falls back to the stage while a job is still working", () => {
    const v = verdictOf(job({ id: "a", status: "running", stage: "downloading" }));
    expect(v).toMatchObject({ tier: "pending", lead: "downloading", detail: null });
  });
});

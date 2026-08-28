import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { ProcessCancelledError } from "@thumper/pipeline";
import type { DownloadJobPayload } from "@thumper/shared";
import {
  childJobResult,
  enqueuePlaylistChildren,
  fanoutIdsFromCompletedParent,
  writeFanoutChildIds,
} from "./playlist-fanout";

const PARENT_ID = "11111111-1111-1111-1111-111111111111";

function parent(
  overrides: Partial<DownloadJobPayload> = {},
): DownloadJobPayload {
  return {
    jobId: PARENT_ID,
    userId: "user-1",
    url: "https://music.youtube.com/playlist?list=PLtest",
    audioFormat: "flac",
    destination: "browser",
    ...overrides,
  };
}

describe("childJobResult", () => {
  it("stamps parentJobId so a spawned child does not re-expand the playlist", () => {
    expect(
      childJobResult(parent(), { driveFolderId: "folder-uk-140" }),
    ).toEqual({
      parentJobId: PARENT_ID,
      driveFolderId: "folder-uk-140",
    });
  });

  it("copies gate flags from the parent", () => {
    expect(
      childJobResult(
        parent({
          gateEmail: "hi@vinaynair.dev",
          gateName: "Vinay",
          clubReadyOnly: true,
        }),
      ),
    ).toEqual({
      parentJobId: PARENT_ID,
      gateEmail: "hi@vinaynair.dev",
      gateName: "Vinay",
      clubReadyOnly: true,
    });
  });
});

describe("fanoutIdsFromCompletedParent", () => {
  it("returns child ids only after the parent finished expanding", () => {
    expect(
      fanoutIdsFromCompletedParent({
        status: "completed",
        result: {
          playlist: true,
          childJobIds: ["a", "b"],
        },
      }),
    ).toEqual(["a", "b"]);
  });

  it("does not spawn when the parent was cancelled mid-enqueue", () => {
    expect(
      fanoutIdsFromCompletedParent({
        status: "cancelled",
        result: {
          playlist: true,
          childJobIds: ["a"],
        },
      }),
    ).toEqual([]);
  });
});

describe("enqueuePlaylistChildren", () => {
  it("queues YouTube and SoundCloud tracks without downloading them", async () => {
    const inserted: string[] = [];
    const published: string[][] = [];
    const ids = await enqueuePlaylistChildren({
      parent: parent(),
      tracks: [
        { url: "https://www.youtube.com/watch?v=aaa&list=PLtest", title: "A" },
        { url: "https://open.spotify.com/track/skip-me" },
        { url: "https://soundcloud.com/artist/b", title: "B" },
      ],
      insertChild: async ({ track }) => {
        const id = `child-${track.title ?? inserted.length}`;
        inserted.push(id);
        return { id };
      },
      publishChildIds: async (childIds) => {
        published.push([...childIds]);
      },
      cancelChildren: async () => {
        throw new Error("should not cancel");
      },
    });

    expect(ids).toEqual(["child-A", "child-B"]);
    expect(published).toEqual([["child-A"], ["child-A", "child-B"]]);
  });

  it("keeps going when one track cannot be inserted", async () => {
    const ids = await enqueuePlaylistChildren({
      parent: parent(),
      tracks: [
        { url: "https://www.youtube.com/watch?v=aaa", title: "A" },
        { url: "https://www.youtube.com/watch?v=bbb", title: "B" },
      ],
      insertChild: async ({ track }) => {
        if (track.title === "A") throw new Error("db blip");
        return { id: "child-B" };
      },
      publishChildIds: async () => {},
      cancelChildren: async () => {},
    });

    expect(ids).toEqual(["child-B"]);
  });

  it("cancels already-queued children when the parent is aborted", async () => {
    const cancelled: string[][] = [];
    const ac = new AbortController();
    ac.abort();

    await expect(
      enqueuePlaylistChildren({
        parent: parent(),
        tracks: [{ url: "https://www.youtube.com/watch?v=aaa", title: "A" }],
        signal: ac.signal,
        insertChild: async () => ({ id: "child-A" }),
        publishChildIds: async () => {},
        cancelChildren: async (ids) => {
          cancelled.push(ids);
        },
      }),
    ).rejects.toBeInstanceOf(ProcessCancelledError);

    expect(cancelled).toEqual([]);
  });

  it("cancels children inserted before abort", async () => {
    const cancelled: string[] = [];
    const ac = new AbortController();

    await expect(
      enqueuePlaylistChildren({
        parent: parent(),
        tracks: [
          { url: "https://www.youtube.com/watch?v=aaa", title: "A" },
          { url: "https://www.youtube.com/watch?v=bbb", title: "B" },
        ],
        signal: ac.signal,
        insertChild: async ({ track }) => ({ id: `child-${track.title}` }),
        publishChildIds: async (ids) => {
          if (ids.length === 1) ac.abort();
        },
        cancelChildren: async (ids) => {
          cancelled.push(...ids);
        },
      }),
    ).rejects.toBeInstanceOf(ProcessCancelledError);

    expect(cancelled).toEqual(["child-A"]);
  });
});

describe("writeFanoutChildIds", () => {
  it("writes child ids for the Modal parent to spawn after it exits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "thumper-fanout-"));
    await writeFanoutChildIds(PARENT_ID, ["child-a", "child-b"], dir);
    const raw = await readFile(path.join(dir, `${PARENT_ID}.json`), "utf8");
    expect(JSON.parse(raw)).toEqual({ childJobIds: ["child-a", "child-b"] });
  });
});

describe("Modal worker wiring", () => {
  it("fans playlist children out instead of downloading them inline", async () => {
    const processOne = await readFile(
      path.join(import.meta.dir, "process-one.ts"),
      "utf8",
    );
    expect(processOne).toContain("enqueuePlaylistChildren");
    expect(processOne).toContain("writeFanoutChildIds");
    expect(processOne).not.toContain("TRACK_GAP_MS");
    expect(processOne).not.toContain("await runOne({");
  });
});

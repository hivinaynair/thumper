import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "bun:test";
import {
  createRetagStagingOwner,
  materializeRetagInput,
  runRetagJob,
  uploadRetagToDrive,
} from "./retag-job";

async function runWithInitialUpdateFailure(params: {
  hypedditOriginal: boolean;
  deleteObjectStrict: (key: string) => Promise<void>;
  primary: Error;
}): Promise<void> {
  const dataDir = path.join(os.tmpdir(), `thumper-retag-test-${randomUUID()}`);
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  let updateCalls = 0;
  const runWithInjectedDelete = runRetagJob as unknown as (deps: {
    db: never;
    payload: {
      jobId: string;
      userId: string;
      inputStorageKey: string;
      metadataUrl: string;
      destination: "browser";
      hypedditOriginal: boolean;
      clubReadyOnly: boolean;
    };
    signal: AbortSignal;
    update: (value: unknown) => Promise<void>;
    deleteObjectStrict: (key: string) => Promise<void>;
  }) => Promise<void>;
  try {
    await runWithInjectedDelete({
      db: {} as never,
      payload: {
        jobId: randomUUID(),
        userId: `user-${randomUUID()}`,
        inputStorageKey: "users/u/uploads/staging.wav",
        metadataUrl: "https://soundcloud.com/artist/track",
        destination: "browser",
        hypedditOriginal: params.hypedditOriginal,
        clubReadyOnly: false,
      },
      signal: new AbortController().signal,
      update: async () => {
        updateCalls += 1;
        if (updateCalls === 1) throw params.primary;
      },
      deleteObjectStrict: params.deleteObjectStrict,
    });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
  }
}

it("passes the playlist folder to the retag Drive upload", async () => {
  let received: Record<string, unknown> | undefined;
  await uploadRetagToDrive({
    accessToken: "token",
    filePath: "/downloads/track.flac",
    filename: "track.flac",
    driveFolderId: "playlist-folder-123",
    upload: async (params) => {
      received = params;
      return { fileId: "drive-file-1" };
    },
  });

  expect(received).toEqual({
    accessToken: "token",
    filePath: "/downloads/track.flac",
    filename: "track.flac",
    mimeType: "audio/flac",
    folderId: "playlist-folder-123",
  });
});

it("strict-deletes Hypeddit staging after materializing the local input", async () => {
  const events: string[] = [];
  await materializeRetagInput({
    inputStorageKey: "users/u/uploads/staging.wav",
    inputPath: "/work/input.wav",
    hypedditOriginal: true,
    materialize: async () => {
      events.push("materialized");
    },
    deleteObject: async () => {
      events.push("deleted");
    },
  });

  expect(events).toEqual(["materialized", "deleted"]);
});

it("retains user-owned manual retag uploads after materializing", async () => {
  let deleted = false;
  await materializeRetagInput({
    inputStorageKey: "users/u/uploads/manual.wav",
    inputPath: "/work/input.wav",
    hypedditOriginal: false,
    materialize: async () => undefined,
    deleteObject: async () => {
      deleted = true;
    },
  });

  expect(deleted).toBe(false);
});

it("does not delete Hypeddit staging twice after ownership cleanup succeeds", async () => {
  let deleteCalls = 0;
  const owner = createRetagStagingOwner({
    temporary: true,
    inputStorageKey: "users/u/uploads/staging.wav",
    deleteObject: async () => {
      deleteCalls += 1;
    },
  });
  await owner.delete();
  await owner.delete();

  expect(deleteCalls).toBe(1);
});

it("deletes Hypeddit staging when retag fails before materialization", async () => {
  const primary = new Error("initial update failed");
  const deleted: string[] = [];

  await expect(
    runWithInitialUpdateFailure({
      hypedditOriginal: true,
      primary,
      deleteObjectStrict: async (key) => {
        deleted.push(key);
      },
    }),
  ).rejects.toBe(primary);

  expect(deleted).toEqual(["users/u/uploads/staging.wav"]);
});

it("preserves an early primary failure when staging deletion also fails", async () => {
  const primary = new Error("initial update failed");
  const cleanup = new Error("staging deletion failed");

  await expect(
    runWithInitialUpdateFailure({
      hypedditOriginal: true,
      primary,
      deleteObjectStrict: async () => {
        throw cleanup;
      },
    }),
  ).rejects.toBe(primary);

  expect((primary as Error & { cleanupError?: unknown }).cleanupError).toBe(
    cleanup,
  );
});

it("never deletes a manual retag upload after an early failure", async () => {
  const primary = new Error("initial update failed");
  let deleted = false;

  await expect(
    runWithInitialUpdateFailure({
      hypedditOriginal: false,
      primary,
      deleteObjectStrict: async () => {
        deleted = true;
      },
    }),
  ).rejects.toBe(primary);

  expect(deleted).toBe(false);
});

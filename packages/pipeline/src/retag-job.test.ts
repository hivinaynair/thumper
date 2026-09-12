import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "bun:test";
import {
  materializeRetagInput,
  runRetagJob,
  uploadRetagToDrive,
} from "./retag-job";

async function runWithInitialUpdateFailure(params: {
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

it("never deletes the uploaded input after materializing it locally", async () => {
  let materialized = false;
  await materializeRetagInput({
    inputStorageKey: "users/u/uploads/manual.wav",
    inputPath: "/work/input.wav",
    materialize: async () => {
      materialized = true;
    },
  });

  expect(materialized).toBe(true);
});

it("never deletes a retag upload after an early failure", async () => {
  const primary = new Error("initial update failed");
  let deleted = false;

  await expect(
    runWithInitialUpdateFailure({
      primary,
      deleteObjectStrict: async () => {
        deleted = true;
      },
    }),
  ).rejects.toBe(primary);

  expect(deleted).toBe(false);
});

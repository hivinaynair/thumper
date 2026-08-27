import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  completeDeliveryTransaction,
  executeOriginalArtifact,
  planDeliveryArtifact,
  preserveArtifactForLocalDelivery,
  withDeliveryCompensation,
  withRetagPathCleanup,
  withTemporaryInputCleanup,
} from "./delivery-artifact";

describe("planDeliveryArtifact", () => {
  it("converts a direct SoundCloud WAV original to FLAC without stream limiting", () => {
    const plan = planDeliveryArtifact({
      provenance: "soundcloud-original",
      downloadedPath: "/work/source.WAV",
      requestedFormat: "alac",
      outputDirectory: "/downloads",
      displayName: "Artist - Track",
    });

    expect(plan).toEqual({
      action: "convert-wav",
      sourcePath: "/work/source.WAV",
      path: "/downloads/Artist - Track.flac",
      filename: "Artist - Track.flac",
      extension: "flac",
      mime: "audio/flac",
      qualityLabel: "Artist original WAV → lossless FLAC",
      audioConverted: true,
      target: "flac",
      peakLimitLossy: false,
    });
  });

  for (const [extension, mime] of [
    ["mp3", "audio/mpeg"],
    ["aiff", "audio/aiff"],
    ["aif", "audio/aiff"],
    ["flac", "audio/flac"],
    ["m4a", "audio/mp4"],
    ["xyz", "application/octet-stream"],
  ] as const) {
    it(`preserves a direct SoundCloud ${extension} original regardless of requested format`, () => {
      const sourcePath = `/work/download.${extension}`;
      const plan = planDeliveryArtifact({
        provenance: "soundcloud-original",
        downloadedPath: sourcePath,
        requestedFormat: "flac",
        outputDirectory: "/downloads",
        displayName: "Artist - Track",
      });

      expect(plan.action).toBe("preserve-original");
      expect(plan.path).toBe(sourcePath);
      expect(plan.filename).toBe(`Artist - Track.${extension}`);
      expect(plan.extension).toBe(extension);
      expect(plan.mime).toBe(mime);
      expect(plan.audioConverted).toBe(false);
      expect("target" in plan).toBe(false);
      expect("peakLimitLossy" in plan).toBe(false);
    });
  }

  it("uses the extension from the downloaded path rather than a filename hint", () => {
    const plan = planDeliveryArtifact({
      provenance: "hypeddit-original",
      downloadedPath: "/work/download.MP3",
      originalFilename: "Artist upload.wav",
      requestedFormat: "flac",
      outputDirectory: "/downloads",
      displayName: "Ignored",
    });

    expect(plan.filename).toBe("Artist upload.mp3");
    expect(plan.extension).toBe("mp3");
    expect(plan.mime).toBe("audio/mpeg");
  });

  it("routes a Hypeddit WAV through the existing lossless retag path", () => {
    const plan = planDeliveryArtifact({
      provenance: "hypeddit-original",
      downloadedPath: "/work/hypeddit.wav",
      originalFilename: "Artist upload.wav",
      requestedFormat: "alac",
      outputDirectory: "/downloads",
      displayName: "Artist - Track",
    });

    expect(plan.action).toBe("convert-wav");
    if (plan.action !== "convert-wav") throw new Error("expected WAV plan");
    expect(plan.target).toBe("flac");
    expect(plan.peakLimitLossy).toBe(false);
  });

  it("preserves Hypeddit non-WAV originals instead of retagging them", () => {
    for (const extension of ["mp3", "aiff", "aif", "flac", "m4a", "bin"]) {
      const plan = planDeliveryArtifact({
        provenance: "hypeddit-original",
        downloadedPath: `/work/hypeddit.${extension}`,
        originalFilename: `Artist upload.${extension}`,
        requestedFormat: "flac",
        outputDirectory: "/downloads",
        displayName: "Artist - Track",
      });

      expect(plan.action).toBe("preserve-original");
      expect(plan.path).toBe(`/work/hypeddit.${extension}`);
      expect(plan.audioConverted).toBe(false);
    }
  });

  it("retains requested format and peak limiting for streams and mirrors", () => {
    const plan = planDeliveryArtifact({
      provenance: "stream",
      downloadedPath: "/work/source.webm",
      requestedFormat: "flac",
      outputDirectory: "/downloads",
      displayName: "Artist - Track",
    });

    expect(plan.action).toBe("normal-conversion");
    expect(plan.path).toBe("/downloads/Artist - Track.flac");
    if (plan.action !== "normal-conversion") {
      throw new Error("expected stream conversion plan");
    }
    expect(plan.target).toBe("flac");
    expect(plan.peakLimitLossy).toBe(true);
  });
});

describe("preserveArtifactForLocalDelivery", () => {
  it("copies exact bytes into downloads and retains the source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "thumper-original-"));
    const sourcePath = path.join(root, "work", "source.mp3");
    const outputDirectory = path.join(root, "downloads");
    const bytes = Buffer.from([0x49, 0x44, 0x33, 0, 0xff, 0xfb, 0x90, 0x64]);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, bytes);

    try {
      const deliveredPath = await preserveArtifactForLocalDelivery({
        sourcePath,
        outputDirectory,
        filename: "Artist - Track.mp3",
      });

      expect(deliveredPath).toBe(
        path.join(outputDirectory, "Artist - Track.mp3"),
      );
      expect(await fs.readFile(deliveredPath)).toEqual(bytes);
      expect(await fs.readFile(sourcePath)).toEqual(bytes);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("executeOriginalArtifact", () => {
  function operations() {
    const calls: string[] = [];
    return {
      calls,
      preserve: async () => {
        calls.push("preserve");
        return "preserved";
      },
      convertWav: async () => {
        calls.push("convert");
        return "converted";
      },
      retagWav: async () => {
        calls.push("retag");
        return "retagged";
      },
    };
  }

  it("invokes preservation, not conversion, for a direct non-WAV original", async () => {
    const ops = operations();
    const result = await executeOriginalArtifact({
      provenance: "soundcloud-original",
      action: "preserve-original",
      ...ops,
    });

    expect(result).toBe("preserved");
    expect(ops.calls).toEqual(["preserve"]);
  });

  it("invokes conversion for a direct WAV original", async () => {
    const ops = operations();
    const result = await executeOriginalArtifact({
      provenance: "soundcloud-original",
      action: "convert-wav",
      ...ops,
    });

    expect(result).toBe("converted");
    expect(ops.calls).toEqual(["convert"]);
  });

  it("invokes preservation, not retagging, for a Hypeddit non-WAV original", async () => {
    const ops = operations();
    const result = await executeOriginalArtifact({
      provenance: "hypeddit-original",
      action: "preserve-original",
      ...ops,
    });

    expect(result).toBe("preserved");
    expect(ops.calls).toEqual(["preserve"]);
  });

  it("invokes retagging for a Hypeddit WAV original", async () => {
    const ops = operations();
    const result = await executeOriginalArtifact({
      provenance: "hypeddit-original",
      action: "convert-wav",
      ...ops,
    });

    expect(result).toBe("retagged");
    expect(ops.calls).toEqual(["retag"]);
  });
});

describe("withTemporaryInputCleanup", () => {
  it("deletes a Hypeddit staging object after success", async () => {
    const deleted: string[] = [];
    const result = await withTemporaryInputCleanup({
      temporary: true,
      inputStorageKey: "users/u/uploads/staged.wav",
      run: async () => "completed",
      deleteObject: async (key) => {
        deleted.push(key);
      },
    });

    expect(result).toBe("completed");
    expect(deleted).toEqual(["users/u/uploads/staged.wav"]);
  });

  for (const message of ["failed", "Cancelled"]) {
    it(`deletes a Hypeddit staging object when processing is ${message}`, async () => {
      const deleted: string[] = [];
      const run = withTemporaryInputCleanup({
        temporary: true,
        inputStorageKey: "users/u/uploads/staged.wav",
        run: async () => {
          throw new Error(message);
        },
        deleteObject: async (key) => {
          deleted.push(key);
        },
      });

      await expect(run).rejects.toThrow(message);
      expect(deleted).toEqual(["users/u/uploads/staged.wav"]);
    });
  }

  it("does not delete a user-owned manual retag upload", async () => {
    const deleted: string[] = [];
    await withTemporaryInputCleanup({
      temporary: false,
      inputStorageKey: "users/u/uploads/manual.wav",
      run: async () => undefined,
      deleteObject: async (key) => {
        deleted.push(key);
      },
    });

    expect(deleted).toEqual([]);
  });

  it("preserves the processing error when cleanup also fails", async () => {
    const primary = new Error("processing failed");
    const cleanup = new Error("cleanup failed");

    let thrown: unknown;
    try {
      await withTemporaryInputCleanup({
        temporary: true,
        inputStorageKey: "users/u/uploads/staged.wav",
        run: async () => {
          throw primary;
        },
        deleteObject: async () => {
          throw cleanup;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(primary);
    expect((thrown as Error & { cleanupError?: unknown }).cleanupError).toBe(
      cleanup,
    );
  });

  it("surfaces a cleanup-only failure", async () => {
    const cleanup = new Error("cleanup failed");
    const run = withTemporaryInputCleanup({
      temporary: true,
      inputStorageKey: "users/u/uploads/staged.wav",
      run: async () => "completed",
      deleteObject: async () => {
        throw cleanup;
      },
    });

    await expect(run).rejects.toBe(cleanup);
  });

  it("preserves undefined as the primary thrown value", async () => {
    let thrown: unknown = "not thrown";
    try {
      await withTemporaryInputCleanup({
        temporary: true,
        inputStorageKey: "users/u/uploads/staged.wav",
        run: async () => {
          throw undefined;
        },
        deleteObject: async () => {
          throw new Error("cleanup failed");
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
  });

  it("does not mask a non-extensible primary Error", async () => {
    const primary = Object.preventExtensions(new Error("processing failed"));
    let thrown: unknown;
    try {
      await withTemporaryInputCleanup({
        temporary: true,
        inputStorageKey: "users/u/uploads/staged.wav",
        run: async () => {
          throw primary;
        },
        deleteObject: async () => {
          throw new Error("cleanup failed");
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(primary);
  });
});

describe("withDeliveryCompensation", () => {
  it("rolls back created state in reverse order after a later failure", async () => {
    const state = ["blob"];
    const primary = new Error("Drive failed");
    const run = withDeliveryCompensation(async (register) => {
      register(async () => {
        state.splice(state.indexOf("blob"), 1);
      });
      state.push("file-row");
      register(async () => {
        state.splice(state.indexOf("file-row"), 1);
      });
      throw primary;
    });

    await expect(run).rejects.toBe(primary);
    expect(state).toEqual([]);
  });
});

describe("completeDeliveryTransaction", () => {
  it("rolls back created delivery state when terminal update fails", async () => {
    const state = ["blob", "file-row", "drive"];
    const terminalError = new Error("terminal update failed");
    const run = completeDeliveryTransaction({
      create: async (register) => {
        for (const item of [...state]) {
          register(async () => {
            state.splice(state.indexOf(item), 1);
          });
        }
        return { fileId: "file-1" };
      },
      complete: async () => {
        throw terminalError;
      },
    });

    await expect(run).rejects.toBe(terminalError);
    expect(state).toEqual([]);
  });

  it("does not roll back after terminal completion succeeds", async () => {
    let rolledBack = false;
    const result = await completeDeliveryTransaction({
      create: async (register) => {
        register(async () => {
          rolledBack = true;
        });
        return { fileId: "file-1" };
      },
      complete: async () => undefined,
    });

    expect(result).toEqual({ fileId: "file-1" });
    expect(rolledBack).toBe(false);
  });

  it("rolls back durable state when required cleanup fails before completion", async () => {
    const cleanupError = new Error("work directory cleanup failed");
    let completed = false;
    let durableArtifact = true;
    const completeWithCleanup = completeDeliveryTransaction as unknown as <
      T,
    >(params: {
      create: (register: (cleanup: () => Promise<void>) => void) => Promise<T>;
      beforeComplete: (result: T) => Promise<void>;
      complete: (result: T) => Promise<void>;
    }) => Promise<T>;

    const run = completeWithCleanup({
      create: async (register) => {
        register(async () => {
          durableArtifact = false;
        });
        return { fileId: "file-1" };
      },
      beforeComplete: async () => {
        throw cleanupError;
      },
      complete: async () => {
        completed = true;
      },
    });

    await expect(run).rejects.toBe(cleanupError);
    expect(completed).toBe(false);
    expect(durableArtifact).toBe(false);
  });
});

describe("withRetagPathCleanup", () => {
  it("removes work and failed output after failure", async () => {
    const removed: string[] = [];
    const run = withRetagPathCleanup({
      workDir: "/work/job",
      state: { outputPath: "/downloads/failed.flac", retainOutput: false },
      run: async () => {
        throw new Error("conversion failed");
      },
      removeWorkDir: async (path) => {
        removed.push(path);
      },
      removeOutput: async (path) => {
        removed.push(path);
      },
    });

    await expect(run).rejects.toThrow("conversion failed");
    expect(removed).toEqual(["/downloads/failed.flac", "/work/job"]);
  });

  it("retains a successfully delivered local output", async () => {
    const removed: string[] = [];
    await withRetagPathCleanup({
      workDir: "/work/job",
      state: { outputPath: "/downloads/kept.flac", retainOutput: true },
      run: async () => undefined,
      removeWorkDir: async (path) => {
        removed.push(path);
      },
      removeOutput: async (path) => {
        removed.push(path);
      },
    });

    expect(removed).toEqual(["/work/job"]);
  });

  it("performs no post-completion cleanup after paths were already cleaned", async () => {
    const removed: string[] = [];
    const state = {
      outputPath: "/downloads/track.flac",
      retainOutput: false,
      cleaned: true,
    };
    await withRetagPathCleanup({
      workDir: "/work/job",
      state,
      run: async () => undefined,
      removeWorkDir: async (path) => {
        removed.push(path);
      },
      removeOutput: async (path) => {
        removed.push(path);
      },
    });

    expect(removed).toEqual([]);
  });
});

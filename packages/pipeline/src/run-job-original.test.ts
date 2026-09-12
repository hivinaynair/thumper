import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  completeDeliveryTransaction,
  executeOriginalArtifact,
  planDeliveryArtifact,
  preserveArtifactForLocalDelivery,
  withDeliveryCompensation,
  withRetagPathCleanup,
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

  it("preserves a direct SoundCloud MP3 original that already has artwork", () => {
    const sourcePath = "/work/download.mp3";
    const plan = planDeliveryArtifact({
      provenance: "soundcloud-original",
      downloadedPath: sourcePath,
      requestedFormat: "flac",
      outputDirectory: "/downloads",
      displayName: "Artist - Track",
      hasAttachedArtwork: true,
    });

    expect(plan.action).toBe("preserve-original");
    expect(plan.path).toBe(sourcePath);
    expect(plan.filename).toBe("Artist - Track.mp3");
    expect(plan.extension).toBe("mp3");
    expect(plan.mime).toBe("audio/mpeg");
    expect(plan.audioConverted).toBe(false);
    expect(plan.qualityLabel).toBe("Artist original MP3 (preserved)");
  });

  it("tags a direct SoundCloud MP3 original that has no artwork", () => {
    const plan = planDeliveryArtifact({
      provenance: "soundcloud-original",
      downloadedPath: "/work/download.mp3",
      requestedFormat: "flac",
      outputDirectory: "/downloads",
      displayName: "Artist - Track",
      hasAttachedArtwork: false,
    });

    expect(plan).toEqual({
      action: "tag-mp3",
      sourcePath: "/work/download.mp3",
      path: "/downloads/Artist - Track.mp3",
      filename: "Artist - Track.mp3",
      extension: "mp3",
      mime: "audio/mpeg",
      qualityLabel: "Artist original MP3 (tagged)",
      audioConverted: true,
    });
    expect("peakLimitLossy" in plan).toBe(false);
    expect("target" in plan).toBe(false);
  });

  it("uses the extension from the downloaded path rather than a filename hint", () => {
    const plan = planDeliveryArtifact({
      provenance: "soundcloud-original",
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

      expect(deliveredPath).toBe(path.join(outputDirectory, "Artist - Track.mp3"));
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
      tagMp3: async () => {
        calls.push("tag-mp3");
        return "tagged";
      },
    };
  }

  it("invokes preservation, not conversion, for a non-WAV original", async () => {
    const ops = operations();
    const result = await executeOriginalArtifact({
      action: "preserve-original",
      ...ops,
    });

    expect(result).toBe("preserved");
    expect(ops.calls).toEqual(["preserve"]);
  });

  it("invokes conversion for a WAV original", async () => {
    const ops = operations();
    const result = await executeOriginalArtifact({
      action: "convert-wav",
      ...ops,
    });

    expect(result).toBe("converted");
    expect(ops.calls).toEqual(["convert"]);
  });

  it("invokes MP3 tagging for an original without artwork", async () => {
    const ops = operations();
    const result = await executeOriginalArtifact({
      action: "tag-mp3",
      ...ops,
    });

    expect(result).toBe("tagged");
    expect(ops.calls).toEqual(["tag-mp3"]);
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
    const completeWithCleanup = completeDeliveryTransaction as unknown as <T>(params: {
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

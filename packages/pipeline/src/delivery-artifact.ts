import fs from "node:fs/promises";
import path from "node:path";
import { artistOriginalAction } from "./artist-original";
import type { AudioTargetFormat } from "./audio-quality";

export type ArtifactProvenance =
  "soundcloud-original" | "hypeddit-original" | "stream";

type DeliveryArtifactCommon = {
  sourcePath: string;
  path: string;
  filename: string;
  extension: string;
  mime: string;
  qualityLabel: string;
};

export type DeliveryArtifactPlan =
  | (DeliveryArtifactCommon & {
      action: "preserve-original";
      audioConverted: false;
    })
  | (DeliveryArtifactCommon & {
      action: "tag-mp3";
      audioConverted: true;
    })
  | (DeliveryArtifactCommon & {
      action: "convert-wav" | "normal-conversion";
      audioConverted: true;
      target: AudioTargetFormat;
      peakLimitLossy: boolean;
    });

export function extensionFromPath(filePath: string): string {
  return path.extname(filePath).replace(/^\./, "").toLowerCase() || "bin";
}

export function audioMimeForExtension(extension: string): string {
  switch (extension.toLowerCase().replace(/^\./, "")) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "aif":
    case "aiff":
      return "audio/aiff";
    case "flac":
      return "audio/flac";
    case "m4a":
      return "audio/mp4";
    default:
      return "application/octet-stream";
  }
}

function filenameWithExtension(filename: string, extension: string): string {
  const parsed = path.parse(filename);
  return `${parsed.name || "track"}.${extension}`;
}

export function planDeliveryArtifact(params: {
  provenance: ArtifactProvenance;
  downloadedPath: string;
  originalFilename?: string;
  requestedFormat: AudioTargetFormat;
  outputDirectory: string;
  displayName: string;
  hasAttachedArtwork?: boolean;
}): DeliveryArtifactPlan {
  const sourceExtension = extensionFromPath(params.downloadedPath);
  const action = artistOriginalAction({
    artistOriginal: params.provenance !== "stream",
    extension: sourceExtension,
    hasAttachedArtwork: params.hasAttachedArtwork,
  });

  if (action === "preserve-original") {
    const filename = filenameWithExtension(
      params.originalFilename ?? params.displayName,
      sourceExtension,
    );
    return {
      action,
      sourcePath: params.downloadedPath,
      path: params.downloadedPath,
      filename,
      extension: sourceExtension,
      mime: audioMimeForExtension(sourceExtension),
      qualityLabel: `Artist original ${sourceExtension.toUpperCase()} (preserved)`,
      audioConverted: false,
    };
  }

  if (action === "tag-mp3") {
    const filename = filenameWithExtension(params.displayName, "mp3");
    return {
      action,
      sourcePath: params.downloadedPath,
      path: path.join(params.outputDirectory, filename),
      filename,
      extension: "mp3",
      mime: audioMimeForExtension("mp3"),
      qualityLabel: "Artist original MP3 (tagged)",
      audioConverted: true,
    };
  }

  const target: AudioTargetFormat =
    action === "convert-wav" ? "flac" : params.requestedFormat;
  const extension = target;
  const filename = filenameWithExtension(params.displayName, extension);
  return {
    action,
    sourcePath: params.downloadedPath,
    path: path.join(params.outputDirectory, filename),
    filename,
    extension,
    mime: audioMimeForExtension(extension),
    qualityLabel:
      action === "convert-wav" ? "Artist original WAV → lossless FLAC" : "",
    audioConverted: true,
    target,
    peakLimitLossy: action === "normal-conversion",
  };
}

export async function preserveArtifactForLocalDelivery(params: {
  sourcePath: string;
  outputDirectory: string;
  filename: string;
}): Promise<string> {
  const outputPath = path.join(params.outputDirectory, params.filename);
  await fs.mkdir(params.outputDirectory, { recursive: true });
  if (path.resolve(outputPath) !== path.resolve(params.sourcePath)) {
    await fs.copyFile(params.sourcePath, outputPath);
  }
  return outputPath;
}

export async function executeOriginalArtifact<T>(params: {
  provenance: Exclude<ArtifactProvenance, "stream">;
  action: Extract<
    DeliveryArtifactPlan["action"],
    "preserve-original" | "convert-wav" | "tag-mp3"
  >;
  preserve: () => Promise<T>;
  convertWav: () => Promise<T>;
  retagWav: () => Promise<T>;
  tagMp3: () => Promise<T>;
}): Promise<T> {
  if (params.action === "preserve-original") return params.preserve();
  if (params.action === "tag-mp3") return params.tagMp3();
  return params.provenance === "hypeddit-original"
    ? params.retagWav()
    : params.convertWav();
}

export async function withTemporaryInputCleanup<T>(params: {
  temporary: boolean;
  inputStorageKey: string;
  run: () => Promise<T>;
  deleteObject: (key: string) => Promise<void>;
}): Promise<T> {
  if (!params.temporary) return params.run();
  return runWithCleanup(params.run, () =>
    params.deleteObject(params.inputStorageKey),
  );
}

function attachCleanupError(primary: unknown, cleanupError: unknown): void {
  if (primary instanceof Error && Object.isExtensible(primary)) {
    Object.defineProperty(primary, "cleanupError", {
      configurable: true,
      value: cleanupError,
    });
  }
}

async function runWithCleanup<T>(
  run: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let hasPrimaryError = false;
  let primaryError: unknown;
  try {
    return await run();
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (hasPrimaryError) {
        attachCleanupError(primaryError, cleanupError);
      } else {
        throw cleanupError;
      }
    }
  }
}

export async function withDeliveryCompensation<T>(
  run: (register: (cleanup: () => Promise<void>) => void) => Promise<T>,
): Promise<T> {
  const cleanups: Array<() => Promise<void>> = [];
  try {
    return await run((cleanup) => cleanups.push(cleanup));
  } catch (primaryError) {
    const cleanupErrors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      attachCleanupError(
        primaryError,
        cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(cleanupErrors, "Delivery compensation failed"),
      );
    }
    throw primaryError;
  }
}

export async function completeDeliveryTransaction<T>(params: {
  create: (register: (cleanup: () => Promise<void>) => void) => Promise<T>;
  beforeComplete?: (result: T) => Promise<void>;
  complete: (result: T) => Promise<void>;
}): Promise<T> {
  return withDeliveryCompensation(async (register) => {
    const result = await params.create(register);
    await params.beforeComplete?.(result);
    await params.complete(result);
    return result;
  });
}

export async function cleanupRetagPaths(params: {
  workDir: string;
  state: {
    outputPath: string | null;
    retainOutput: boolean;
  };
  removeWorkDir: (path: string) => Promise<void>;
  removeOutput: (path: string) => Promise<void>;
}): Promise<void> {
  const errors: unknown[] = [];
  if (params.state.outputPath && !params.state.retainOutput) {
    try {
      await params.removeOutput(params.state.outputPath);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await params.removeWorkDir(params.workDir);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Retag path cleanup failed");
  }
}

export async function withRetagPathCleanup<T>(params: {
  workDir: string;
  state: {
    outputPath: string | null;
    retainOutput: boolean;
    cleaned?: boolean;
  };
  run: () => Promise<T>;
  removeWorkDir: (path: string) => Promise<void>;
  removeOutput: (path: string) => Promise<void>;
}): Promise<T> {
  return runWithCleanup(params.run, async () => {
    if (params.state.cleaned) return;
    await cleanupRetagPaths(params);
  });
}

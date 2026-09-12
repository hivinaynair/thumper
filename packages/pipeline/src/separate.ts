import fs from "node:fs/promises";
import path from "node:path";
import { STEM_MODEL_DEFAULT, type StemRole } from "@thumper/shared";
import { ProcessCancelledError, runCommand, type SpawnOptions } from "./process";

/**
 * Stem separation shells out to `audio-separator`, the same way convert.ts
 * shells to ffmpeg and download.ts to yt-dlp. Keeping it a subprocess is what
 * lets separation run unchanged locally and inside the Modal container — the
 * only difference is which binary is on PATH and whether a GPU is present.
 */
export function separatorBinary(): string {
  return process.env.STEM_SEPARATOR_PATH?.trim() || "audio-separator";
}

/**
 * Where model checkpoints live. On Modal this is a Volume mount so the ~1.7 GB
 * checkpoint survives image rebuilds and is shared between containers.
 */
export function stemModelDir(): string {
  return process.env.STEM_MODEL_DIR?.trim() || "/models";
}

export type SeparatedStems = {
  model: string;
  paths: Record<StemRole, string>;
};

/**
 * audio-separator names outputs `<input stem>_(Instrumental)_<model>.flac`.
 * Match on the role marker only — it truncates the model name at the first dot,
 * so `..._sdr_12.9755.ckpt` becomes `..._sdr_12` and is not a reliable suffix.
 */
const ROLE_MARKERS: ReadonlyArray<[StemRole, RegExp]> = [
  ["instrumental", /_\(Instrumental\)_/i],
  ["vocals", /_\(Vocals\)_/i],
];

export function classifyStemFile(filename: string): StemRole | null {
  for (const [role, re] of ROLE_MARKERS) {
    if (re.test(filename)) return role;
  }
  return null;
}

/** tqdm writes ` 27%|##  | 20/73 [02:52<09:50, 11.14s/it]` — take the ratio. */
export function parseSeparationProgress(chunk: string): number | null {
  let last: number | null = null;
  const re = /(\d+)\/(\d+)\s*\[/g;
  let m = re.exec(chunk);
  while (m !== null) {
    const done = Number(m[1]);
    const total = Number(m[2]);
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
      last = Math.min(1, done / total);
    }
    m = re.exec(chunk);
  }
  return last;
}

export type SeparateStemsParams = {
  inputPath: string;
  /** Directory the two stems are written into. Created if missing. */
  outDir: string;
  model?: string;
  modelDir?: string;
  signal?: AbortSignal;
  /** Fractional progress 0..1 while the model runs. */
  onProgress?: (fraction: number) => void;
};

/**
 * Linear peak ceiling passed to audio-separator `--normalization`.
 *
 * The tool's default is 0.9. That is a *downward* scale whenever a stem
 * peaks above 0.9 — on a club master already at 0 dBFS that is ~1 dB of
 * lost level, and more when the model overshoots. 1.0 only attenuates
 * stems that would clip integer PCM on write.
 */
export const STEM_PEAK_CEILING = 1;

export type SeparatorArgsParams = {
  inputPath: string;
  outDir: string;
  model: string;
  modelDir: string;
};

export function separatorArgs(params: SeparatorArgsParams): string[] {
  return [
    params.inputPath,
    "--model_filename",
    params.model,
    "--model_file_dir",
    params.modelDir,
    "--output_dir",
    params.outDir,
    "--output_format",
    "FLAC",
    "--normalization",
    String(STEM_PEAK_CEILING),
  ];
}

/**
 * Split one file into instrumental + vocals. One inference pass emits both,
 * so there is never a reason to run this twice for the two stems.
 */
export async function separateStems(params: SeparateStemsParams): Promise<SeparatedStems> {
  const {
    inputPath,
    outDir,
    model = STEM_MODEL_DEFAULT,
    modelDir = stemModelDir(),
    signal,
    onProgress,
  } = params;

  await fs.mkdir(outDir, { recursive: true });
  const before = new Set(await fs.readdir(outDir).catch(() => []));

  const options: SpawnOptions = {
    signal,
    onStdout: (chunk) => {
      const p = parseSeparationProgress(chunk);
      if (p !== null) onProgress?.(p);
    },
    onStderr: (chunk) => {
      const p = parseSeparationProgress(chunk);
      if (p !== null) onProgress?.(p);
    },
  };

  const binary = separatorBinary();
  const result = await runCommand(
    binary,
    separatorArgs({ inputPath, outDir, model, modelDir }),
    options,
  );

  if (signal?.aborted) throw new ProcessCancelledError();
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).slice(-2000).trim();
    throw new Error(`${binary} failed (${result.code})${detail ? `: ${detail}` : ""}`);
  }

  const produced = (await fs.readdir(outDir)).filter(
    (f) => !before.has(f) && f.toLowerCase().endsWith(".flac"),
  );

  const paths: Partial<Record<StemRole, string>> = {};
  for (const filename of produced) {
    const role = classifyStemFile(filename);
    if (role && !paths[role]) paths[role] = path.join(outDir, filename);
  }

  // Fail loudly rather than delivering half a job: a missing stem means the
  // model or its naming changed, and silently shipping one file would look
  // like success.
  const missing = (["instrumental", "vocals"] as StemRole[]).filter((r) => !paths[r]);
  if (missing.length > 0) {
    throw new Error(
      `Separation produced no ${missing.join(" or ")} stem ` +
        `(got: ${produced.join(", ") || "nothing"})`,
    );
  }

  return {
    model,
    paths: paths as Record<StemRole, string>,
  };
}

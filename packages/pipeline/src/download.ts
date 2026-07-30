import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AUDIO_FORMAT_SELECTOR,
  AUDIO_FORMAT_SORT,
  withoutPreview,
} from "./audio-quality";
import { getYtDlpPath } from "./paths";
import { runCommandOk, type SpawnOptions } from "./process";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type DownloadMediaResult = {
  filePath: string;
  title?: string;
  abr?: number;
};

function parsePrintMarkers(output: string) {
  const filepath =
    output.match(/(?:^|\n)\s*__filepath__=([^\n]+)/)?.[1]?.trim() ?? "";
  const abrRaw =
    output.match(/(?:^|\n)\s*__abr__=([^\n]+)/)?.[1]?.trim() ?? "";
  const abr = Number.parseFloat(abrRaw);
  return {
    filepath,
    abr: Number.isFinite(abr) && abr > 0 ? Math.round(abr) : undefined,
  };
}

export async function downloadMedia(params: {
  url: string;
  workDir: string;
  cookiePath?: string | null;
  soundcloud?: boolean;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}): Promise<DownloadMediaResult> {
  await fs.mkdir(params.workDir, { recursive: true });
  const outTemplate = path.join(params.workDir, `dl_${randomUUID()}.%(ext)s`);
  const selector = params.soundcloud
    ? withoutPreview(AUDIO_FORMAT_SELECTOR)
    : AUDIO_FORMAT_SELECTOR;

  const args = [
    "-f",
    selector,
    "-S",
    AUDIO_FORMAT_SORT,
    "--audio-quality",
    "0",
    "--no-check-certificate",
    "--no-playlist",
    "--force-ipv4",
    "--no-warnings",
    "--user-agent",
    UA,
    "-o",
    outTemplate,
    "--print",
    "after_move:__filepath__=%(filepath)s",
    "--print",
    "after_move:__abr__=%(abr)s",
    "--print",
    "after_move:__title__=%(title)s",
  ];

  if (params.soundcloud) {
    args.push("--add-header", "Referer:https://soundcloud.com/");
  }
  if (params.cookiePath) {
    args.push("--cookies", params.cookiePath);
  }
  args.push(params.url);

  const spawnOpts: SpawnOptions = {
    signal: params.signal,
    onStdout: params.onProgress,
    onStderr: params.onProgress,
  };

  const { stdout, stderr } = await runCommandOk(getYtDlpPath(), args, spawnOpts);
  const combined = `${stdout}\n${stderr}`;
  const markers = parsePrintMarkers(combined);
  if (!markers.filepath) {
    throw new Error("yt-dlp did not report output filepath");
  }

  // Fail closed: if SoundCloud still looks like a preview-only fetch, bail.
  if (params.soundcloud && /preview/i.test(path.basename(markers.filepath))) {
    throw new Error(
      "SoundCloud returned a preview-only stream. Connect a full-access account cookie or use another source.",
    );
  }

  const title =
    combined.match(/(?:^|\n)\s*__title__=([^\n]+)/)?.[1]?.trim() ?? undefined;

  return {
    filePath: markers.filepath,
    title,
    abr: markers.abr,
  };
}

export async function dumpJson(
  url: string,
  cookiePath?: string | null,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const args = [
    "--dump-json",
    "--no-playlist",
    "--no-warnings",
    "--user-agent",
    UA,
  ];
  if (cookiePath) args.push("--cookies", cookiePath);
  args.push(url);
  const { stdout } = await runCommandOk(getYtDlpPath(), args, { signal });
  return JSON.parse(stdout) as Record<string, unknown>;
}

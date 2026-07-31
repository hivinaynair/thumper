import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AUDIO_FORMAT_SELECTOR,
  AUDIO_FORMAT_SORT,
  withoutPreview,
  youtubeExtractorArgs,
} from "./audio-quality";
import { getYtDlpPath } from "./paths";
import { runCommandOk, type SpawnOptions } from "./process";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type DownloadMediaResult = {
  filePath: string;
  title?: string;
  abr?: number;
  /** yt-dlp format id actually served, e.g. "140", "251", "download". */
  formatId?: string;
  acodec?: string;
  /**
   * True when we had to fall back to an unauthenticated fetch. On YouTube that
   * caps quality at 128 kbps AAC regardless of the user's Premium status, so
   * the caller should say so rather than presenting the result as best-effort.
   */
  anonymousFallback?: boolean;
};

function marker(output: string, name: string): string {
  return (
    output.match(new RegExp(`(?:^|\\n)\\s*__${name}__=([^\\n]+)`))?.[1]?.trim() ??
    ""
  );
}

function parsePrintMarkers(output: string) {
  const abr = Number.parseFloat(marker(output, "abr"));
  const formatId = marker(output, "format_id");
  const acodec = marker(output, "acodec");
  return {
    filepath: marker(output, "filepath"),
    abr: Number.isFinite(abr) && abr > 0 ? Math.round(abr) : undefined,
    formatId: formatId && formatId !== "NA" ? formatId : undefined,
    acodec: acodec && acodec !== "NA" ? acodec : undefined,
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
    "--print",
    "after_move:__format_id__=%(format_id)s",
    "--print",
    "after_move:__acodec__=%(acodec)s",
  ];

  if (params.soundcloud) {
    args.push("--add-header", "Referer:https://soundcloud.com/");
  } else {
    // Premium itags (141 / 774) are only listed for certain player clients.
    args.push("--extractor-args", youtubeExtractorArgs());
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

  let stdout = "";
  let stderr = "";
  let anonymousFallback = false;

  try {
    ({ stdout, stderr } = await runCommandOk(getYtDlpPath(), args, spawnOpts));
  } catch (err) {
    if (params.soundcloud || !params.cookiePath || !isFormatUnavailable(err)) {
      throw err;
    }

    // Some player clients need a PO token and answer authenticated requests
    // with zero formats. Retry on a different client first — *keeping* the
    // cookies, because dropping them is what caps a Premium account at 128 kbps
    // AAC. Only give up authentication as a last resort, and flag it when we do
    // so the caller can explain the downgrade instead of shipping a quietly
    // worse file.
    const withClients = (clients: string) =>
      args.map((arg, i) =>
        args[i - 1] === "--extractor-args" ? `youtube:player_client=${clients}` : arg,
      );

    let recovered = false;
    for (const clients of ["tv", "web_safari,mweb", "android_vr"]) {
      try {
        ({ stdout, stderr } = await runCommandOk(
          getYtDlpPath(),
          withClients(clients),
          spawnOpts,
        ));
        recovered = true;
        break;
      } catch (retryErr) {
        if (!isFormatUnavailable(retryErr)) throw retryErr;
      }
    }

    if (!recovered) {
      const retryArgs = args.filter(
        (arg, i) => arg !== "--cookies" && args[i - 1] !== "--cookies",
      );
      ({ stdout, stderr } = await runCommandOk(
        getYtDlpPath(),
        retryArgs,
        spawnOpts,
      ));
      anonymousFallback = true;
    }
  }
  const combined = `${stdout}\n${stderr}`;
  const markers = parsePrintMarkers(combined);
  if (!markers.filepath) {
    throw new Error("yt-dlp did not report output filepath");
  }

  // Fail closed: if SoundCloud still looks like a preview-only fetch, bail.
  // yt-dlp tags snipped streams in the *format id* — the output template is
  // `dl_<uuid>.<ext>`, so the filename alone never carries that evidence.
  if (
    params.soundcloud &&
    /preview/i.test(`${markers.formatId ?? ""} ${path.basename(markers.filepath)}`)
  ) {
    await fs.unlink(markers.filepath).catch(() => undefined);
    throw new SoundCloudPreviewError(
      "SoundCloud returned a preview-only stream. Falling back to YouTube when possible.",
    );
  }

  const title =
    combined.match(/(?:^|\n)\s*__title__=([^\n]+)/)?.[1]?.trim() ?? undefined;

  return {
    filePath: markers.filepath,
    title,
    abr: markers.abr,
    formatId: markers.formatId,
    acodec: markers.acodec,
    anonymousFallback,
  };
}

export class SoundCloudPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoundCloudPreviewError";
  }
}

export function isSoundCloudPreviewError(err: unknown): boolean {
  if (err instanceof SoundCloudPreviewError) return true;
  return err instanceof Error && /preview-only/i.test(err.message);
}

/**
 * SoundCloud won't hand over playable audio at all — preview-only, Widevine
 * DRM, or region-locked. Distinct from a transient download failure: retrying
 * won't help, but a YouTube mirror can still satisfy the job.
 *
 * Only consulted for SoundCloud sources, so the patterns stay narrow rather
 * than swallowing genuine download faults.
 */
export function isSoundCloudUnavailableError(err: unknown): boolean {
  if (isSoundCloudPreviewError(err)) return true;
  if (!(err instanceof Error)) return false;
  // "available in your country" (unanchored) catches yt-dlp's actual phrasing,
  // "The uploader has not made this video available in your country".
  return /DRM protected|available in your country|not available from your location|geo[\s-]?restricted|blocked it in your country/i.test(
    err.message,
  );
}

/**
 * yt-dlp saw no usable formats — not a selector problem (the selector ends in
 * `bestaudio/best`), but YouTube declining to serve any.
 */
export function isFormatUnavailable(err: unknown): boolean {
  return (
    err instanceof Error &&
    /Requested format is not available|No video formats found/i.test(
      err.message,
    )
  );
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
    // DRM and geo-blocked tracks still carry title/artist/duration; without
    // this yt-dlp throws them away along with the formats it can't serve, which
    // is precisely when we need them to go find a mirror.
    "--ignore-no-formats-error",
    "--user-agent",
    UA,
  ];
  if (cookiePath) args.push("--cookies", cookiePath);
  args.push(url);
  const { stdout } = await runCommandOk(getYtDlpPath(), args, { signal });
  return JSON.parse(stdout) as Record<string, unknown>;
}

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
import {
  ProcessCancelledError,
  runCommandOk,
  type SpawnOptions,
} from "./process";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Alternate YouTube clients tried when the default set returns no formats /
 * a bot wall. Order matters: android_vr is the most reliable without a PO
 * token; bare `tv` / `web_safari` currently DRM-lock or image-only.
 */
const YOUTUBE_FALLBACK_CLIENTS = [
  "android_vr",
  "android",
  "mweb",
  "tv",
] as const;

const RATE_LIMIT_ATTEMPTS = 4;
const RATE_LIMIT_BASE_MS = 2_500;

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

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new ProcessCancelledError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProcessCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withExtractorClients(args: string[], clients: string): string[] {
  return args.map((arg, i) =>
    args[i - 1] === "--extractor-args"
      ? `youtube:player_client=${clients}`
      : arg,
  );
}

function withoutCookies(args: string[]): string[] {
  return args.filter(
    (arg, i) => arg !== "--cookies" && args[i - 1] !== "--cookies",
  );
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
  let lastErr: unknown;

  for (let attempt = 0; attempt < RATE_LIMIT_ATTEMPTS; attempt++) {
    try {
      ({ stdout, stderr } = await runCommandOk(
        getYtDlpPath(),
        args,
        spawnOpts,
      ));
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;

      // Preview-only / geo-blocked / DRM SoundCloud tracks have no non-preview
      // formats once withoutPreview() strips them — surface that as the same
      // unavailable class processTrack already falls back to YouTube for.
      if (params.soundcloud && isFormatUnavailable(err)) {
        throw new SoundCloudPreviewError(
          "SoundCloud has no full stream (preview-only, geo-blocked, or DRM). Falling back to YouTube when possible.",
        );
      }

      if (isRateLimitError(err) && attempt < RATE_LIMIT_ATTEMPTS - 1) {
        const waitMs = RATE_LIMIT_BASE_MS * 2 ** attempt;
        params.onProgress?.(
          `Rate limited — waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 2}/${RATE_LIMIT_ATTEMPTS}\n`,
        );
        await sleep(waitMs, params.signal);
        continue;
      }

      if (
        !params.soundcloud &&
        (isYoutubeBotError(err) || isFormatUnavailable(err))
      ) {
        const recovered = await tryYoutubeRecovery({
          args,
          spawnOpts,
          cookiePath: params.cookiePath,
          onProgress: params.onProgress,
          initialErr: err,
        });
        if (recovered) {
          ({ stdout, stderr, anonymousFallback } = recovered);
          lastErr = undefined;
          break;
        }
        if (isYoutubeBotError(err)) {
          throw new Error(
            params.cookiePath
              ? "YouTube blocked this download (bot check), even with your synced cookies. Re-sync fresh YouTube cookies from a signed-in browser and retry."
              : "YouTube blocked this download (bot check). Sync YouTube cookies from a signed-in browser, then retry.",
          );
        }
        if (isFormatUnavailable(err)) {
          throw new Error(
            params.cookiePath
              ? "YouTube returned no playable formats (cookies may be stale, or this client is DRM-locked). Re-sync YouTube cookies from a signed-in browser and retry."
              : "YouTube returned no playable formats. Sync YouTube cookies from a signed-in browser and retry.",
          );
        }
      }

      throw err;
    }
  }

  if (lastErr) throw lastErr;

  const combined = `${stdout}\n${stderr}`;
  const markers = parsePrintMarkers(combined);
  if (!markers.filepath) {
    throw new Error("yt-dlp did not report output filepath");
  }

  // Fail closed: yt-dlp tags snipped streams in the *format id* — the output
  // template is `dl_<uuid>.<ext>`, so the filename alone never carries that.
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

async function tryYoutubeRecovery(params: {
  args: string[];
  spawnOpts: SpawnOptions;
  cookiePath?: string | null;
  onProgress?: (line: string) => void;
  initialErr: unknown;
}): Promise<{
  stdout: string;
  stderr: string;
  anonymousFallback: boolean;
} | null> {
  const tryOnce = async (
    args: string[],
    clients: string,
    anonymous: boolean,
  ) => {
    params.onProgress?.(
      `Retrying YouTube ${anonymous ? "anonymously " : ""}with player_client=${clients}\n`,
    );
    const { stdout, stderr } = await runCommandOk(
      getYtDlpPath(),
      withExtractorClients(args, clients),
      params.spawnOpts,
    );
    return { stdout, stderr, anonymousFallback: anonymous };
  };

  // Stale/rotated cookies on datacenter IPs often zero out formats for every
  // authenticated client. Anonymous android_vr still serves public tracks —
  // try that *before* burning time on poisoned cookie sessions.
  if (
    isFormatUnavailable(params.initialErr) ||
    isYoutubeBotError(params.initialErr)
  ) {
    for (const clients of ["android_vr", "android"] as const) {
      try {
        return await tryOnce(withoutCookies(params.args), clients, true);
      } catch (retryErr) {
        if (retryErr instanceof ProcessCancelledError) throw retryErr;
      }
    }
  }

  // Cookie-backed clients next — needed for Premium itags when the session
  // is healthy.
  for (const clients of YOUTUBE_FALLBACK_CLIENTS) {
    try {
      return await tryOnce(params.args, clients, false);
    } catch (retryErr) {
      if (retryErr instanceof ProcessCancelledError) throw retryErr;
    }
  }

  return null;
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

/** YouTube datacenter / anonymous IP bot challenge. */
export function isYoutubeBotError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /Sign in to confirm you.?re not a bot|confirm your age|login required|not a bot/i.test(
      err.message,
    )
  );
}

/** Transient HTTP 429 from SoundCloud / YouTube / CDNs. */
export function isRateLimitError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /HTTP Error 429|Too Many Requests|rate[_ ]?limit/i.test(err.message)
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

/**
 * True when yt-dlp lists SoundCloud's artist free-download / original upload
 * (`format_id=download`). That is the only SC entry that can be a real master.
 */
export function soundcloudHasFreeDownload(
  info: Record<string, unknown>,
): boolean {
  const isDownloadId = (raw: unknown) => {
    const id = String(raw ?? "").toLowerCase();
    return id === "download" || (id.includes("download") && !id.includes("preview"));
  };

  if (isDownloadId(info.format_id)) return true;

  const formats = info.formats;
  if (!Array.isArray(formats)) return false;
  return formats.some(
    (f) =>
      f &&
      typeof f === "object" &&
      isDownloadId((f as { format_id?: unknown }).format_id),
  );
}

/** Best-effort probe — false on DRM/geo/network errors (caller continues). */
export async function probeSoundCloudFreeDownload(
  url: string,
  cookiePath?: string | null,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const info = await dumpJson(url, cookiePath, signal);
    return soundcloudHasFreeDownload(info);
  } catch (err) {
    if (err instanceof ProcessCancelledError) throw err;
    return false;
  }
}

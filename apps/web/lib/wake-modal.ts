/**
 * Wake the Modal worker to process a single job.
 * Set PROCESS_BACKEND=modal and MODAL_JOB_URL (+ MODAL_WEBHOOK_SECRET).
 *
 * MODAL_JOB_URL is the Modal fastapi endpoint URL from `modal deploy`.
 * Body: { jobId, secret? }
 */

/** Modal fastapi endpoints deployed by `apps/modal/thumper_worker.py`. */
type ModalFn = "wake" | "wake-stems" | "search";

function isModalBackend(): boolean {
  return (process.env.PROCESS_BACKEND ?? "pgboss").toLowerCase() === "modal";
}

/**
 * Point a sibling Modal function's URL at `toFn`, given the `wake` URL.
 *
 * Modal names endpoints by hostname — `<workspace>--<app>-<fn>.modal.run` —
 * so the function name is a host suffix, not a path segment. The path form is
 * still handled for a custom/proxied deployment.
 *
 * Exported for tests; returns null when neither shape matches.
 */
export function deriveModalSiblingUrl(jobUrl: string, fromFn: string, toFn: string): string | null {
  const host = new RegExp(`-${fromFn}(?=\\.modal\\.run)`, "i");
  if (host.test(jobUrl)) return jobUrl.replace(host, `-${toFn}`);
  const path = new RegExp(`/${fromFn}/?$`, "i");
  if (path.test(jobUrl)) return jobUrl.replace(path, `/${toFn}`);
  return null;
}

/**
 * Resolve the endpoint for `fn`, preferring the explicit `envVar` override and
 * otherwise deriving it from MODAL_JOB_URL.
 */
function modalUrl(fn: ModalFn, envVar: string): string {
  const explicit = process.env[envVar]?.trim();
  if (explicit) return explicit;

  const jobUrl = process.env.MODAL_JOB_URL?.trim();
  if (!jobUrl) {
    throw new Error(`PROCESS_BACKEND=modal requires ${envVar}`);
  }

  const derived = deriveModalSiblingUrl(jobUrl, "wake", fn);
  if (!derived) {
    throw new Error(`Set ${envVar} — could not derive it from MODAL_JOB_URL`);
  }
  return derived;
}

/** POST to a Modal endpoint, attaching the shared secret and raising on a non-2xx. */
async function postToModal(
  url: string,
  body: Record<string, unknown>,
  label: string,
): Promise<Response> {
  const secret = process.env.MODAL_WEBHOOK_SECRET?.trim();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, ...(secret ? { secret } : {}) }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${label} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res;
}

export async function wakeModalJob(jobId: string): Promise<void> {
  if (!isModalBackend()) return;
  await postToModal(modalUrl("wake", "MODAL_JOB_URL"), { jobId }, "Modal wake");
}

/**
 * Wake the GPU stem-separation worker. Separate endpoint from `wake` because
 * it runs a different Modal function on a different (GPU) image.
 * Uses MODAL_STEMS_URL when set; otherwise derives it from MODAL_JOB_URL.
 */
export async function wakeModalStemJob(jobId: string): Promise<void> {
  if (!isModalBackend()) return;
  await postToModal(modalUrl("wake-stems", "MODAL_STEMS_URL"), { jobId }, "Modal stem wake");
}

export type ModalSearchCandidate = {
  url: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  durationSec: number;
};

/**
 * Synchronous SoundCloud search on Modal (yt-dlp is not on Vercel).
 * Uses MODAL_SEARCH_URL when set; otherwise derives it from MODAL_JOB_URL.
 */
export async function wakeModalSearch(query: string): Promise<ModalSearchCandidate[]> {
  const res = await postToModal(modalUrl("search", "MODAL_SEARCH_URL"), { query }, "Modal search");

  const data = (await res.json()) as { candidates?: ModalSearchCandidate[] };
  return Array.isArray(data.candidates) ? data.candidates : [];
}

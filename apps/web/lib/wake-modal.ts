/**
 * Wake the Modal worker to process a single job.
 * Set PROCESS_BACKEND=modal and MODAL_JOB_URL (+ MODAL_WEBHOOK_SECRET).
 *
 * MODAL_JOB_URL is the Modal fastapi endpoint URL from `modal deploy`.
 * Body: { jobId, secret? }
 */
export async function wakeModalJob(jobId: string): Promise<void> {
  const backend = (process.env.PROCESS_BACKEND ?? "pgboss").toLowerCase();
  if (backend !== "modal") return;

  const url = process.env.MODAL_JOB_URL?.trim();
  if (!url) {
    throw new Error("PROCESS_BACKEND=modal requires MODAL_JOB_URL");
  }

  const secret = process.env.MODAL_WEBHOOK_SECRET?.trim();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jobId,
      ...(secret ? { secret } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Modal wake failed (${res.status}): ${text.slice(0, 500)}`);
  }
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
 * Uses MODAL_SEARCH_URL when set; otherwise derives it from MODAL_JOB_URL
 * by replacing the trailing `/wake` with `/search`.
 */
export async function wakeModalSearch(
  query: string,
): Promise<ModalSearchCandidate[]> {
  const secret = process.env.MODAL_WEBHOOK_SECRET?.trim();
  let url = process.env.MODAL_SEARCH_URL?.trim();
  if (!url) {
    const jobUrl = process.env.MODAL_JOB_URL?.trim();
    if (!jobUrl) {
      throw new Error(
        "PROCESS_BACKEND=modal requires MODAL_SEARCH_URL or MODAL_JOB_URL",
      );
    }
    url = jobUrl.replace(/\/wake\/?$/, "/search");
    if (url === jobUrl) {
      throw new Error(
        "Set MODAL_SEARCH_URL — could not derive it from MODAL_JOB_URL",
      );
    }
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query,
      ...(secret ? { secret } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Modal search failed (${res.status}): ${text.slice(0, 500)}`,
    );
  }

  const data = (await res.json()) as {
    candidates?: ModalSearchCandidate[];
  };
  return Array.isArray(data.candidates) ? data.candidates : [];
}

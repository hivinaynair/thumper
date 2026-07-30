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

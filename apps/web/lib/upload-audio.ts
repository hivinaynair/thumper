"use client";

import { safeUploadName, safeUserId } from "@thumper/shared";
import { upload } from "@vercel/blob/client";

/**
 * Parse a JSON response, turning the two non-JSON failures the upload routes
 * can produce (a proxy's 413 page, an HTML error page) into readable errors.
 */
export async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const snippet = text.slice(0, 120).trim() || res.statusText;
    if (/request entity too large/i.test(snippet) || res.status === 413) {
      throw new Error(
        "File too large for the server route — use Blob upload (production) or a smaller file.",
      );
    }
    throw new Error(snippet || `Request failed (${res.status})`);
  }
}

export type UploadedAudio = {
  key: string;
  filename: string;
  searchQuery: string;
};

/**
 * Put one audio file where the job pipeline can read it.
 *
 * The route reports which mode it is in: `blob` uploads straight to Vercel
 * Blob (no 4.5 MB serverless body cap), `local` posts multipart to the route
 * itself. Retag and stems share one implementation because they share one
 * route — `/api/stems/upload` re-exports the retag handlers.
 */
export async function uploadAudio(
  file: File,
  endpoint: string,
  userId: string | null | undefined,
  onProgress?: (percentage: number) => void,
): Promise<UploadedAudio> {
  const modeRes = await fetch(endpoint);
  const modeData = await readJson(modeRes);
  if (!modeRes.ok) throw new Error(String(modeData.error || "Upload config failed"));

  if (modeData.mode === "blob") {
    if (!userId) throw new Error("Sign in required");
    const pathname = `users/${safeUserId(userId)}/uploads/${crypto.randomUUID()}/${safeUploadName(file.name)}`;
    const blob = await upload(pathname, file, {
      access: "private",
      handleUploadUrl: endpoint,
      multipart: true,
      onUploadProgress: onProgress ? (event) => onProgress(event.percentage) : undefined,
      contentType: file.type || "audio/wav",
    });
    return { key: blob.pathname, filename: file.name, searchQuery: file.name };
  }

  const form = new FormData();
  form.set("file", file);
  const upRes = onProgress
    ? await new Promise<Response>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", endpoint);
        request.upload.onprogress = (event) => {
          if (event.lengthComputable) onProgress((event.loaded / event.total) * 100);
        };
        request.onload = () =>
          resolve(new Response(request.responseText, { status: request.status }));
        request.onerror = () =>
          reject(new Error("Upload interrupted. Check your connection and try again."));
        request.onabort = () => reject(new Error("Upload cancelled."));
        request.send(form);
      })
    : await fetch(endpoint, { method: "POST", body: form });
  const up = await readJson(upRes);
  if (!upRes.ok) throw new Error(String(up.error || "Upload failed"));
  return {
    key: String(up.inputStorageKey),
    filename: String(up.filename ?? file.name),
    searchQuery: String(up.searchQuery || file.name),
  };
}

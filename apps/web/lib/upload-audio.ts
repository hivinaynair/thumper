"use client";

import { UPLOAD_PART_SIZE } from "@thumper/shared";

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
        "File too large for the server route — use object storage (production) or a smaller file.",
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

type UploadPart = { partNumber: number; url: string };

/**
 * Put one audio file where the job pipeline can read it.
 *
 * The route reports which mode it is in: `object` uploads straight to R2
 * (no 4.5 MB serverless body cap), `local` posts multipart to the route
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

  if (modeData.mode === "object") {
    if (!userId) throw new Error("Sign in required");
    return uploadToObjectStore(file, endpoint, onProgress);
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

async function uploadToObjectStore(
  file: File,
  endpoint: string,
  onProgress?: (percentage: number) => void,
): Promise<UploadedAudio> {
  const createRes = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "create",
      filename: file.name,
      contentType: file.type || "audio/wav",
      size: file.size,
    }),
  });
  const created = await readJson(createRes);
  if (!createRes.ok) throw new Error(String(created.error || "Upload config failed"));

  const key = String(created.key);
  const filename = String(created.filename ?? file.name);
  const searchQuery = String(created.searchQuery || file.name);

  if (created.strategy === "put") {
    await putBlob(String(created.url), file, file.type || "audio/wav", (loaded) => {
      onProgress?.(file.size ? (loaded / file.size) * 100 : 100);
    });
    return { key, filename, searchQuery };
  }

  const uploadId = String(created.uploadId ?? "");
  const parts = Array.isArray(created.parts) ? (created.parts as UploadPart[]) : [];
  if (!uploadId || parts.length === 0) throw new Error("Upload config failed");

  try {
    const completed: { partNumber: number; etag: string }[] = [];
    let uploaded = 0;
    for (const part of parts) {
      const from = (part.partNumber - 1) * UPLOAD_PART_SIZE;
      const chunk = file.slice(from, Math.min(from + UPLOAD_PART_SIZE, file.size));
      const etag = await putBlob(part.url, chunk, undefined, (loaded) => {
        onProgress?.(file.size ? ((uploaded + loaded) / file.size) * 100 : 100);
      });
      uploaded += chunk.size;
      completed.push({ partNumber: part.partNumber, etag });
    }

    const doneRes = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "complete", key, uploadId, parts: completed }),
    });
    const done = await readJson(doneRes);
    if (!doneRes.ok) throw new Error(String(done.error || "Upload failed"));
    return {
      key: String(done.inputStorageKey ?? key),
      filename: String(done.filename ?? filename),
      searchQuery: String(done.searchQuery || searchQuery),
    };
  } catch (err) {
    await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "abort", key, uploadId }),
    }).catch(() => undefined);
    throw err;
  }
}

function putBlob(
  url: string,
  body: Blob,
  contentType: string | undefined,
  onProgress?: (loaded: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    if (contentType) request.setRequestHeader("Content-Type", contentType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(request.getResponseHeader("ETag") ?? "");
        return;
      }
      reject(new Error(request.responseText || `Upload failed (${request.status})`));
    };
    request.onerror = () =>
      reject(new Error("Upload interrupted. Check your connection and try again."));
    request.onabort = () => reject(new Error("Upload cancelled."));
    request.send(body);
  });
}

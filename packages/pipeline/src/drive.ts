import { google } from "googleapis";
import type { drive_v3 } from "googleapis";
import fs from "node:fs";

const FOLDER_NAME = "Thumper";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Resolve the "Thumper" folder, creating it if needed.
 *
 * The drive.file scope only exposes files this app created, so the lookup can
 * only ever find a folder we made ourselves — which is exactly what we want.
 * If the user trashes or renames it, the next upload makes a fresh one.
 */
async function ensureFolder(drive: drive_v3.Drive): Promise<string | undefined> {
  try {
    const found = await drive.files.list({
      q: `name = '${FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "files(id)",
      pageSize: 1,
    });
    const existing = found.data.files?.[0]?.id;
    if (existing) return existing;

    const created = await drive.files.create({
      requestBody: { name: FOLDER_NAME, mimeType: FOLDER_MIME },
      fields: "id",
    });
    return created.data.id ?? undefined;
  } catch {
    // Never fail an upload over folder placement — fall back to Drive root.
    return undefined;
  }
}

export async function uploadToDrive(params: {
  accessToken: string;
  filePath: string;
  filename: string;
  mimeType?: string;
}): Promise<{ fileId: string; webViewLink?: string }> {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: params.accessToken });
  const drive = google.drive({ version: "v3", auth });

  const folderId = await ensureFolder(drive);

  const res = await drive.files.create({
    requestBody: {
      name: params.filename,
      mimeType: params.mimeType,
      ...(folderId ? { parents: [folderId] } : {}),
    },
    media: {
      mimeType: params.mimeType,
      body: fs.createReadStream(params.filePath),
    },
    fields: "id, webViewLink",
  });

  const fileId = res.data.id;
  if (!fileId) throw new Error("Drive upload returned no file id");
  return { fileId, webViewLink: res.data.webViewLink ?? undefined };
}

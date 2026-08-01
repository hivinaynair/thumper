import { google } from "googleapis";
import type { drive_v3 } from "googleapis";
import fs from "node:fs";

const FOLDER_NAME = "Thumper";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Drive file names can't contain `/` or NUL; keep the rest of the playlist
 * title so the folder is recognisable in the Thumper directory.
 */
export function sanitizeDriveFolderName(name: string): string {
  const cleaned = name
    .replace(/[/\x00]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "Playlist";
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Resolve the "Thumper" folder, creating it if needed.
 *
 * The drive.file scope only exposes files this app created, so the lookup can
 * only ever find a folder we made ourselves — which is exactly what we want.
 * If the user trashes or renames it, the next upload makes a fresh one.
 */
async function ensureFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId?: string,
): Promise<string | undefined> {
  try {
    const safe = sanitizeDriveFolderName(name);
    const parentClause = parentId
      ? ` and '${parentId}' in parents`
      : "";
    const found = await drive.files.list({
      q: `name = '${escapeDriveQueryValue(safe)}' and mimeType = '${FOLDER_MIME}' and trashed = false${parentClause}`,
      fields: "files(id)",
      pageSize: 1,
    });
    const existing = found.data.files?.[0]?.id;
    if (existing) return existing;

    const created = await drive.files.create({
      requestBody: {
        name: safe,
        mimeType: FOLDER_MIME,
        ...(parentId ? { parents: [parentId] } : {}),
      },
      fields: "id",
    });
    return created.data.id ?? undefined;
  } catch {
    // Never fail an upload over folder placement — fall back to parent/root.
    return undefined;
  }
}

async function ensureThumperFolder(
  drive: drive_v3.Drive,
): Promise<string | undefined> {
  return ensureFolder(drive, FOLDER_NAME);
}

/**
 * `Thumper/<playlist name>/` — created once by the parent playlist job so
 * concurrent child uploads don't race into duplicate folders.
 */
export async function ensurePlaylistFolder(params: {
  accessToken: string;
  playlistName: string;
}): Promise<string | undefined> {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: params.accessToken });
  const drive = google.drive({ version: "v3", auth });

  const thumperId = await ensureThumperFolder(drive);
  if (!thumperId) return undefined;
  return ensureFolder(drive, params.playlistName, thumperId);
}

export async function uploadToDrive(params: {
  accessToken: string;
  filePath: string;
  filename: string;
  mimeType?: string;
  /**
   * Pre-created playlist folder id. When set, the file goes in
   * `Thumper/<playlist>/`; otherwise it lands in `Thumper/` itself.
   */
  folderId?: string | null;
}): Promise<{ fileId: string; webViewLink?: string }> {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: params.accessToken });
  const drive = google.drive({ version: "v3", auth });

  const parentId =
    params.folderId || (await ensureThumperFolder(drive)) || undefined;

  const res = await drive.files.create({
    requestBody: {
      name: params.filename,
      mimeType: params.mimeType,
      ...(parentId ? { parents: [parentId] } : {}),
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

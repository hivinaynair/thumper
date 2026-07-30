import { google } from "googleapis";
import fs from "node:fs";

export async function uploadToDrive(params: {
  accessToken: string;
  filePath: string;
  filename: string;
  mimeType?: string;
}): Promise<{ fileId: string; webViewLink?: string }> {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: params.accessToken });
  const drive = google.drive({ version: "v3", auth });

  const res = await drive.files.create({
    requestBody: {
      name: params.filename,
      mimeType: params.mimeType,
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

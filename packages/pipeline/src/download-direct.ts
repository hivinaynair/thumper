import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const AUDIO_TYPES = /audio\/|octet-stream|zip|flac|wav|mpeg|mp4/i;
const HTML_TYPE = /text\/html/i;

export function withDropboxDirectDownload(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.replace(/^www\./, "").endsWith("dropbox.com")) {
      return url;
    }
    parsed.searchParams.set("dl", "1");
    return parsed.toString();
  } catch {
    return url;
  }
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star?.[1]) return decodeURIComponent(star[1].trim());
  const quoted = header.match(/filename="([^"]+)"/i);
  if (quoted?.[1]) return quoted[1];
  const plain = header.match(/filename=([^;]+)/i);
  return plain?.[1]?.trim() ?? null;
}

function extFromNameOrType(filename: string, contentType: string | null): string {
  const fromName = path.extname(filename).replace(/^\./, "").toLowerCase();
  if (fromName) return fromName;
  const type = contentType ?? "";
  if (type.includes("wav")) return "wav";
  if (type.includes("flac")) return "flac";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  if (type.includes("zip")) return "zip";
  if (type.includes("aiff") || type.includes("aif")) return "aiff";
  return "bin";
}

export type DirectDownloadResult = {
  filePath: string;
  filename: string;
  ext: string;
  title: string | null;
  size: number;
};

export async function downloadDirectFile(params: {
  url: string;
  workDir: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DirectDownloadResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const url = withDropboxDirectDownload(params.url);
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: params.signal,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) {
    throw new Error(`Direct download failed (${response.status})`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (HTML_TYPE.test(contentType) && !AUDIO_TYPES.test(contentType)) {
    throw new Error("Direct download returned HTML, not a downloadable file");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const filename =
    filenameFromContentDisposition(
      response.headers.get("content-disposition"),
    ) ?? `gate-${randomUUID()}.${extFromNameOrType("file", contentType)}`;
  const ext = extFromNameOrType(filename, contentType);
  await fs.mkdir(params.workDir, { recursive: true });
  const filePath = path.join(params.workDir, `direct_${randomUUID()}.${ext}`);
  await fs.writeFile(filePath, bytes);
  return {
    filePath,
    filename,
    ext,
    title: path.parse(filename).name || null,
    size: bytes.byteLength,
  };
}

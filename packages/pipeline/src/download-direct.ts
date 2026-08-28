import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const AUDIO_TYPES = /audio\/|octet-stream|zip|flac|wav|mpeg|mp4/i;
const HTML_TYPE = /text\/html/i;
const AUDIO_EXT_RANK = [
  ".wav",
  ".wave",
  ".flac",
  ".aiff",
  ".aif",
  ".mp3",
  ".m4a",
  ".aac",
];

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

export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

function audioRank(name: string): number {
  return AUDIO_EXT_RANK.indexOf(path.extname(name).toLowerCase());
}

export type ZipAudioEntry = {
  name: string;
  data: Buffer;
};

function readU16(bytes: Buffer, offset: number): number {
  return bytes.readUInt16LE(offset);
}

function readU32(bytes: Buffer, offset: number): number {
  return bytes.readUInt32LE(offset);
}

/** Best-effort local-header ZIP walk. Stored + deflate entries only. */
export function extractZipAudioEntries(bytes: Buffer): ZipAudioEntry[] {
  const entries: ZipAudioEntry[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    if (readU32(bytes, offset) !== 0x04034b50) break;
    const flags = readU16(bytes, offset + 6);
    const method = readU16(bytes, offset + 8);
    let compressedSize = readU32(bytes, offset + 18);
    let uncompressedSize = readU32(bytes, offset + 22);
    const nameLen = readU16(bytes, offset + 26);
    const extraLen = readU16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart > bytes.length) break;
    const name = bytes.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const dataDescriptor = (flags & 0x8) !== 0;
    if (dataDescriptor && compressedSize === 0) {
      break;
    }
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) break;
    const raw = bytes.subarray(dataStart, dataEnd);
    offset = dataEnd;
    if (name.endsWith("/")) continue;
    if (audioRank(name) < 0) continue;
    try {
      const data =
        method === 0
          ? Buffer.from(raw)
          : method === 8
            ? Buffer.from(inflateRawSync(raw))
            : null;
      if (!data) continue;
      if (uncompressedSize > 0 && data.length !== uncompressedSize) continue;
      entries.push({ name, data });
    } catch {
      /* skip corrupt entry */
    }
  }
  return entries;
}

export function preferredZipAudio(entries: ZipAudioEntry[]): ZipAudioEntry | null {
  const audio = entries.filter((entry) => audioRank(entry.name) >= 0 && entry.data.length > 0);
  audio.sort((a, b) => {
    const rankDelta = audioRank(a.name) - audioRank(b.name);
    if (rankDelta !== 0) return rankDelta;
    return b.data.length - a.data.length;
  });
  return audio[0] ?? null;
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
  const bytes = Buffer.from(await response.arrayBuffer());
  if (looksLikeZip(bytes)) {
    const chosen = preferredZipAudio(extractZipAudioEntries(bytes));
    if (!chosen) {
      throw new Error("Dropbox folder zip had no audio file");
    }
    const filename = path.basename(chosen.name);
    const ext = extFromNameOrType(filename, null);
    await fs.mkdir(params.workDir, { recursive: true });
    const filePath = path.join(params.workDir, `direct_${randomUUID()}.${ext}`);
    await fs.writeFile(filePath, chosen.data);
    return {
      filePath,
      filename,
      ext,
      title: path.parse(filename).name || null,
      size: chosen.data.byteLength,
    };
  }
  if (HTML_TYPE.test(contentType) && !AUDIO_TYPES.test(contentType)) {
    throw new Error("Direct download returned HTML, not a downloadable file");
  }
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

/**
 * HTTP headers are Latin-1. Track titles from YouTube often include curly
 * quotes (U+2019 in "It's"), and stuffing those into Content-Disposition
 * throws before any bytes are sent — Chrome then shows a generic 500 page.
 */
export function contentDispositionAttachment(filename: string): string {
  const fallback = asciiFilename(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

function asciiFilename(filename: string): string {
  const ascii = filename
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["/\\]/g, "")
    .trim();
  return ascii || "download";
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => {
    const hex = char.charCodeAt(0).toString(16).toUpperCase();
    return `%${hex}`;
  });
}

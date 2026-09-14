import { afterEach, describe, expect, it, mock } from "bun:test";
import { UPLOAD_PART_SIZE } from "@thumper/shared";
import { readJson, uploadAudio } from "./upload-audio";

class FakeXHR {
  status = 200;
  responseText = "";
  upload = { onprogress: null as ((event: ProgressEvent<EventTarget>) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  sent: Blob | FormData | null = null;
  contentType: string | undefined;

  open() {}
  setRequestHeader(name: string, value: string) {
    if (name.toLowerCase() === "content-type") this.contentType = value;
  }
  getResponseHeader(name: string) {
    return name.toLowerCase() === "etag" ? '"part-etag"' : null;
  }
  send(body?: Document | XMLHttpRequestBodyInit | null) {
    this.sent = body as Blob | FormData;
    this.onload?.();
  }
}

const originalFetch = globalThis.fetch;
const OriginalXHR = globalThis.XMLHttpRequest;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = OriginalXHR;
});

describe("readJson", () => {
  it("turns a 413 HTML page into a readable size error", async () => {
    await expect(
      readJson(
        new Response("<html>Request Entity Too Large</html>", {
          status: 413,
          statusText: "Payload Too Large",
        }),
      ),
    ).rejects.toThrow(/object storage/);
  });
});

describe("uploadAudio", () => {
  it("PUTs a small file straight to the presigned R2 URL", async () => {
    const file = new File(["wav-bytes"], "track.wav", { type: "audio/wav" });
    const calls: { url: string; body?: unknown }[] = [];

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let body: unknown;
      if (typeof init?.body === "string") body = JSON.parse(init.body);
      calls.push({ url, body });
      if (!init?.method || init.method === "GET") {
        return Response.json({ mode: "object", maxBytes: 500 * 1024 * 1024 });
      }
      return Response.json({
        strategy: "put",
        key: "users/user_1/uploads/abc/track.wav",
        url: "https://r2.example/put",
        filename: "track.wav",
        searchQuery: "track",
      });
    }) as typeof fetch;

    const sent: FakeXHR[] = [];
    globalThis.XMLHttpRequest = class extends FakeXHR {
      send(body?: Document | XMLHttpRequestBodyInit | null) {
        sent.push(this);
        super.send(body);
      }
    } as unknown as typeof XMLHttpRequest;

    const uploaded = await uploadAudio(file, "/api/retag/upload", "user_1");

    expect(uploaded).toEqual({
      key: "users/user_1/uploads/abc/track.wav",
      filename: "track.wav",
      searchQuery: "track",
    });
    expect(calls[1]?.body).toEqual({
      action: "create",
      filename: "track.wav",
      contentType: "audio/wav",
      size: file.size,
    });
    expect(sent[0]?.contentType).toBe("audio/wav");
    expect(sent[0]?.sent).toBe(file);
  });

  it("uploads matching 10 MiB parts then completes the multipart session", async () => {
    const size = UPLOAD_PART_SIZE + 12;
    const file = new File([new Uint8Array(size)], "big.wav", { type: "audio/wav" });
    const sentSizes: number[] = [];
    const calls: unknown[] = [];

    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Response.json({ mode: "object" });
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(body);
      if (body.action === "create") {
        return Response.json({
          strategy: "multipart",
          key: "users/user_1/uploads/abc/big.wav",
          uploadId: "upl_1",
          filename: "big.wav",
          searchQuery: "big",
          parts: [
            { partNumber: 1, url: "https://r2.example/part1" },
            { partNumber: 2, url: "https://r2.example/part2" },
          ],
        });
      }
      return Response.json({
        inputStorageKey: "users/user_1/uploads/abc/big.wav",
        filename: "big.wav",
        searchQuery: "big",
      });
    }) as typeof fetch;

    globalThis.XMLHttpRequest = class extends FakeXHR {
      send(body?: Document | XMLHttpRequestBodyInit | null) {
        sentSizes.push(body instanceof Blob ? body.size : 0);
        super.send(body);
      }
    } as unknown as typeof XMLHttpRequest;

    const uploaded = await uploadAudio(file, "/api/stems/upload", "user_1");
    expect(uploaded.key).toBe("users/user_1/uploads/abc/big.wav");
    expect(sentSizes).toEqual([UPLOAD_PART_SIZE, 12]);
    expect(calls[1]).toEqual({
      action: "complete",
      key: "users/user_1/uploads/abc/big.wav",
      uploadId: "upl_1",
      parts: [
        { partNumber: 1, etag: '"part-etag"' },
        { partNumber: 2, etag: '"part-etag"' },
      ],
    });
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadDirectFile, withDropboxDirectDownload } from "./download-direct";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function storedZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    parts.push(header, name, entry.data);
  }
  return Buffer.concat(parts);
}

describe("withDropboxDirectDownload", () => {
  it("forces dl=1 on Dropbox shared links", () => {
    expect(
      withDropboxDirectDownload(
        "https://www.dropbox.com/scl/fi/abc/track.wav?rlkey=x&dl=0",
      ),
    ).toBe("https://www.dropbox.com/scl/fi/abc/track.wav?rlkey=x&dl=1");
  });

  it("leaves non-Dropbox URLs unchanged", () => {
    expect(withDropboxDirectDownload("https://example.com/a.wav")).toBe(
      "https://example.com/a.wav",
    );
  });
});

describe("downloadDirectFile", () => {
  it("saves the response body using the Content-Disposition filename", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "direct-dl-"));
    roots.push(workDir);
    const bytes = Buffer.from("RIFF....WAVEfmt ");

    const result = await downloadDirectFile({
      url: "https://www.dropbox.com/scl/fi/abc/track.wav?dl=0",
      workDir,
      fetchImpl: async (input) => {
        expect(String(input)).toContain("dl=1");
        return new Response(bytes, {
          headers: {
            "content-type": "audio/wav",
            "content-disposition": 'attachment; filename="Tremor Flip.wav"',
          },
        });
      },
    });

    expect(result.filename).toBe("Tremor Flip.wav");
    expect(result.ext).toBe("wav");
    expect(result.size).toBe(bytes.byteLength);
    expect(await fs.readFile(result.filePath)).toEqual(bytes);
  });

  it("rejects HTML landing pages", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "direct-dl-"));
    roots.push(workDir);
    await expect(
      downloadDirectFile({
        url: "https://www.dropbox.com/scl/fi/abc/track.wav?dl=0",
        workDir,
        fetchImpl: async () =>
          new Response("<html>login</html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      }),
    ).rejects.toThrow("not a downloadable file");
  });

  it("extracts the preferred WAV from a Dropbox folder zip even when Content-Type is HTML", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "direct-dl-"));
    roots.push(workDir);
    const wav = Buffer.alloc(64, 1);
    wav.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    const mp3 = Buffer.alloc(256, 2);
    mp3.set([0x49, 0x44, 0x33, 4]);
    const zip = storedZip([
      { name: "MP3/IN YOUR HEAD.mp3", data: mp3 },
      { name: "WAV/IN YOUR HEAD.wav", data: wav },
    ]);

    const result = await downloadDirectFile({
      url: "https://www.dropbox.com/sh/abc/folder?dl=0",
      workDir,
      fetchImpl: async () =>
        new Response(zip, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    expect(result.filename).toBe("IN YOUR HEAD.wav");
    expect(result.ext).toBe("wav");
    expect(result.size).toBe(wav.byteLength);
    expect(await fs.readFile(result.filePath)).toEqual(wav);
  });
});

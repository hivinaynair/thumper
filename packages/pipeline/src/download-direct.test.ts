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
});

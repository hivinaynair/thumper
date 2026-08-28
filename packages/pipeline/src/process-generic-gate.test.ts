import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processGenericGateDownload } from "./run-job";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("processGenericGateDownload", () => {
  it("saves a Dropbox direct file without launching Chromium", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "generic-gate-"));
    roots.push(workDir);
    let browser = 0;
    const result = await processGenericGateDownload({
      kind: "direct",
      gateUrl: "https://www.dropbox.com/scl/fi/abc/track.wav?dl=0",
      email: "dj@example.com",
      name: "DJ",
      userId: "user-1",
      workDir,
      requestedFormat: "flac",
      outputDirectory: workDir,
      titleHint: "Tremor",
      artistHint: "Tornatic",
      browserDownload: async () => {
        browser += 1;
        throw new Error("must not launch");
      },
      directDownload: async ({ url, workDir: dir }) => {
        expect(url).toContain("dropbox.com");
        const filePath = path.join(dir, "track.wav");
        await fs.writeFile(filePath, "WAV");
        return {
          filePath,
          filename: "Tremor Flip.wav",
          ext: "wav",
          title: "Tremor Flip",
          size: 3,
        };
      },
    });
    expect(browser).toBe(0);
    expect(result.downloaded.filename).toBe("Tremor Flip.wav");
    expect(result.artifact.action).not.toBe("normal-conversion");
  });

  it("opens a ToneDen gate in the browser path", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "generic-gate-"));
    roots.push(workDir);
    const result = await processGenericGateDownload({
      kind: "browser-gate",
      gateUrl: "https://www.toneden.io/artist/post/track",
      email: "dj@example.com",
      name: "DJ",
      userId: "user-1",
      workDir,
      requestedFormat: "flac",
      outputDirectory: workDir,
      materializeSpotifyCookies: async () => null,
      materializeInstagramCookies: async () => null,
      browserDownload: async ({ gateUrl, email }) => {
        expect(gateUrl).toContain("toneden.io");
        expect(email).toBe("dj@example.com");
        const filePath = path.join(workDir, "gate.mp3");
        await fs.writeFile(filePath, "ID3");
        return {
          filePath,
          filename: "unlock.mp3",
          ext: "mp3",
          title: "Unlock",
          size: 3,
        };
      },
    });
    expect(result.downloaded.ext).toBe("mp3");
  });

  it("injects Spotify, Instagram, and SoundCloud cookies into the generic browser gate", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "generic-gate-"));
    roots.push(workDir);
    const spotifyPath = path.join(workDir, "spotify.txt");
    const instagramPath = path.join(workDir, "instagram.txt");
    const soundcloudPath = path.join(workDir, "soundcloud.txt");
    await fs.writeFile(
      spotifyPath,
      ".spotify.com\tTRUE\t/\tTRUE\t2147483647\tsp_dc\tsecret",
    );
    await fs.writeFile(
      instagramPath,
      ".instagram.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\tig",
    );
    await fs.writeFile(
      soundcloudPath,
      ".soundcloud.com\tTRUE\t/\tTRUE\t2147483647\toauth_token\tsc",
    );
    const names: string[] = [];
    const unlinked: string[] = [];

    await processGenericGateDownload({
      kind: "browser-gate",
      gateUrl: "https://www.toneden.io/artist/post/track",
      email: "dj@example.com",
      name: "DJ",
      userId: "user-1",
      workDir,
      requestedFormat: "flac",
      outputDirectory: workDir,
      materializeSpotifyCookies: async () => spotifyPath,
      materializeInstagramCookies: async () => instagramPath,
      materializeSoundCloudCookies: async () => soundcloudPath,
      readCookieFile: (filePath) => fs.readFile(filePath, "utf8"),
      unlinkCookieFile: async (filePath) => {
        unlinked.push(filePath);
        await fs.unlink(filePath);
      },
      browserDownload: async ({ cookies }) => {
        names.push(...cookies.map((cookie) => cookie.name));
        const filePath = path.join(workDir, "gate.mp3");
        await fs.writeFile(filePath, "ID3");
        return {
          filePath,
          filename: "unlock.mp3",
          ext: "mp3",
          title: "Unlock",
          size: 3,
        };
      },
    });

    expect(names).toEqual(["sp_dc", "sessionid", "oauth_token"]);
    expect(unlinked).toEqual([spotifyPath, instagramPath, soundcloudPath]);
  });
});

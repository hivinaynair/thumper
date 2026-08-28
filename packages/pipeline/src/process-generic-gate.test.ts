import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processGenericGateDownload } from "./run-job";
import { ManualDownloadRequiredError } from "./soundcloud-purchase";

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

  it("injects Spotify and Instagram cookies into the generic browser gate", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "generic-gate-"));
    roots.push(workDir);
    const spotifyPath = path.join(workDir, "spotify.txt");
    const instagramPath = path.join(workDir, "instagram.txt");
    await fs.writeFile(
      spotifyPath,
      ".spotify.com\tTRUE\t/\tTRUE\t2147483647\tsp_dc\tsecret",
    );
    await fs.writeFile(
      instagramPath,
      ".instagram.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\tig",
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

    expect(names).toEqual(["sp_dc", "sessionid"]);
    expect(unlinked).toEqual([spotifyPath, instagramPath]);
  });

  it("fails closed on a Laylo RSVP drop with no hosted file", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "generic-gate-"));
    roots.push(workDir);
    let browser = 0;
    let direct = 0;
    await expect(
      processGenericGateDownload({
        kind: "browser-gate",
        gateUrl: "https://laylo.com/controlfreakus/gaOHY",
        email: "dj@example.com",
        name: "DJ",
        userId: "user-1",
        workDir,
        requestedFormat: "flac",
        outputDirectory: workDir,
        fetchLaylo: async () => ({
          title: "MEAN GIRLS",
          link: null,
          emailRequired: true,
        }),
        browserDownload: async () => {
          browser += 1;
          throw new Error("must not launch");
        },
        directDownload: async () => {
          direct += 1;
          throw new Error("must not download");
        },
      }),
    ).rejects.toBeInstanceOf(ManualDownloadRequiredError);
    expect(browser).toBe(0);
    expect(direct).toBe(0);
  });

  it("downloads a Laylo hosted file without launching Chromium", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "generic-gate-"));
    roots.push(workDir);
    let browser = 0;
    const result = await processGenericGateDownload({
      kind: "browser-gate",
      gateUrl: "https://laylo.com/viperactive/czJvU8",
      email: "dj@example.com",
      name: "DJ",
      userId: "user-1",
      workDir,
      requestedFormat: "flac",
      outputDirectory: workDir,
      fetchLaylo: async () => ({
        title: "BODIES",
        link: "https://cdn.example.test/bodies.wav",
        emailRequired: false,
      }),
      browserDownload: async () => {
        browser += 1;
        throw new Error("must not launch");
      },
      directDownload: async ({ url, workDir: dir }) => {
        expect(url).toBe("https://cdn.example.test/bodies.wav");
        const filePath = path.join(dir, "bodies.wav");
        await fs.writeFile(filePath, "WAV");
        return {
          filePath,
          filename: "bodies.wav",
          ext: "wav",
          title: "bodies",
          size: 3,
        };
      },
    });
    expect(browser).toBe(0);
    expect(result.downloaded.filename).toBe("bodies.wav");
  });
});

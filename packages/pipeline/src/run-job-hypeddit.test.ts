import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { BrowserRequiredError } from "./hypeddit";
import { processHypedditOriginalDownload } from "./run-job";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function baseParams() {
  return {
    gateUrl: "https://hypeddit.com/artist/track",
    email: "listener@example.com",
    name: "Listener",
    userId: "user-1",
    workDir: "/work",
    requestedFormat: "flac" as const,
    outputDirectory: "/downloads",
    displayName: "Artist - Track",
  };
}

describe("processHypedditOriginalDownload", () => {
  it("materializes Spotify cookies, runs browser fallback, unlinks, and routes the result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-job-hypeddit-"));
    roots.push(root);
    const cookiePath = path.join(root, "spotify.txt");
    await fs.writeFile(
      cookiePath,
      ".spotify.com\tTRUE\t/\tTRUE\t2147483647\tsp_dc\tsecret",
    );
    const calls: string[] = [];

    const result = await processHypedditOriginalDownload({
      ...baseParams(),
      fallbackDependencies: {
        browserlessDownload: async () => {
          throw new BrowserRequiredError(["sp"]);
        },
        materializeSpotifyCookies: async () => {
          calls.push("materialize");
          return cookiePath;
        },
        readCookieFile: (filePath) => fs.readFile(filePath, "utf8"),
        browserDownload: async ({ cookies }) => {
          calls.push(`browser:${cookies[0]?.name}`);
          return {
            filePath: "/work/hypeddit.mp3",
            ext: "mp3",
            filename: "Artist upload.mp3",
            title: "Track",
            size: 123,
          };
        },
        unlinkCookieFile: async (filePath) => {
          calls.push("unlink");
          await fs.unlink(filePath);
        },
      },
      planArtifact: (input) => {
        calls.push(`route:${input.downloadedPath}`);
        return { action: "preserve-original" } as never;
      },
    });

    expect(calls).toEqual([
      "materialize",
      "browser:sp_dc",
      "unlink",
      "route:/work/hypeddit.mp3",
    ]);
    expect(result.downloaded.filename).toBe("Artist upload.mp3");
    expect(result.artifact.action).toBe("preserve-original");
  });

  it("materializes Instagram cookies when the gate requires a follow", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-job-hypeddit-"));
    roots.push(root);
    const cookiePath = path.join(root, "instagram.txt");
    await fs.writeFile(
      cookiePath,
      ".instagram.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\tsecret",
    );
    const calls: string[] = [];

    const result = await processHypedditOriginalDownload({
      ...baseParams(),
      fallbackDependencies: {
        browserlessDownload: async () => {
          throw new BrowserRequiredError(["ig"]);
        },
        materializeInstagramCookies: async () => {
          calls.push("materialize");
          return cookiePath;
        },
        readCookieFile: (filePath) => fs.readFile(filePath, "utf8"),
        browserDownload: async ({ cookies }) => {
          calls.push(`browser:${cookies[0]?.name}`);
          return {
            filePath: "/work/hypeddit.mp3",
            ext: "mp3",
            filename: "Artist upload.mp3",
            title: "Track",
            size: 123,
          };
        },
        unlinkCookieFile: async (filePath) => {
          calls.push("unlink");
          await fs.unlink(filePath);
        },
      },
      planArtifact: (input) => {
        calls.push(`route:${input.downloadedPath}`);
        return { action: "preserve-original" } as never;
      },
    });

    expect(calls).toEqual([
      "materialize",
      "browser:sessionid",
      "unlink",
      "route:/work/hypeddit.mp3",
    ]);
    expect(result.downloaded.filename).toBe("Artist upload.mp3");
  });

  it("does not launch or route when the Spotify cookie is missing", async () => {
    let browserLaunches = 0;
    let routes = 0;
    const promise = processHypedditOriginalDownload({
      ...baseParams(),
      fallbackDependencies: {
        browserlessDownload: async () => {
          throw new BrowserRequiredError(["sp"]);
        },
        materializeSpotifyCookies: async () => null,
        browserDownload: async () => {
          browserLaunches += 1;
          throw new Error("must not launch");
        },
      },
      planArtifact: () => {
        routes += 1;
        return {} as never;
      },
    });

    expect(promise).rejects.toThrow("refresh Spotify cookies");
    await promise.catch(() => undefined);
    expect(browserLaunches).toBe(0);
    expect(routes).toBe(0);
  });

  it("does not materialize, launch, or route an unknown-provider signal", async () => {
    let materializations = 0;
    let browserLaunches = 0;
    let routes = 0;
    const promise = processHypedditOriginalDownload({
      ...baseParams(),
      fallbackDependencies: {
        browserlessDownload: async () => {
          throw new BrowserRequiredError(["future-provider"]);
        },
        materializeSpotifyCookies: async () => {
          materializations += 1;
          return "/tmp/must-not-exist";
        },
        browserDownload: async () => {
          browserLaunches += 1;
          throw new Error("must not launch");
        },
      },
      planArtifact: () => {
        routes += 1;
        return {} as never;
      },
    });

    expect(promise).rejects.toBeInstanceOf(BrowserRequiredError);
    await promise.catch(() => undefined);
    expect(materializations).toBe(0);
    expect(browserLaunches).toBe(0);
    expect(routes).toBe(0);
  });
});

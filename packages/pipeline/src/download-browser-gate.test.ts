import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  downloadBrowserGate,
  isCapturedGateFilename,
  layloDropJsonUrl,
  looksLikeSocialFollowWall,
  waitForDownloadedFile,
} from "./download-browser-gate";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("downloadBrowserGate", () => {
  it("fills email, clicks Download, and writes the captured file", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-gate-"));
    roots.push(workDir);
    const calls: string[] = [];

    const result = await downloadBrowserGate({
      gateUrl: "https://www.toneden.io/artist/post/track",
      email: "dj@example.com",
      name: "DJ",
      workDir,
      cookies: [],
      launcher: {
        launch: async () => ({
          createBrowserContext: async () => ({
            setCookie: async () => undefined,
            newPage: async () => ({
              setDefaultTimeout: () => undefined,
              goto: async (url: string) => {
                calls.push(`goto:${url}`);
              },
              $$eval: async (selector: string) => {
                calls.push(`eval:${selector}`);
                return 0;
              },
              $: async (selector: string) => {
                if (selector.includes("email") || selector.includes("type=email")) {
                  calls.push("email-input");
                  return {
                    type: async (value: string) => {
                      calls.push(`type:${value}`);
                    },
                  };
                }
                return null;
              },
              click: async (selector: string) => {
                calls.push(`click:${selector}`);
              },
              waitForSelector: async () => ({}),
              waitForNetworkIdle: async () => undefined,
              evaluate: async () => {
                calls.push("click-download");
                return true;
              },
            }),
            close: async () => {
              calls.push("close-context");
            },
          }),
          close: async () => {
            calls.push("close-browser");
          },
        }),
      },
      captureDownload: async ({ workDir: dir }) => {
        calls.push("capture");
        const filePath = path.join(dir, "gate.wav");
        await fs.writeFile(filePath, "WAVDATA");
        return {
          filePath,
          filename: "gate.wav",
          ext: "wav",
          title: null,
          size: 7,
        };
      },
    });

    expect(calls).toContain("goto:https://www.toneden.io/artist/post/track");
    expect(calls).toContain("click-download");
    expect(calls).toContain("capture");
    expect(result.filename).toBe("gate.wav");
    expect(result.ext).toBe("wav");
  });

  it("fails when no download control or file appears", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-gate-"));
    roots.push(workDir);
    await expect(
      downloadBrowserGate({
        gateUrl: "https://gaterush.me/x",
        email: "dj@example.com",
        name: "DJ",
        workDir,
        cookies: [],
        launcher: {
          launch: async () => ({
            createBrowserContext: async () => ({
              setCookie: async () => undefined,
              newPage: async () => ({
                setDefaultTimeout: () => undefined,
                goto: async () => undefined,
                $: async () => null,
                evaluate: async () => false,
                waitForNetworkIdle: async () => undefined,
              }),
              close: async () => undefined,
            }),
            close: async () => undefined,
          }),
        },
        captureDownload: async () => {
          throw new Error("no file");
        },
      }),
    ).rejects.toThrow(/no file|Download control/);
  });

  it("keeps the Chromium profile out of the download folder", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-gate-"));
    roots.push(workDir);
    let userDataDir = "";

    await downloadBrowserGate({
      gateUrl: "https://www.toneden.io/artist/post/track",
      email: "dj@example.com",
      name: "DJ",
      workDir,
      cookies: [],
      launcher: {
        launch: async (options) => {
          userDataDir = options.userDataDir;
          return {
            createBrowserContext: async () => ({
              setCookie: async () => undefined,
              newPage: async () => ({
                setDefaultTimeout: () => undefined,
                goto: async () => undefined,
                $: async () => null,
                evaluate: async () => true,
                waitForNetworkIdle: async () => undefined,
              }),
              close: async () => undefined,
            }),
            close: async () => undefined,
          };
        },
      },
      captureDownload: async () => ({
        filePath: path.join(workDir, "gate.wav"),
        filename: "gate.wav",
        ext: "wav",
        title: null,
        size: 1,
      }),
    });

    expect(userDataDir).toContain("thumper-chromium-");
    expect(userDataDir.startsWith(workDir)).toBe(false);
  });

  it("fails as a manual download when the page is a follow/unlock wall", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-gate-"));
    roots.push(workDir);
    let clicked = false;
    await expect(
      downloadBrowserGate({
        gateUrl: "https://www.toneden.io/aeonmode/post/track",
        email: "dj@example.com",
        name: "DJ",
        workDir,
        cookies: [],
        launcher: {
          launch: async () => ({
            createBrowserContext: async () => ({
              setCookie: async () => undefined,
              newPage: async () => ({
                setDefaultTimeout: () => undefined,
                goto: async () => undefined,
                $: async () => null,
                evaluate: async (fn: (...args: never[]) => unknown) => {
                  const source = String(fn);
                  if (source.includes("click")) {
                    clicked = true;
                    return true;
                  }
                  return "STEP 1 FOLLOW ON SOUNDCLOUD\nSTEP 2 FOLLOW ON SPOTIFY";
                },
                waitForNetworkIdle: async () => undefined,
              }),
              close: async () => undefined,
            }),
            close: async () => undefined,
          }),
        },
      }),
    ).rejects.toThrow(/Follow\/unlock required|Manual download required/);
    expect(clicked).toBe(false);
  });
});

describe("looksLikeSocialFollowWall", () => {
  it("detects ToneDen-style follow unlock steps", () => {
    expect(
      looksLikeSocialFollowWall(
        "THANKS SO MUCH FOR YOUR SUPPORT!\nSTEP 1\nFOLLOW ON SOUNDCLOUD\nSTEP 2\nFOLLOW ON SPOTIFY\nUNLOCK PROGRESS\nDOWNLOAD",
      ),
    ).toBe(true);
    expect(looksLikeSocialFollowWall("Follow to unlock the download")).toBe(
      true,
    );
    expect(looksLikeSocialFollowWall("Become a Superfan to download")).toBe(
      true,
    );
    expect(looksLikeSocialFollowWall("Download\nManage Privacy")).toBe(false);
  });
});

describe("layloDropJsonUrl", () => {
  it("maps a Laylo drop URL to the CDN JSON", () => {
    expect(layloDropJsonUrl("https://laylo.com/controlfreakus/gaOHY")).toBe(
      "https://d21i0hc4hl3bvt.cloudfront.net/controlfreakus/gaOHY.json",
    );
    expect(layloDropJsonUrl("https://www.toneden.io/x")).toBeNull();
  });
});

describe("isCapturedGateFilename", () => {
  it("accepts audio and zip downloads, not Chromium profile junk", () => {
    expect(isCapturedGateFilename("track.wav")).toBe(true);
    expect(isCapturedGateFilename("pack.zip")).toBe(true);
    expect(isCapturedGateFilename("ChromeFeatureState")).toBe(false);
    expect(isCapturedGateFilename("VariationsSeedV2")).toBe(false);
    expect(isCapturedGateFilename("track.wav.crdownload")).toBe(false);
  });
});

describe("waitForDownloadedFile", () => {
  it("ignores Chromium profile files until an audio download appears", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gate-dl-"));
    roots.push(directory);
    await fs.writeFile(path.join(directory, "ChromeFeatureState"), "x");
    await fs.writeFile(path.join(directory, "VariationsSeedV2"), "y");
    const pending = waitForDownloadedFile(directory, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await fs.writeFile(path.join(directory, "LOOK4MYLOVE.wav"), "WAVDATA");
    expect(await pending).toBe(path.join(directory, "LOOK4MYLOVE.wav"));
  });
});

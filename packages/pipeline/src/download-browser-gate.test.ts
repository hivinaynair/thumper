import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  downloadBrowserGate,
  isCapturedGateFilename,
  layloDropJsonUrl,
  looksLikeContactCaptureGate,
  looksLikeSocialFollowWall,
  matchesDownloadLabel,
  providerAuthorizationControlKind,
  waitForDownloadedFile,
} from "./download-browser-gate";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("matchesDownloadLabel", () => {
  it("accepts the DropLoud FREE DOWNLOAD button, not the footer Free Download Gate link", () => {
    expect(matchesDownloadLabel("FREE DOWNLOAD")).toBe(true);
    expect(matchesDownloadLabel("Download")).toBe(true);
    expect(matchesDownloadLabel("Free Download Gate")).toBe(false);
    expect(matchesDownloadLabel("Free Underground Music")).toBe(false);
  });
});

describe("providerAuthorizationControlKind", () => {
  it("accepts SoundCloud profile follow labels, not only a bare Connect", () => {
    expect(providerAuthorizationControlKind("Connect")).toBe("accept");
    expect(providerAuthorizationControlKind("Follow ROBUSTT ²")).toBe("accept");
    expect(providerAuthorizationControlKind("Following")).toBe("done");
    expect(providerAuthorizationControlKind("Like")).toBe(null);
  });
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
                evaluate: async () =>
                  "STEP 1 FOLLOW ON SOUNDCLOUD\nSTEP 2 FOLLOW ON SPOTIFY",
                waitForNetworkIdle: async () => undefined,
              }),
              close: async () => undefined,
            }),
            close: async () => undefined,
          }),
        },
      }),
    ).rejects.toThrow(/Follow\/unlock required|Manual download required/);
  });

  it("skips Laylo/Vault RSVP pages as not a file gate", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-gate-"));
    roots.push(workDir);
    await expect(
      downloadBrowserGate({
        gateUrl: "https://laylo.com/arlobeats/WQeRBm",
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
                evaluate: async () =>
                  "Get a text with the download link\nRSVP by SMS\nPut your phone number in",
                waitForNetworkIdle: async () => undefined,
              }),
              close: async () => undefined,
            }),
            close: async () => undefined,
          }),
        },
      }),
    ).rejects.toThrow(/phone number or RSVP/);
  });

  it("opens follow tabs without cookies and still captures the file", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-gate-"));
    roots.push(workDir);
    const calls: string[] = [];
    let evals = 0;
    const result = await downloadBrowserGate({
      gateUrl: "https://www.toneden.io/mayetrix/post/track",
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
              evaluate: async () => {
                evals += 1;
                if (evals <= 2) return "Thanks for visiting";
                if (evals === 3) {
                  calls.push("read-wall");
                  return "STEP 1 FOLLOW ON SOUNDCLOUD";
                }
                if (evals === 4) {
                  calls.push("click-follow");
                  return 1;
                }
                if (evals === 5) {
                  calls.push("click-download");
                  return true;
                }
                return "Download\nManage Privacy";
              },
              waitForNetworkIdle: async () => undefined,
            }),
            close: async () => undefined,
          }),
          close: async () => undefined,
        }),
      },
      captureDownload: async ({ workDir: dir }) => {
        calls.push("capture");
        const filePath = path.join(dir, "gate.wav");
        await fs.writeFile(filePath, "WAV");
        return {
          filePath,
          filename: "gate.wav",
          ext: "wav",
          title: null,
          size: 3,
        };
      },
    });

    expect(calls).toEqual([
      "read-wall",
      "click-follow",
      "click-download",
      "capture",
    ]);
    expect(result.filename).toBe("gate.wav");
  });

  it("clicks ToneDen follow steps when SoundCloud cookies are present", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-gate-"));
    roots.push(workDir);
    const calls: string[] = [];
    let evals = 0;
    const result = await downloadBrowserGate({
      gateUrl: "https://www.toneden.io/mayetrix/post/track",
      email: "dj@example.com",
      name: "DJ",
      workDir,
      cookies: [
        {
          name: "oauth_token",
          value: "sc",
          domain: ".soundcloud.com",
          path: "/",
          secure: true,
          httpOnly: false,
        },
      ],
      launcher: {
        launch: async () => ({
          createBrowserContext: async () => ({
            setCookie: async () => undefined,
            newPage: async () => ({
              setDefaultTimeout: () => undefined,
              goto: async () => undefined,
              $: async () => null,
              evaluate: async () => {
                evals += 1;
                if (evals === 1) return "Thanks for visiting";
                if (evals === 2) return "Thanks for visiting";
                if (evals === 3) {
                  calls.push("read-wall");
                  return "STEP 1 FOLLOW ON SOUNDCLOUD\nSTEP 2 FOLLOW ON SPOTIFY";
                }
                if (evals === 4) {
                  calls.push("click-follow");
                  return 2;
                }
                if (evals === 5) {
                  calls.push("click-download");
                  return true;
                }
                calls.push("read-unlocked");
                return "Download\nManage Privacy";
              },
              waitForNetworkIdle: async () => undefined,
            }),
            close: async () => undefined,
          }),
          close: async () => undefined,
        }),
      },
      captureDownload: async ({ workDir: dir }) => {
        calls.push("capture");
        const filePath = path.join(dir, "gate.wav");
        await fs.writeFile(filePath, "WAV");
        return {
          filePath,
          filename: "gate.wav",
          ext: "wav",
          title: null,
          size: 3,
        };
      },
    });

    expect(calls).toEqual([
      "read-wall",
      "click-follow",
      "click-download",
      "read-unlocked",
      "capture",
    ]);
    expect(result.filename).toBe("gate.wav");
  });

  it("accepts SoundCloud and Spotify OAuth popups before unlocking ToneDen", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-gate-"));
    roots.push(workDir);
    const authorized: string[] = [];
    const wall =
      "STEP 1 FOLLOW ON SOUNDCLOUD\nSTEP 2 FOLLOW ON SPOTIFY\nUNLOCK PROGRESS";
    const popups = [
      {
        url: () => "https://soundcloud.com/connect?client_id=toneden",
        evaluate: async () => {
          authorized.push("soundcloud");
          return true;
        },
      },
      {
        url: () => "https://accounts.spotify.com/authorize?client_id=toneden",
        evaluate: async () => {
          authorized.push("spotify");
          return true;
        },
      },
    ];
    let evals = 0;

    const result = await downloadBrowserGate({
      gateUrl:
        "https://www.toneden.io/mayetrix/post/skrillex-nitepunk-soma-mayetrix-remix",
      email: "dj@example.com",
      name: "DJ",
      workDir,
      cookies: [
        {
          name: "oauth_token",
          value: "sc",
          domain: ".soundcloud.com",
          path: "/",
          secure: true,
          httpOnly: false,
        },
        {
          name: "sp_dc",
          value: "sp",
          domain: ".spotify.com",
          path: "/",
          secure: true,
          httpOnly: true,
        },
      ],
      launcher: {
        launch: async () => ({
          createBrowserContext: async () => ({
            setCookie: async () => undefined,
            waitForTarget: async (
              predicate: (target: {
                url(): string;
                opener(): unknown;
                page(): Promise<unknown>;
              }) => boolean,
            ) => {
              const popup = popups.shift();
              if (!popup) {
                const error = new Error("timeout");
                error.name = "TimeoutError";
                throw error;
              }
              const target = {
                url: () => popup.url(),
                opener: () => "main",
                page: async () => popup,
              };
              if (!predicate(target)) {
                const error = new Error("timeout");
                error.name = "TimeoutError";
                throw error;
              }
              return target;
            },
            newPage: async () => ({
              target: () => "main",
              setDefaultTimeout: () => undefined,
              goto: async () => undefined,
              $: async () => null,
              evaluate: async () => {
                evals += 1;
                if (evals === 1) return "Thanks for visiting";
                if (evals === 2) return "Thanks for visiting";
                if (evals === 3) return wall;
                if (evals === 4) return 2;
                if (evals === 5) return true;
                return authorized.length === 2
                  ? "Download\nManage Privacy"
                  : wall;
              },
              waitForNetworkIdle: async () => undefined,
            }),
            close: async () => undefined,
          }),
          close: async () => undefined,
        }),
      },
      captureDownload: async ({ workDir: dir }) => {
        const filePath = path.join(dir, "gate.wav");
        await fs.writeFile(filePath, "WAV");
        return {
          filePath,
          filename: "gate.wav",
          ext: "wav",
          title: null,
          size: 3,
        };
      },
    });

    expect(authorized).toEqual(["soundcloud", "spotify"]);
    expect(result.filename).toBe("gate.wav");
  });

  it("continues when a SoundCloud profile popup has no Connect button", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-gate-"));
    roots.push(workDir);
    const wall =
      "STEP 1 FOLLOW ON SOUNDCLOUD\nUNLOCK PROGRESS";
    let evals = 0;
    let popups = 1;

    const result = await downloadBrowserGate({
      gateUrl: "https://www.toneden.io/mayetrix/post/track",
      email: "dj@example.com",
      name: "DJ",
      workDir,
      cookies: [
        {
          name: "oauth_token",
          value: "sc",
          domain: ".soundcloud.com",
          path: "/",
          secure: true,
          httpOnly: false,
        },
      ],
      launcher: {
        launch: async () => ({
          createBrowserContext: async () => ({
            setCookie: async () => undefined,
            waitForTarget: async () => {
              if (popups <= 0) {
                const error = new Error("timeout");
                error.name = "TimeoutError";
                throw error;
              }
              popups -= 1;
              return {
                url: () => "https://soundcloud.com/robusttofficial2",
                opener: () => "main",
                page: async () => ({
                  url: () => "https://soundcloud.com/robusttofficial2",
                  evaluate: async () => false,
                }),
              };
            },
            newPage: async () => ({
              target: () => "main",
              setDefaultTimeout: () => undefined,
              goto: async () => undefined,
              $: async () => null,
              evaluate: async () => {
                evals += 1;
                if (evals === 1) return "Thanks for visiting";
                if (evals === 2) return "Thanks for visiting";
                if (evals === 3) return wall;
                if (evals === 4) return 1;
                if (evals === 5) return true;
                return "Download\nManage Privacy";
              },
              waitForNetworkIdle: async () => undefined,
            }),
            close: async () => undefined,
          }),
          close: async () => undefined,
        }),
      },
      captureDownload: async ({ workDir: dir }) => {
        const filePath = path.join(dir, "gate.wav");
        await fs.writeFile(filePath, "WAV");
        return {
          filePath,
          filename: "gate.wav",
          ext: "wav",
          title: null,
          size: 3,
        };
      },
    });

    expect(result.filename).toBe("gate.wav");
  });

  it("refuses a ToneDen follow popup on a lookalike host", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-gate-"));
    roots.push(workDir);
    let accepted = false;
    await expect(
      downloadBrowserGate({
        gateUrl: "https://www.toneden.io/mayetrix/post/track",
        email: "dj@example.com",
        name: "DJ",
        workDir,
        cookies: [
          {
            name: "oauth_token",
            value: "sc",
            domain: ".soundcloud.com",
            path: "/",
            secure: true,
            httpOnly: false,
          },
        ],
        launcher: {
          launch: async () => ({
            createBrowserContext: async () => ({
              setCookie: async () => undefined,
              waitForTarget: async () => ({
                url: () => "https://soundcloud.com.evil.test/connect",
                opener: () => "main",
                page: async () => ({
                  url: () => "https://soundcloud.com.evil.test/connect",
                  evaluate: async () => {
                    accepted = true;
                    return true;
                  },
                }),
              }),
              newPage: async () => ({
                target: () => "main",
                setDefaultTimeout: () => undefined,
                goto: async () => undefined,
                $: async () => null,
                evaluate: async () => {
                  return "STEP 1 FOLLOW ON SOUNDCLOUD";
                },
                waitForNetworkIdle: async () => undefined,
              }),
              close: async () => undefined,
            }),
            close: async () => undefined,
          }),
        },
      }),
    ).rejects.toThrow(/soundcloud\.com|Refusing/);
    expect(accepted).toBe(false);
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

describe("looksLikeContactCaptureGate", () => {
  it("detects Laylo SMS and Vault RSVP pages", () => {
    expect(
      looksLikeContactCaptureGate(
        "Get a text with the download link\nRSVP by SMS\nPut your phone number in",
      ),
    ).toBe(true);
    expect(looksLikeContactCaptureGate("Tap to RSVP")).toBe(true);
    expect(looksLikeContactCaptureGate("Follow on SoundCloud")).toBe(false);
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

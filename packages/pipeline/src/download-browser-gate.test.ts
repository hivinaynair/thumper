import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadBrowserGate } from "./download-browser-gate";

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
});

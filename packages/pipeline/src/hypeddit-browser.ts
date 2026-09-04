import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import type { BrowserCookie } from "./hypeddit";

type BrowserContextLike = {
  setCookie(...cookies: BrowserCookie[]): Promise<unknown>;
  newPage(): Promise<unknown>;
  close(): Promise<unknown>;
  waitForTarget?(
    predicate: (target: {
      url(): string;
      opener(): unknown;
      page(): Promise<unknown>;
    }) => boolean,
    options?: { timeout?: number },
  ): Promise<{ page(): Promise<unknown> }>;
};

type BrowserLike = {
  createBrowserContext(): Promise<BrowserContextLike>;
  close(): Promise<unknown>;
};

export type BrowserLauncher = {
  launch(options: {
    executablePath: string;
    headless: true;
    args: string[];
    env: Record<string, string>;
    userDataDir: string;
  }): Promise<BrowserLike>;
};

/**
 * Worker-only value import. Provider-neutral pipeline and web route imports
 * reach this module only when a Spotify gate actually needs Chromium.
 */
export async function withSecureHypedditBrowser<T>(params: {
  cookies: BrowserCookie[];
  launcher?: BrowserLauncher;
  signal?: AbortSignal;
  run: (page: unknown, context: BrowserContextLike) => Promise<T>;
}): Promise<T> {
  const profileDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "thumper-chromium-"),
  );
  await fs.chmod(profileDir, 0o700);
  const runUid = Number(process.env.PUPPETEER_RUN_UID);
  const runGid = Number(process.env.PUPPETEER_RUN_GID);
  if (
    process.getuid?.() === 0 &&
    Number.isSafeInteger(runUid) &&
    Number.isSafeInteger(runGid)
  ) {
    await fs.chown(profileDir, runUid, runGid);
  }

  const launcher = params.launcher ?? (puppeteer as unknown as BrowserLauncher);
  let browser: BrowserLike | null = null;
  let context: BrowserContextLike | null = null;
  try {
    browser = await launcher.launch({
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        "/usr/local/bin/chromium-worker",
      headless: true,
      args: ["--disable-dev-shm-usage", "--disable-gpu"],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/var/lib/chromium",
        TMPDIR: "/var/lib/chromium/tmp",
        LANG: "C.UTF-8",
        XDG_RUNTIME_DIR: "/var/lib/chromium/xdg",
      },
      userDataDir: profileDir,
    });
    context = await browser.createBrowserContext();
    // Provider sessions enter Chromium only through the browser protocol.
    await context.setCookie(...params.cookies);
    return await params.run(await context.newPage(), context);
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await fs.rm(profileDir, { recursive: true, force: true });
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserLauncher } from "./hypeddit-browser";
import type { SpotifyBrowserCookie } from "./hypeddit";
import { ProcessCancelledError } from "./process";

export type GateDownloadResult = {
  filePath: string;
  filename: string;
  ext: string;
  title: string | null;
  size: number | null;
};

type PageLike = {
  setDefaultTimeout?(ms: number): void;
  goto(url: string, options?: unknown): Promise<unknown>;
  $(selector: string): Promise<{ type(value: string): Promise<unknown> } | null>;
  evaluate(fn: (...args: never[]) => unknown): Promise<unknown>;
  waitForNetworkIdle?(options?: unknown): Promise<unknown>;
};

const DOWNLOAD_LABEL =
  /^(download|download track|get track|free download|unlock|claim|get free download)$/i;

export async function clickDownloadControl(page: PageLike): Promise<boolean> {
  return Boolean(
    await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll("a, button, input[type=submit], [role=button]"),
      );
      const match = nodes.find((el) => {
        const text = (
          el.getAttribute("value") ||
          el.getAttribute("aria-label") ||
          el.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        return /download|get track|free download|unlock|claim/i.test(text);
      });
      if (!match) return false;
      (match as HTMLElement).click();
      return true;
    }),
  );
}

async function fillEmailIfPresent(
  page: PageLike,
  email: string,
  name: string,
): Promise<void> {
  const selectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[id*="email" i]',
    'input[placeholder*="email" i]',
  ];
  for (const selector of selectors) {
    const input = await page.$(selector);
    if (!input) continue;
    await input.type(email);
    const nameInput = await page.$(
      'input[name="name"], input[id*="name" i], input[placeholder*="name" i]',
    );
    if (nameInput) await nameInput.type(name);
    return;
  }
}

export async function waitForDownloadedFile(
  directory: string,
  timeoutMs = 45_000,
  signal?: AbortSignal,
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new ProcessCancelledError();
    const names = await fs.readdir(directory).catch(() => []);
    const ready = names.find(
      (name) =>
        !name.endsWith(".crdownload") &&
        !name.endsWith(".tmp") &&
        name !== "." &&
        name !== "..",
    );
    if (ready) return path.join(directory, ready);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the gate to download a file");
}

export async function downloadBrowserGate(params: {
  gateUrl: string;
  email: string;
  name: string;
  workDir: string;
  cookies: SpotifyBrowserCookie[];
  signal?: AbortSignal;
  launcher?: BrowserLauncher;
  captureDownload?: (args: {
    workDir: string;
    signal?: AbortSignal;
  }) => Promise<GateDownloadResult>;
}): Promise<GateDownloadResult> {
  if (params.signal?.aborted) throw new ProcessCancelledError();
  const downloadDir = path.join(params.workDir, `gate_${randomUUID()}`);
  await fs.mkdir(downloadDir, { recursive: true });

  const runCapture =
    params.captureDownload ??
    (async () => {
      const filePath = await waitForDownloadedFile(
        downloadDir,
        45_000,
        params.signal,
      );
      const filename = path.basename(filePath);
      const ext = path.extname(filename).replace(/^\./, "").toLowerCase() || "bin";
      const stat = await fs.stat(filePath);
      return {
        filePath,
        filename,
        ext,
        title: path.parse(filename).name || null,
        size: stat.size,
      };
    });

  if (params.launcher) {
    const browser = await params.launcher.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/local/bin/chromium-worker",
      headless: true,
      args: ["--disable-dev-shm-usage", "--disable-gpu"],
      env: {},
      userDataDir: downloadDir,
    });
    const context = await browser.createBrowserContext();
    try {
      if (params.cookies.length > 0) {
        await context.setCookie(...params.cookies);
      }
      const page = (await context.newPage()) as PageLike;
      page.setDefaultTimeout?.(45_000);
      await page.goto(params.gateUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.waitForNetworkIdle?.({ idleTime: 500, timeout: 8_000 }).catch(
        () => undefined,
      );
      await fillEmailIfPresent(page, params.email, params.name);
      const clicked = await clickDownloadControl(page);
      if (!clicked && !params.captureDownload) {
        throw new Error("Download control not found on gate page");
      }
      return await runCapture({ workDir: downloadDir, signal: params.signal });
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  const { withSecureHypedditBrowser } = await import("./hypeddit-browser");
  return withSecureHypedditBrowser({
    cookies: params.cookies,
    signal: params.signal,
    run: async (rawPage) => {
      const page = rawPage as PageLike & {
        createCDPSession?: () => Promise<{
          send(method: string, params?: object): Promise<unknown>;
        }>;
      };
      page.setDefaultTimeout?.(45_000);
      const session = await page.createCDPSession?.();
      await session?.send("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: downloadDir,
      });
      await page.goto(params.gateUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.waitForNetworkIdle?.({ idleTime: 800, timeout: 10_000 }).catch(
        () => undefined,
      );
      await fillEmailIfPresent(page, params.email, params.name);
      const clicked = await clickDownloadControl(page);
      if (!clicked) {
        throw new Error("Download control not found on gate page");
      }
      return runCapture({ workDir: downloadDir, signal: params.signal });
    },
  });
}

export { DOWNLOAD_LABEL };

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserLauncher } from "./hypeddit-browser";
import type { BrowserCookie } from "./hypeddit";
import { ProcessCancelledError } from "./process";
import { ManualDownloadRequiredError } from "./soundcloud-purchase";

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
  createCDPSession?: () => Promise<{
    send(method: string, params?: object): Promise<unknown>;
  }>;
};

export function looksLikeSocialFollowWall(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  return (
    /follow on soundcloud/.test(normalized) ||
    /follow on spotify/.test(normalized) ||
    /follow on instagram/.test(normalized) ||
    /follow on youtube/.test(normalized) ||
    /follow to (unlock|download)/.test(normalized) ||
    /connect with soundcloud/.test(normalized) ||
    /become a superfan/.test(normalized) ||
    /unlock progress/.test(normalized)
  );
}

async function rejectSocialFollowWall(
  page: PageLike,
  gateUrl: string,
): Promise<void> {
  const wallText = String(
    await page.evaluate(() => document.body?.innerText ?? ""),
  );
  if (looksLikeSocialFollowWall(wallText)) {
    throw new ManualDownloadRequiredError(gateUrl, "Follow/unlock required");
  }
}

const GATE_DOWNLOAD_EXT =
  /\.(wav|wave|flac|aiff|aif|mp3|m4a|aac|ogg|opus|zip|7z)$/i;

export function isCapturedGateFilename(name: string): boolean {
  if (!name || name.startsWith(".")) return false;
  if (
    name.endsWith(".crdownload") ||
    name.endsWith(".tmp") ||
    name.endsWith(".part")
  ) {
    return false;
  }
  return GATE_DOWNLOAD_EXT.test(name);
}

const DOWNLOAD_LABEL =
  /^(download|download track|get track|free download|unlock|claim|get free download)$/i;

export async function clickDownloadControl(page: PageLike): Promise<boolean> {
  return Boolean(
    await page.evaluate(() => {
      const byId = document.querySelector<HTMLElement>(
        "#downloadProcess, #gateDownloadButton, [data-testid='download']",
      );
      const nodes = [
        ...(byId ? [byId] : []),
        ...Array.from(
          document.querySelectorAll(
            "a, button, input[type=submit], [role=button]",
          ),
        ),
      ];
      const match = nodes.find((el) => {
        const text = (
          el.getAttribute("value") ||
          el.getAttribute("aria-label") ||
          el.getAttribute("alt") ||
          el.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        return /download|get track|free download|unlock|claim|rsvp|continue/i.test(
          text,
        );
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
    const ready = names.find((name) => isCapturedGateFilename(name));
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
  cookies: BrowserCookie[];
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
    const profileDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "thumper-chromium-"),
    );
    await fs.chmod(profileDir, 0o700);
    const browser = await params.launcher.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/local/bin/chromium-worker",
      headless: true,
      args: ["--disable-dev-shm-usage", "--disable-gpu"],
      env: {},
      userDataDir: profileDir,
    });
    const context = await browser.createBrowserContext();
    try {
      if (params.cookies.length > 0) {
        await context.setCookie(...params.cookies);
      }
      const page = (await context.newPage()) as PageLike;
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
      await page.waitForNetworkIdle?.({ idleTime: 500, timeout: 8_000 }).catch(
        () => undefined,
      );
      await unlockRenderedGatePage(page, {
        gateUrl: params.gateUrl,
        email: params.email,
        name: params.name,
        requireClick: !params.captureDownload,
      });
      return await runCapture({ workDir: downloadDir, signal: params.signal });
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      await fs.rm(profileDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
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
      await unlockRenderedGatePage(page, {
        gateUrl: params.gateUrl,
        email: params.email,
        name: params.name,
        requireClick: true,
      });
      return runCapture({ workDir: downloadDir, signal: params.signal });
    },
  });
}

async function unlockRenderedGatePage(
  page: PageLike,
  params: {
    gateUrl: string;
    email: string;
    name: string;
    requireClick: boolean;
  },
): Promise<void> {
  await fillEmailIfPresent(page, params.email, params.name);
  await rejectSocialFollowWall(page, params.gateUrl);
  let clicked = await clickDownloadControl(page);
  if (!clicked) {
    await page.waitForNetworkIdle?.({ idleTime: 800, timeout: 8_000 }).catch(
      () => undefined,
    );
    await fillEmailIfPresent(page, params.email, params.name);
    clicked = await clickDownloadControl(page);
  }
  if (!clicked && params.requireClick) {
    throw new Error("Download control not found on gate page");
  }
  if (clicked) await rejectSocialFollowWall(page, params.gateUrl);
}

export function layloDropJsonUrl(gateUrl: string): string | null {
  try {
    const parsed = new URL(gateUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "laylo.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return `https://d21i0hc4hl3bvt.cloudfront.net/${parts[0]}/${parts[1]}.json`;
  } catch {
    return null;
  }
}

export type LayloDrop = {
  title: string | null;
  link: string | null;
  emailRequired: boolean;
};

export async function fetchLayloDrop(
  gateUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LayloDrop | null> {
  const jsonUrl = layloDropJsonUrl(gateUrl);
  if (!jsonUrl) return null;
  const response = await fetchImpl(jsonUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as {
    title?: string;
    link?: string | null;
    rsvpOptions?: { email?: number };
  };
  return {
    title: data.title ?? null,
    link: data.link ?? null,
    emailRequired: (data.rsvpOptions?.email ?? 0) > 0,
  };
}

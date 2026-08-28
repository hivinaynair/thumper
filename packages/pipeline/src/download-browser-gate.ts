import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserLauncher } from "./hypeddit-browser";
import {
  isSafeInstagramUrl,
  isSafeSoundCloudConnectUrl,
  isSafeSoundCloudUrl,
  isSafeSpotifyAuthorizationUrl,
  type BrowserCookie,
} from "./hypeddit";
import { ProcessCancelledError } from "./process";
import { ManualDownloadRequiredError } from "./soundcloud-purchase";

export type GateDownloadResult = {
  filePath: string;
  filename: string;
  ext: string;
  title: string | null;
  size: number | null;
};

type PopupTarget = {
  url(): string;
  opener(): unknown;
  page(): Promise<unknown>;
};

type GateContext = {
  setCookie(...cookies: BrowserCookie[]): Promise<unknown>;
  newPage(): Promise<unknown>;
  close(): Promise<unknown>;
  waitForTarget?(
    predicate: (target: PopupTarget) => boolean,
    options?: { timeout?: number },
  ): Promise<{ page(): Promise<unknown> }>;
};

type PageLike = {
  setDefaultTimeout?(ms: number): void;
  goto(url: string, options?: unknown): Promise<unknown>;
  $(selector: string): Promise<{ type(value: string): Promise<unknown> } | null>;
  evaluate(fn: (...args: never[]) => unknown): Promise<unknown>;
  waitForNetworkIdle?(options?: unknown): Promise<unknown>;
  target?(): unknown;
  url?(): string;
  createCDPSession?: () => Promise<{
    send(method: string, params?: object): Promise<unknown>;
  }>;
};

type PopupPage = {
  url(): string;
  evaluate(fn: (...args: never[]) => unknown): Promise<unknown>;
};

const POPUP_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_POPUPS = 4;

export function looksLikeSocialFollowWall(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  return (
    /follow on soundcloud/.test(normalized) ||
    /follow on spotify/.test(normalized) ||
    /follow on instagram/.test(normalized) ||
    /follow on youtube/.test(normalized)
  );
}

export function looksLikeContactCaptureGate(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  return (
    /tap to rsvp/.test(normalized) ||
    /rsvp by sms/.test(normalized) ||
    /get a text with the download/.test(normalized) ||
    /put your phone number/.test(normalized)
  );
}

const AUTHORIZATION_ACCEPT_LABELS = [
  "agree",
  "accept",
  "continue",
  "connect",
  "authorize",
  "allow",
  "follow",
  "follow back",
] as const;

const AUTHORIZATION_DONE_LABELS = [
  "following",
  "unfollow",
  "requested",
] as const;

export function providerAuthorizationControlKind(
  text: string,
): "accept" | "done" | null {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return null;
  if (
    AUTHORIZATION_DONE_LABELS.some(
      (label) => normalized === label || normalized.startsWith(`${label} `),
    )
  ) {
    return "done";
  }
  if (
    AUTHORIZATION_ACCEPT_LABELS.some(
      (label) => normalized === label || normalized.startsWith(`${label} `),
    )
  ) {
    return "accept";
  }
  return null;
}

async function readWallText(page: PageLike): Promise<string> {
  return String(await page.evaluate(() => document.body?.innerText ?? ""));
}

export async function clickFollowUnlockControls(page: PageLike): Promise<number> {
  return Number(
    await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll("a, button, input[type=submit], [role=button]"),
      );
      let clicked = 0;
      for (const el of nodes) {
        const text = (
          el.getAttribute("value") ||
          el.getAttribute("aria-label") ||
          el.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        if (
          !/follow on (soundcloud|spotify|instagram|youtube)/i.test(text) &&
          !/connect with (soundcloud|spotify|instagram|youtube)/i.test(text)
        ) {
          continue;
        }
        (el as HTMLElement).click();
        clicked += 1;
      }
      return clicked;
    }),
  );
}

function isSettledPopupUrl(url: string): boolean {
  return Boolean(url) && !url.startsWith("about:");
}

function isSafeProviderAuthorizationUrl(url: string): boolean {
  return (
    isSafeSpotifyAuthorizationUrl(url) ||
    isSafeSoundCloudUrl(url) ||
    isSafeInstagramUrl(url)
  );
}

function providerLoginRefreshMessage(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const isLogin = path.includes("/login") || path.includes("/signin");
    if (!isLogin) return null;
    if (host === "accounts.spotify.com" || host.endsWith(".spotify.com")) {
      return "Spotify session is no longer usable — refresh Spotify cookies and retry.";
    }
    if (host === "soundcloud.com" || host.endsWith(".soundcloud.com")) {
      return "SoundCloud session is no longer usable — refresh SoundCloud cookies and retry.";
    }
    if (host === "instagram.com" || host.endsWith(".instagram.com")) {
      return "Instagram session is no longer usable — refresh Instagram cookies and retry.";
    }
  } catch {
    return null;
  }
  return null;
}

async function clickAuthorizationControl(page: PopupPage): Promise<boolean> {
  return Boolean(
    await page.evaluate(
      ({ acceptLabels, doneLabels }) => {
        const testId = document.querySelector<HTMLElement>(
          '[data-testid="auth-accept"]',
        );
        if (testId) {
          testId.click();
          return true;
        }
        const kindOf = (raw: string): "accept" | "done" | null => {
          const text = raw.replace(/\s+/g, " ").trim().toLowerCase();
          if (!text) return null;
          if (
            doneLabels.some(
              (label) => text === label || text.startsWith(`${label} `),
            )
          ) {
            return "done";
          }
          if (
            acceptLabels.some(
              (label) => text === label || text.startsWith(`${label} `),
            )
          ) {
            return "accept";
          }
          return null;
        };
        const nodes = Array.from(
          document.querySelectorAll(
            "a, button, input[type=submit], [role=button]",
          ),
        );
        const texts = nodes.map((el) =>
          (
            el.getAttribute("value") ||
            el.getAttribute("aria-label") ||
            el.textContent ||
            ""
          ).replace(/\s+/g, " ").trim(),
        );
        if (texts.some((text) => kindOf(text) === "done")) return true;
        const index = texts.findIndex((text) => kindOf(text) === "accept");
        if (index < 0) return false;
        (nodes[index] as HTMLElement).click();
        return true;
      },
      {
        acceptLabels: [...AUTHORIZATION_ACCEPT_LABELS],
        doneLabels: [...AUTHORIZATION_DONE_LABELS],
      },
    ),
  );
}

async function acceptProviderAuthorizationPage(page: PopupPage): Promise<void> {
  const url = page.url();
  const loginMessage = providerLoginRefreshMessage(url);
  if (loginMessage) throw new Error(loginMessage);
  if (!isSafeProviderAuthorizationUrl(url)) {
    throw new Error(
      `Refusing follow authorization outside SoundCloud, Spotify, or Instagram (${url})`,
    );
  }
  const accepted = await clickAuthorizationControl(page);
  if (accepted) return;
  // SoundCloud paused forced follow APIs: profile popups have no Connect
  // button, and the gate is supposed to continue without one.
  if (isSafeSoundCloudUrl(url) && !isSafeSoundCloudConnectUrl(url)) return;
  throw new Error("Provider authorization changed: accept control missing");
}

async function acceptProviderPopups(
  context: GateContext,
  page: PageLike,
): Promise<void> {
  if (!context.waitForTarget || !page.target) return;
  const opener = page.target();
  for (let i = 0; i < MAX_PROVIDER_POPUPS; i += 1) {
    let target: { page(): Promise<unknown> };
    try {
      target = await context.waitForTarget(
        (candidate) =>
          candidate.opener() === opener && isSettledPopupUrl(candidate.url()),
        { timeout: POPUP_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") return;
      throw error;
    }
    const popup = (await target.page()) as PopupPage | null;
    if (!popup || typeof popup.url !== "function") return;
    await acceptProviderAuthorizationPage(popup);
  }
}

async function unlockFollowWallIfPresent(
  page: PageLike,
  gateUrl: string,
  hasSessionCookies: boolean,
  context: GateContext,
): Promise<void> {
  const wallText = await readWallText(page);
  if (!looksLikeSocialFollowWall(wallText)) return;
  if (!hasSessionCookies) {
    throw new ManualDownloadRequiredError(gateUrl, "Follow/unlock required");
  }
  await clickFollowUnlockControls(page);
  await acceptProviderPopups(context, page);
}

async function rejectIfContactCaptureGate(page: PageLike): Promise<void> {
  const wallText = await readWallText(page);
  if (looksLikeContactCaptureGate(wallText)) {
    throw new Error(
      "No free download on this track — this gate only collects a phone number or RSVP, not a file.",
    );
  }
}

async function rejectIfStillFollowWall(
  page: PageLike,
  gateUrl: string,
): Promise<void> {
  const wallText = await readWallText(page);
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
    const context = (await browser.createBrowserContext()) as GateContext;
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
      await fillEmailIfPresent(page, params.email, params.name);
      await rejectIfContactCaptureGate(page);
      await unlockFollowWallIfPresent(
        page,
        params.gateUrl,
        params.cookies.length > 0,
        context,
      );
      await page.waitForNetworkIdle?.({ idleTime: 500, timeout: 8_000 }).catch(
        () => undefined,
      );
      const clicked = await clickDownloadControl(page);
      if (!clicked && !params.captureDownload) {
        await rejectIfContactCaptureGate(page);
        throw new Error("Download control not found on gate page");
      }
      if (clicked) await rejectIfStillFollowWall(page, params.gateUrl);
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
    run: async (rawPage, rawContext) => {
      const page = rawPage as PageLike & {
        createCDPSession?: () => Promise<{
          send(method: string, params?: object): Promise<unknown>;
        }>;
      };
      const context = rawContext as GateContext;
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
      await rejectIfContactCaptureGate(page);
      await unlockFollowWallIfPresent(
        page,
        params.gateUrl,
        params.cookies.length > 0,
        context,
      );
      await page.waitForNetworkIdle?.({ idleTime: 800, timeout: 10_000 }).catch(
        () => undefined,
      );
      const clicked = await clickDownloadControl(page);
      if (!clicked) {
        await rejectIfContactCaptureGate(page);
        throw new Error("Download control not found on gate page");
      }
      await rejectIfStillFollowWall(page, params.gateUrl);
      return runCapture({ workDir: downloadDir, signal: params.signal });
    },
  });
}

export { DOWNLOAD_LABEL };

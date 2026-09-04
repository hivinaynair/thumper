import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserLauncher } from "./hypeddit-browser";
import {
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
  evaluate(fn: (...args: never[]) => unknown, arg?: unknown): Promise<unknown>;
  waitForNetworkIdle?(options?: unknown): Promise<unknown>;
  waitForResponse?(
    predicate: (response: { url(): string; headers(): Record<string, string> }) => boolean,
    options?: { timeout?: number },
  ): Promise<{
    url(): string;
    headers(): Record<string, string>;
    buffer(): Promise<Buffer | Uint8Array>;
    json(): Promise<unknown>;
  }>;
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
    /follow on youtube/.test(normalized) ||
    /follow to (unlock|download)/.test(normalized) ||
    /connect with soundcloud/.test(normalized) ||
    /become a superfan/.test(normalized) ||
    /unlock progress/.test(normalized)
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
          !/follow on (soundcloud|spotify|youtube)/i.test(text) &&
          !/connect with (soundcloud|spotify|youtube)/i.test(text) &&
          !/^connect (soundcloud|spotify|youtube)$/i.test(text)
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
    isSafeSoundCloudUrl(url)
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
      `Refusing follow authorization outside SoundCloud or Spotify (${url})`,
    );
  }
  const accepted = await clickAuthorizationControl(page);
  if (accepted) return;
  // Opening the provider tab is enough; do not require like/follow/OAuth.
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
  _gateUrl: string,
  _hasSessionCookies: boolean,
  context: GateContext,
): Promise<void> {
  const wallText = await readWallText(page);
  if (!looksLikeSocialFollowWall(wallText)) return;
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

export function matchesDownloadLabel(text: string): boolean {
  return DOWNLOAD_LABEL.test(text.replace(/\s+/g, " ").trim());
}

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
        return /download|get track|free download|unlock|claim|continue/i.test(
          text,
        );
      });
      if (!match) return false;
      (match as HTMLElement).click();
      return true;
    }),
  );
}

async function dismissCookieBanner(page: PageLike): Promise<void> {
  await page.evaluate(() => {
    const labels =
      /^(accept all|reject non-essential|reject|accept|allow all|got it)$/i;
    const nodes = Array.from(
      document.querySelectorAll("a, button, [role=button]"),
    );
    const match = nodes.find((el) =>
      labels.test(
        (el.getAttribute("value") || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim(),
      ),
    );
    if (match) (match as HTMLElement).click();
  });
}

async function fillCommentIfPresent(page: PageLike): Promise<void> {
  const selectors = [
    'textarea[placeholder*="comment" i]',
    "textarea",
    'input[placeholder*="comment" i]',
  ];
  for (const selector of selectors) {
    const input = await page.$(selector);
    if (!input) continue;
    await input.type("nice one");
    return;
  }
}

async function unlockAndClickDownload(
  page: PageLike,
  gateUrl: string,
  cookiesPresent: boolean,
  context: GateContext,
): Promise<boolean> {
  await dismissCookieBanner(page);
  await fillCommentIfPresent(page);
  await rejectIfContactCaptureGate(page);
  await unlockFollowWallIfPresent(page, gateUrl, cookiesPresent, context);
  let clicked = await clickDownloadControl(page);
  if (looksLikeSocialFollowWall(await readWallText(page))) {
    await fillCommentIfPresent(page);
    const opened = Number(await clickFollowUnlockControls(page));
    await acceptProviderPopups(context, page);
    clicked = (await clickDownloadControl(page)) || clicked;
    if (!Number.isFinite(opened) || opened === 0) {
      throw new ManualDownloadRequiredError(gateUrl, "Follow/unlock required");
    }
  }
  return clicked;
}

function responseLooksLikeGateFile(response: {
  url(): string;
  headers(): Record<string, string>;
}): boolean {
  const headers = response.headers();
  const disposition = headers["content-disposition"] ?? "";
  const contentType = headers["content-type"] ?? "";
  return (
    /attachment/i.test(disposition) ||
    /^audio\//i.test(contentType) ||
    /application\/(zip|x-zip|octet-stream)/i.test(contentType)
  );
}

async function captureGateFile(
  page: PageLike,
  downloadDir: string,
  signal?: AbortSignal,
): Promise<GateDownloadResult> {
  const fromDisk = waitForDownloadedFile(downloadDir, 45_000, signal).then(
    async (filePath) => {
      const filename = path.basename(filePath);
      const ext =
        path.extname(filename).replace(/^\./, "").toLowerCase() || "bin";
      const stat = await fs.stat(filePath);
      return {
        filePath,
        filename,
        ext,
        title: path.parse(filename).name || null,
        size: stat.size,
      };
    },
  );
  if (!page.waitForResponse) return fromDisk;
  const fromNetwork = page
    .waitForResponse(responseLooksLikeGateFile, { timeout: 45_000 })
    .then(async (response) => {
      const bytes = Buffer.from(await response.buffer());
      const headers = response.headers();
      const filename =
        /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(
          headers["content-disposition"] ?? "",
        )?.[1] ?? "gate-download.bin";
      const ext =
        path.extname(filename).replace(/^\./, "").toLowerCase() || "bin";
      const filePath = path.join(downloadDir, filename);
      await fs.writeFile(filePath, bytes);
      return {
        filePath,
        filename,
        ext,
        title: path.parse(filename).name || null,
        size: bytes.byteLength,
      };
    })
    .catch(() => new Promise<GateDownloadResult>(() => undefined));
  return Promise.race([fromDisk, fromNetwork]);
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
      const clicked = await unlockAndClickDownload(
        page,
        params.gateUrl,
        params.cookies.length > 0,
        context,
      );
      if (!clicked && !params.captureDownload) {
        await rejectIfContactCaptureGate(page);
        throw new Error("Download control not found on gate page");
      }
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
      const clicked = await unlockAndClickDownload(
        page,
        params.gateUrl,
        params.cookies.length > 0,
        context,
      );
      if (!clicked) {
        await rejectIfContactCaptureGate(page);
        throw new Error("Download control not found on gate page");
      }
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

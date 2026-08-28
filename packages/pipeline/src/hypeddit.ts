/// <reference lib="dom" />

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserContext, HTTPResponse, Page } from "puppeteer-core";
import { materializeCookieFile } from "./cookies";
import { ProcessCancelledError } from "./process";

const HYPEDDIT_ORIGIN = "https://hypeddit.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export type HypedditDownloadResult = {
  filePath: string;
  ext: string;
  filename: string;
  title: string | null;
  size: number | null;
};

export class BrowserRequiredError extends Error {
  readonly steps: string[];

  constructor(steps: string[]) {
    super(`Hypeddit gate requires a browser for: ${steps.join(", ")}`);
    this.name = "BrowserRequiredError";
    this.steps = steps;
  }
}

export type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
};

export type SpotifyBrowserCookie = BrowserCookie;

function parseNetscapeCookiesForHost(
  text: string,
  isAllowedHost: (hostname: string) => boolean,
  nowSeconds: number,
): BrowserCookie[] {
  const cookies: BrowserCookie[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const httpOnly = rawLine.startsWith("#HttpOnly_");
    if ((!httpOnly && rawLine.startsWith("#")) || !rawLine.trim()) continue;
    const line = httpOnly ? rawLine.slice("#HttpOnly_".length) : rawLine;
    const fields = line.split("\t");
    if (fields.length < 7) continue;
    const [
      domainRaw,
      ,
      cookiePath,
      secureRaw,
      expiresRaw,
      name,
      ...valueParts
    ] = fields;
    if (!domainRaw || !cookiePath || !name) continue;
    const hostname = domainRaw.replace(/^\./, "").toLowerCase();
    if (!isAllowedHost(hostname)) continue;
    const expires = Number(expiresRaw);
    if (Number.isFinite(expires) && expires > 0 && expires <= nowSeconds) {
      continue;
    }
    cookies.push({
      name,
      value: valueParts.join("\t"),
      domain: domainRaw,
      path: cookiePath,
      secure: secureRaw === "TRUE",
      httpOnly,
      ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
    });
  }
  return cookies;
}

function isSpotifyCookieHost(hostname: string): boolean {
  return hostname === "spotify.com" || hostname.endsWith(".spotify.com");
}

function isInstagramCookieHost(hostname: string): boolean {
  return hostname === "instagram.com" || hostname.endsWith(".instagram.com");
}

function isSoundCloudCookieHost(hostname: string): boolean {
  return hostname === "soundcloud.com" || hostname.endsWith(".soundcloud.com");
}

export function parseSoundCloudNetscapeCookies(
  text: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): BrowserCookie[] {
  return parseNetscapeCookiesForHost(text, isSoundCloudCookieHost, nowSeconds);
}

export function parseSpotifyNetscapeCookies(
  text: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): BrowserCookie[] {
  return parseNetscapeCookiesForHost(text, isSpotifyCookieHost, nowSeconds);
}

export function parseInstagramNetscapeCookies(
  text: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): BrowserCookie[] {
  return parseNetscapeCookiesForHost(text, isInstagramCookieHost, nowSeconds);
}

export function isSafeSpotifyAuthorizationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase() === "accounts.spotify.com"
    );
  } catch {
    return false;
  }
}

export function isSafeInstagramUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === "https:" &&
      (hostname === "instagram.com" || hostname.endsWith(".instagram.com"))
    );
  } catch {
    return false;
  }
}

export function isSafeSoundCloudUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === "https:" &&
      (hostname === "soundcloud.com" || hostname.endsWith(".soundcloud.com"))
    );
  } catch {
    return false;
  }
}

export function isSafeSoundCloudConnectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return (
      isSafeSoundCloudUrl(url) &&
      (path.includes("/connect") || path.includes("/oauth"))
    );
  } catch {
    return false;
  }
}

const GATE_CONTROL_ALLOWED_ROOTS = [
  "hypeddit.com",
  "spotify.com",
  "instagram.com",
  "soundcloud.com",
] as const;

export function isAllowedGateControlUrl(
  href: string,
  currentUrl: string,
): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(href, currentUrl);
    const protocol = target.protocol.toLowerCase();
    if (protocol === "javascript:") return true;
    if (protocol !== "https:" && protocol !== "http:") return false;
    const host = target.hostname.toLowerCase();
    if (host === current.hostname.toLowerCase()) return true;
    return GATE_CONTROL_ALLOWED_ROOTS.some(
      (root) => host === root || host.endsWith(`.${root}`),
    );
  } catch {
    return false;
  }
}

type ProviderAuthorizationPage = {
  url(): string;
};

type SpotifyAuthorizationPage = ProviderAuthorizationPage;

async function authorizeProviderAndConfirmHypedditAction(params: {
  signal?: AbortSignal;
  isSafeAuthorizationUrl: (url: string) => boolean;
  unsafeHostMessage: string;
  clickConnect: () => Promise<unknown>;
  waitForPopup: () => Promise<ProviderAuthorizationPage | null>;
  acceptAuthorization: (page: ProviderAuthorizationPage) => Promise<unknown>;
  waitForHypedditActionConfirmation: () => Promise<unknown>;
}): Promise<void> {
  const ensureActive = () => {
    if (params.signal?.aborted) throw new ProcessCancelledError();
  };

  ensureActive();
  await params.clickConnect();
  ensureActive();
  const popup = await params.waitForPopup();
  ensureActive();
  if (popup) {
    if (!params.isSafeAuthorizationUrl(popup.url())) {
      throw new Error(params.unsafeHostMessage);
    }
    await params.acceptAuthorization(popup);
    ensureActive();
  }
  await params.waitForHypedditActionConfirmation();
  ensureActive();
}

/**
 * Spotify only authorizes Hypeddit. Hypeddit's OAuth callback performs the
 * gate's configured follow/save action, so popup acceptance alone is never
 * success: the caller must positively confirm that Hypeddit advanced the gate.
 */
export async function authorizeSpotifyAndConfirmHypedditAction(params: {
  signal?: AbortSignal;
  clickConnect: () => Promise<unknown>;
  waitForPopup: () => Promise<SpotifyAuthorizationPage | null>;
  acceptAuthorization: (page: SpotifyAuthorizationPage) => Promise<unknown>;
  waitForHypedditActionConfirmation: () => Promise<unknown>;
}): Promise<void> {
  await authorizeProviderAndConfirmHypedditAction({
    ...params,
    isSafeAuthorizationUrl: isSafeSpotifyAuthorizationUrl,
    unsafeHostMessage:
      "Refusing Spotify authorization outside accounts.spotify.com",
  });
}

/**
 * Instagram only authorizes or follows from instagram.com. Popup follow/OAuth
 * acceptance alone is never success: Hypeddit must drop `ig` from pending steps.
 */
export async function authorizeInstagramAndConfirmHypedditAction(params: {
  signal?: AbortSignal;
  clickConnect: () => Promise<unknown>;
  waitForPopup: () => Promise<ProviderAuthorizationPage | null>;
  acceptAuthorization: (page: ProviderAuthorizationPage) => Promise<unknown>;
  waitForHypedditActionConfirmation: () => Promise<unknown>;
}): Promise<void> {
  await authorizeProviderAndConfirmHypedditAction({
    ...params,
    isSafeAuthorizationUrl: isSafeInstagramUrl,
    unsafeHostMessage: "Refusing Instagram action outside instagram.com",
  });
}

type GateData = {
  csrfToken: string;
  externalId: string;
  gvt: string;
  uid: string;
  steps: string[];
  wrndk: string;
  fanGateId: string;
  isSkippable: string;
  duration: number;
};

function matchHiddenInput(html: string, id: string): string | null {
  const patterns = [
    new RegExp(`(?:id|name)=["']${id}["'][^>]*?value=["']([^"']*)["']`),
    new RegExp(`value=["']([^"']*)["'][^>]*?(?:id|name)=["']${id}["']`),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

function parseGateData(html: string): GateData | null {
  const csrfToken = html.match(
    /name=["']csrf-token["'][^>]*content=["']([^"']+)["']/,
  )?.[1];
  const gvt = matchHiddenInput(html, "gvt");
  const uid = matchHiddenInput(html, "current_download_file_listner");
  const rawSteps = matchHiddenInput(html, "nwSteps");
  const wrndk = matchHiddenInput(html, "wrndk");
  const fanGateId =
    html.match(/fan_gate_id["']\s+value=['"](\d+)['"]/)?.[1] ??
    matchHiddenInput(html, "fan_gate_id");
  const externalId =
    matchHiddenInput(html, "external_id") ??
    matchHiddenInput(html, "externID") ??
    html.match(/\b(?:externID|external_id)\s*[:=]\s*["']([^"']+)["']/)?.[1] ??
    "";

  if (!csrfToken || !gvt || !uid || !rawSteps || !wrndk || !fanGateId) {
    return null;
  }

  const durationRaw = Number(matchHiddenInput(html, "duration"));
  const duration =
    Number.isFinite(durationRaw) && durationRaw > 0
      ? durationRaw
      : 3 * 60 * 1000;

  return {
    csrfToken,
    externalId,
    gvt,
    uid,
    steps: rawSteps.split(",").filter(Boolean),
    wrndk,
    fanGateId,
    isSkippable: matchHiddenInput(html, "is_skippable") ?? "0",
    duration,
  };
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const star = value.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1];
  if (star) return decodeURIComponent(star.replace(/["']/g, ""));
  const plain = value.match(/filename=["']?([^"';]+)["']?/i)?.[1];
  return plain ? plain.trim() : null;
}

function extFromNameOrType(name: string, mime: string | null): string {
  const fromName = name.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  if (mime?.includes("wav")) return "wav";
  if (mime?.includes("mpeg") || mime?.includes("mp3")) return "mp3";
  if (mime?.includes("flac")) return "flac";
  if (mime?.includes("aiff") || mime?.includes("aif")) return "aiff";
  return "bin";
}

/**
 * Prefer real container over Hypeddit's claimed `ext` (gates ship WAV or MP3).
 * Wrong `.wav` labels would make isLosslessSource skip peak-normalize.
 */
export function sniffAudioExt(bytes: Uint8Array): string | null {
  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];
  if (b0 === undefined || b1 === undefined || b2 === undefined) return null;
  // ID3… or MPEG frame sync (common for Hypeddit MP3 masters)
  if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) return "mp3";
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return "mp3";
  if (bytes.length < 12) return null;
  const b3 = bytes[3];
  const b8 = bytes[8];
  const b9 = bytes[9];
  const b10 = bytes[10];
  const b11 = bytes[11];
  if (
    b3 === undefined ||
    b8 === undefined ||
    b9 === undefined ||
    b10 === undefined ||
    b11 === undefined
  ) {
    return null;
  }
  // RIFF....WAVE
  if (
    b0 === 0x52 &&
    b1 === 0x49 &&
    b2 === 0x46 &&
    b3 === 0x46 &&
    b8 === 0x57 &&
    b9 === 0x41 &&
    b10 === 0x56 &&
    b11 === 0x45
  ) {
    return "wav";
  }
  // FORM....AIFF / AIFC
  if (
    b0 === 0x46 &&
    b1 === 0x4f &&
    b2 === 0x52 &&
    b3 === 0x4d &&
    b8 === 0x41 &&
    b9 === 0x49 &&
    b10 === 0x46 &&
    (b11 === 0x46 || b11 === 0x43)
  ) {
    return "aiff";
  }
  // fLaC
  if (b0 === 0x66 && b1 === 0x4c && b2 === 0x61 && b3 === 0x43) {
    return "flac";
  }
  return null;
}

class CookieJar {
  private cookies = new Map<string, string>();

  storeFromResponse(response: Response) {
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const entry of setCookie) {
      const pair = entry.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) {
        this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }

  header(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  xsrf(): string {
    const raw = this.cookies.get("XSRF-TOKEN");
    if (!raw) return "";
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
}

/**
 * Browserless Hypeddit unlock for email + client-side social steps.
 * Signals before submission when Spotify, Instagram, or an unknown step needs
 * a browser.
 */
export async function downloadHypedditGate(params: {
  gateUrl: string;
  email: string;
  name: string;
  workDir: string;
  signal?: AbortSignal;
}): Promise<HypedditDownloadResult> {
  const { gateUrl, email, name, workDir, signal } = params;
  if (!email.trim()) {
    throw new Error(
      "Hypeddit gate needs your account email (Clerk primary email)",
    );
  }
  if (signal?.aborted) throw new ProcessCancelledError();

  const jar = new CookieJar();
  let csrfToken = "";

  async function get(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Cookie: jar.header(),
      },
      redirect: "follow",
      signal,
    });
    jar.storeFromResponse(response);
    if (!response.ok) {
      throw new Error(`Hypeddit page failed (${response.status})`);
    }
    return response.text();
  }

  async function post(
    pathName: string,
    body: URLSearchParams,
    referer: string,
  ): Promise<Response> {
    const response = await fetch(`${HYPEDDIT_ORIGIN}${pathName}`, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-TOKEN": csrfToken,
        "X-XSRF-TOKEN": jar.xsrf(),
        Origin: HYPEDDIT_ORIGIN,
        Referer: referer,
        Cookie: jar.header(),
      },
      body,
      signal,
    });
    jar.storeFromResponse(response);
    return response;
  }

  const html = await get(gateUrl);
  const gate = parseGateData(html);
  if (!gate) {
    throw new Error("Could not parse Hypeddit gate page");
  }
  csrfToken = gate.csrfToken;
  const browserlessSteps = new Set(["email", "tk", "yt", "fb"]);
  const browserRequiredSteps = gate.steps.filter(
    (step) => !browserlessSteps.has(step),
  );
  if (browserRequiredSteps.length > 0) {
    throw new BrowserRequiredError(browserRequiredSteps);
  }

  await post(
    "/gate/ge",
    new URLSearchParams({ vt: gate.gvt, uid: gate.uid }),
    gateUrl,
  );

  if (gate.steps.includes("email")) {
    await post(
      "/verifyEmailAddress",
      new URLSearchParams({
        validateEmailAddress: email,
        fan_gate_id: gate.fanGateId,
        email_name: name || email.split("@")[0] || "DJ",
        adcode: "",
        hypesource: "",
      }),
      gateUrl,
    );
  }

  const downloadBody = new URLSearchParams({
    file: gate.uid,
    download_visit: "true",
    profile_downloads: "true",
    time: String(Math.floor(Math.random() * gate.duration)),
    sc_comment_text: "",
    yt_comment_text: "",
    page: "nonsingle",
    is_skippable: gate.isSkippable,
    steps: gate.steps.join(","),
    email,
    download_action: "DOWNLOAD",
    wrndk: gate.wrndk,
    is_mobile: "",
    external_id: gate.externalId,
    hypesource: "",
    adcode: "",
    gvf: "0",
  });
  for (const step of gate.steps) {
    if (step !== "email") downloadBody.append("skip_gate_steps[]", step);
  }

  const unlockRes = await post("/gate/download/ul", downloadBody, gateUrl);
  const unlockJson = (await unlockRes.json()) as {
    download_status?: boolean;
    URL?: string;
    ext?: string;
    type?: string;
    size?: number;
    name?: string;
    social_currency?: number;
  };

  if (!unlockJson.download_status || !unlockJson.URL) {
    throw new Error("Hypeddit did not grant a download URL");
  }

  if (signal?.aborted) throw new ProcessCancelledError();

  const fileRes = await fetch(unlockJson.URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: gateUrl,
    },
    signal,
  });
  if (!fileRes.ok) {
    throw new Error(`Hypeddit file download failed (${fileRes.status})`);
  }

  const dispositionName = filenameFromContentDisposition(
    fileRes.headers.get("content-disposition"),
  );
  const urlName = (() => {
    try {
      const decoded = decodeURIComponent(unlockJson.URL);
      return (
        decoded.match(/filename%3D%22([^&]+)/)?.[1] ??
        decoded.match(/filename="([^"]+)/)?.[1] ??
        null
      );
    } catch {
      return null;
    }
  })();
  const baseName =
    dispositionName ||
    (urlName ? decodeURIComponent(urlName) : null) ||
    (unlockJson.name
      ? `${unlockJson.name}.${unlockJson.ext || "bin"}`
      : null) ||
    `hypeddit-${gate.uid}`;

  const bytes = Buffer.from(await fileRes.arrayBuffer());
  const claimedExt =
    unlockJson.ext?.toLowerCase() ||
    extFromNameOrType(
      baseName,
      unlockJson.type ?? fileRes.headers.get("content-type"),
    );
  const ext = sniffAudioExt(bytes) ?? claimedExt;
  const safeBase = baseName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .trim();
  const filename = `${safeBase || `hypeddit-${gate.uid}`}.${ext}`;
  const filePath = path.join(workDir, `hypeddit_${randomUUID()}.${ext}`);

  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(filePath, bytes);

  return {
    filePath,
    ext,
    filename,
    title: unlockJson.name ?? null,
    size: unlockJson.size ?? bytes.byteLength,
  };
}

type BrowserPage = object;

type BrowserContextLike = {
  setCookie(...cookies: SpotifyBrowserCookie[]): Promise<unknown>;
  newPage(): Promise<BrowserPage>;
  close(): Promise<unknown>;
};

type BrowserLike = {
  createBrowserContext(): Promise<BrowserContextLike>;
  close(): Promise<unknown>;
};

type BrowserLauncher = {
  launch(options: {
    executablePath: string;
    headless: true;
    args: string[];
    env: Record<string, string>;
    userDataDir: string;
  }): Promise<BrowserLike>;
};

type BrowserGatePayload = {
  bytes: Uint8Array;
  filename: string;
  claimedExt: string;
  title: string | null;
  size: number | null;
};

const BROWSER_TIMEOUT_MS = 45_000;
const POPUP_TIMEOUT_MS = 5_000;

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProcessCancelledError();
}

async function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  ensureNotAborted(signal);
  if (!signal) return promise;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ProcessCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function clickControlIfPresent(
  page: Page,
  labels: string[],
  signal?: AbortSignal,
  identity?: {
    ids?: string[];
    dataTypes?: string[];
    classTokens?: string[];
    textPrefixes?: string[];
  },
): Promise<boolean> {
  return Boolean(
    await withAbort(
    page.evaluate(
      ({
        allowedLabels,
        allowedRoots,
        ids,
        dataTypes,
        classTokens,
        textPrefixes,
      }) => {
        const normalized = new Set(
          allowedLabels.map((label) => label.trim().toLowerCase()),
        );
        const allowedIds = new Set(ids.map((id) => id.trim().toLowerCase()));
        const allowedDataTypes = new Set(
          dataTypes.map((type) => type.trim().toLowerCase()),
        );
        const allowedClassTokens = new Set(
          classTokens.map((token) => token.trim().toLowerCase()),
        );
        const allowedPrefixes = textPrefixes.map((prefix) =>
          prefix.trim().toLowerCase(),
        );
        const controls = Array.from(
          document.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>(
            "button, a",
          ),
        );
        const control = controls.find((element) => {
          const className = (
            (typeof element.className === "string" ? element.className : "") ||
            element.getAttribute("class") ||
            ""
          ).toLowerCase();
          const classTokensOnEl = new Set(
            className.split(/\s+/).filter(Boolean),
          );
          if (classTokensOnEl.has("hide") || classTokensOnEl.has("hidden")) {
            return false;
          }
          const disabled =
            ("disabled" in element && Boolean(element.disabled)) ||
            element.getAttribute("aria-disabled") === "true";
          const visible = !element.hidden && element.getClientRects().length > 0;
          if (disabled || !visible) return false;
          const text = (element.textContent ?? "").trim().toLowerCase();
          if (normalized.has(text)) return true;
          if (allowedPrefixes.some((prefix) => text.startsWith(prefix))) {
            return true;
          }
          const id = (
            element.id ||
            element.getAttribute("id") ||
            ""
          ).toLowerCase();
          if (id && allowedIds.has(id)) return true;
          const dataType = (
            element.getAttribute("data-type") || ""
          ).toLowerCase();
          if (dataType && allowedDataTypes.has(dataType)) return true;
          for (const token of allowedClassTokens) {
            if (classTokensOnEl.has(token)) return true;
          }
          return false;
        });
        if (!control) return false;
        if (control instanceof HTMLAnchorElement && control.href) {
          let target: URL;
          try {
            target = new URL(control.href, window.location.href);
          } catch {
            throw new Error(`Refusing gate control host: ${control.href}`);
          }
          const protocol = target.protocol.toLowerCase();
          const host = target.hostname.toLowerCase();
          const currentHost = window.location.hostname.toLowerCase();
          const allowed =
            protocol === "javascript:" ||
            ((protocol === "https:" || protocol === "http:") &&
              (host === currentHost ||
                allowedRoots.some(
                  (root) => host === root || host.endsWith(`.${root}`),
                )));
          if (!allowed) {
            throw new Error(`Refusing gate control host: ${target.hostname}`);
          }
        }
        control.click();
        return true;
      },
      {
        allowedLabels: labels,
        allowedRoots: [...GATE_CONTROL_ALLOWED_ROOTS],
        ids: identity?.ids ?? [],
        dataTypes: identity?.dataTypes ?? [],
        classTokens: identity?.classTokens ?? [],
        textPrefixes: identity?.textPrefixes ?? [],
      },
    ),
    signal,
    ),
  );
}

async function clickExactControl(
  page: Page,
  labels: string[],
  signal?: AbortSignal,
  identity?: {
    ids?: string[];
    dataTypes?: string[];
    classTokens?: string[];
    textPrefixes?: string[];
  },
): Promise<void> {
  const clicked = await clickControlIfPresent(page, labels, signal, identity);
  if (!clicked) {
    throw new Error(
      `Hypeddit gate changed: expected one of ${labels.map((label) => `“${label}”`).join(", ")}`,
    );
  }
}

async function clickUndoneProviderActions(
  page: Page,
  signal?: AbortSignal,
): Promise<number> {
  return Number(
    await withAbort(
      page.evaluate(({ allowedRoots }) => {
        const controls = Array.from(
          document.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>(
            "button, a",
          ),
        );
        let clicked = 0;
        for (const element of controls) {
          const className = (
            (typeof element.className === "string" ? element.className : "") ||
            element.getAttribute("class") ||
            ""
          ).toLowerCase();
          if (!className.split(/\s+/).includes("undone")) continue;
          const disabled =
            ("disabled" in element && Boolean(element.disabled)) ||
            element.getAttribute("aria-disabled") === "true";
          const visible =
            !element.hidden && element.getClientRects().length > 0;
          if (disabled || !visible) continue;
          if (element instanceof HTMLAnchorElement && element.href) {
            let target: URL;
            try {
              target = new URL(element.href, window.location.href);
            } catch {
              throw new Error(`Refusing gate control host: ${element.href}`);
            }
            const protocol = target.protocol.toLowerCase();
            const host = target.hostname.toLowerCase();
            const currentHost = window.location.hostname.toLowerCase();
            const allowed =
              protocol === "javascript:" ||
              ((protocol === "https:" || protocol === "http:") &&
                (host === currentHost ||
                  allowedRoots.some(
                    (root) => host === root || host.endsWith(`.${root}`),
                  )));
            if (!allowed) {
              throw new Error(`Refusing gate control host: ${target.hostname}`);
            }
          }
          element.click();
          clicked += 1;
        }
        return clicked;
      }, { allowedRoots: [...GATE_CONTROL_ALLOWED_ROOTS] }),
      signal,
    ),
  );
}

async function completeOpenTabStep(
  page: Page,
  step: string,
  signal?: AbortSignal,
): Promise<void> {
  await clickUndoneProviderActions(page, signal);
  const channel = await clickControlIfPresent(page, [], signal, {
    ids: [`skipper_${step}_channel`],
  });
  const next = await clickControlIfPresent(page, [], signal, {
    ids: [`skipper_${step}_next`],
  });
  if (!channel && !next) {
    await clickExactControl(page, ["Skip", "Next"], signal);
  }
}

async function readPageSteps(
  page: Page,
  signal?: AbortSignal,
): Promise<string[]> {
  const state = await withAbort(
    page.evaluate(() => {
      const input =
        document.querySelector<HTMLInputElement>("#nwSteps") ??
        document.querySelector<HTMLInputElement>('[name="nwSteps"]');
      if (!input) return { valid: false, steps: [] };
      const steps = input.value
        .split(",")
        .map((step) => step.trim())
        .filter(Boolean);
      return {
        valid: steps.every((step) => /^[a-z][a-z0-9_-]{0,31}$/i.test(step)),
        steps,
      };
    }),
    signal,
  );
  if (!state.valid) {
    throw new Error(
      "Missing or unparseable authoritative Hypeddit pending-step state (#nwSteps)",
    );
  }
  return state.steps;
}

async function waitForStepProgression(
  page: Page,
  step: string,
  signal?: AbortSignal,
): Promise<void> {
  await page.waitForFunction(
    (expectedStep) => {
      // Current Hypeddit pages expose pending providers in this hidden input.
      // It is the only accepted authoritative completion source. We accept no
      // generic Next/Download control and no invented Spotify "done" class:
      // no such completion marker is documented in the current page reference.
      const stepInput =
        document.querySelector<HTMLInputElement>("#nwSteps") ??
        document.querySelector<HTMLInputElement>('[name="nwSteps"]');
      if (!stepInput) {
        throw new Error(
          "Missing authoritative Hypeddit pending-step state (#nwSteps)",
        );
      }
      const steps = stepInput.value
        .split(",")
        .map((pending) => pending.trim())
        .filter(Boolean);
      if (!steps.every((pending) => /^[a-z][a-z0-9_-]{0,31}$/i.test(pending))) {
        throw new Error(
          "Unparseable authoritative Hypeddit pending-step state (#nwSteps)",
        );
      }
      return !steps.includes(expectedStep);
    },
    { timeout: BROWSER_TIMEOUT_MS, signal },
    step,
  );
}

async function confirmHypedditConfiguredSpotifyAction(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await waitForStepProgression(page, "sp", signal);
  } catch (error) {
    if (signal?.aborted) throw new ProcessCancelledError();
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(
        "Hypeddit did not confirm its configured Spotify action (follow/save)",
      );
    }
    throw error;
  }
}

async function confirmHypedditConfiguredInstagramAction(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await waitForStepProgression(page, "ig", signal);
  } catch (error) {
    if (signal?.aborted) throw new ProcessCancelledError();
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(
        "Hypeddit did not confirm its configured Instagram action (follow)",
      );
    }
    throw error;
  }
}

const SPOTIFY_REFRESH_MESSAGE =
  "Spotify session is no longer usable — refresh Spotify cookies and retry.";
const INSTAGRAM_REFRESH_MESSAGE =
  "Instagram session is no longer usable — refresh Instagram cookies and retry.";
const SPOTIFY_SESSION_NEEDED =
  "Hypeddit Spotify authorization needs a usable session — refresh Spotify cookies and retry.";
const INSTAGRAM_SESSION_NEEDED =
  "Hypeddit Instagram authorization needs a usable session — refresh Instagram cookies and retry.";
const BROWSER_SOCIAL_STEPS = new Set(["sp", "ig", "sc"]);

async function rejectExpiredSpotifySession(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  const expired = await withAbort(
    page.evaluate(() => {
      const url = new URL(window.location.href);
      if (
        url.hostname === "accounts.spotify.com" &&
        url.pathname.includes("/login")
      ) {
        return true;
      }
      if (
        Array.from(url.searchParams.keys()).some((key) =>
          /(?:spotify|oauth|auth)?.*error/i.test(key),
        ) ||
        (url.pathname.includes("callback") && url.searchParams.has("error"))
      ) {
        return true;
      }
      const alert = document.querySelector(
        '[role="alert"], .alert, .error, .error-message',
      );
      return Boolean(
        alert &&
        /spotify|oauth|authoriz|session|login/i.test(alert.textContent ?? "") &&
        /error|fail|denied|expired|invalid|login/i.test(
          alert.textContent ?? "",
        ),
      );
    }),
    signal,
  );
  if (expired) throw new Error(SPOTIFY_REFRESH_MESSAGE);
}

async function rejectExpiredInstagramSession(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  const expired = await withAbort(
    page.evaluate(() => {
      const url = new URL(window.location.href);
      const host = url.hostname.toLowerCase();
      if (
        (host === "instagram.com" || host.endsWith(".instagram.com")) &&
        url.pathname.includes("/accounts/login")
      ) {
        return true;
      }
      if (
        Array.from(url.searchParams.keys()).some((key) =>
          /(?:instagram|oauth|auth)?.*error/i.test(key),
        ) ||
        (url.pathname.includes("callback") && url.searchParams.has("error"))
      ) {
        return true;
      }
      const alert = document.querySelector(
        '[role="alert"], .alert, .error, .error-message',
      );
      return Boolean(
        alert &&
        /instagram|oauth|authoriz|session|login/i.test(
          alert.textContent ?? "",
        ) &&
        /error|fail|denied|expired|invalid|login/i.test(
          alert.textContent ?? "",
        ),
      );
    }),
    signal,
  );
  if (expired) throw new Error(INSTAGRAM_REFRESH_MESSAGE);
}

async function fillEmailStep(
  page: Page,
  email: string,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  const filled = await withAbort(
    page.evaluate(
      ({ emailValue, nameValue }) => {
        const emailInput =
          document.querySelector<HTMLInputElement>("#validateEmailAddress") ??
          document.querySelector<HTMLInputElement>(
            'input[name="validateEmailAddress"]',
          ) ??
          document.querySelector<HTMLInputElement>("#email_address") ??
          document.querySelector<HTMLInputElement>(
            'input[name="email_address"]',
          ) ??
          document.querySelector<HTMLInputElement>('input[type="email"]');
        if (!emailInput) return false;
        const setValue = (input: HTMLInputElement, value: string) => {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set;
          setter?.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        setValue(emailInput, emailValue);
        const nameInput =
          document.querySelector<HTMLInputElement>("#email_name") ??
          document.querySelector<HTMLInputElement>('input[name="email_name"]');
        if (nameInput) setValue(nameInput, nameValue);
        return true;
      },
      { emailValue: email, nameValue: name },
    ),
    signal,
  );
  if (!filled)
    throw new Error("Hypeddit email step changed: email field missing");
  await clickExactControl(
    page,
    ["Continue", "Submit", "Next", "Share email address"],
    signal,
  );
  await waitForStepProgression(page, "email", signal);
}

async function optOutOptionalMarketing(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  await withAbort(
    page.evaluate(() => {
      const optional = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ).filter((input) =>
        /marketing|newsletter|updates|offers/i.test(
          `${input.name} ${input.id} ${input.getAttribute("aria-label") ?? ""}`,
        ),
      );
      for (const input of optional) {
        if (input.checked) input.click();
      }
    }),
    signal,
  );
}

async function acceptSpotifyAuthorizationPage(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  await withAbort(
    page.waitForFunction(
      () => window.location.hostname === "accounts.spotify.com",
      { timeout: BROWSER_TIMEOUT_MS, signal },
    ),
    signal,
  );
  if (!isSafeSpotifyAuthorizationUrl(page.url())) {
    throw new Error(
      "Refusing Spotify authorization outside accounts.spotify.com",
    );
  }
  if (new URL(page.url()).pathname.includes("/login")) {
    throw new Error(SPOTIFY_REFRESH_MESSAGE);
  }
  const accepted = await withAbort(
    page.evaluate(() => {
      const testId = document.querySelector<HTMLButtonElement>(
        'button[data-testid="auth-accept"]',
      );
      const exact = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) =>
        ["agree", "accept", "continue"].includes(
          (button.textContent ?? "").trim().toLowerCase(),
        ),
      );
      const button = testId ?? exact;
      if (!button) return false;
      button.click();
      return true;
    }),
    signal,
  );
  if (!accepted) {
    throw new Error("Spotify authorization changed: accept control missing");
  }
}

async function completeInstagramActionPage(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  await withAbort(
    page.waitForFunction(
      () => {
        const host = window.location.hostname.toLowerCase();
        return host === "instagram.com" || host.endsWith(".instagram.com");
      },
      { timeout: BROWSER_TIMEOUT_MS, signal },
    ),
    signal,
  );
  if (!isSafeInstagramUrl(page.url())) {
    throw new Error("Refusing Instagram action outside instagram.com");
  }
  if (new URL(page.url()).pathname.includes("/accounts/login")) {
    throw new Error(INSTAGRAM_REFRESH_MESSAGE);
  }
  const accepted = await withAbort(
    page.evaluate(() => {
      const labels = new Set([
        "follow",
        "follow back",
        "allow",
        "authorize",
        "agree",
        "accept",
        "continue",
      ]);
      const alreadyDone = new Set(["following", "requested"]);
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>("button, a, [role='button']"),
      );
      const textOf = (element: HTMLElement) =>
        (element.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      if (
        controls.some((element) => {
          const text = textOf(element);
          return (
            alreadyDone.has(text) ||
            [...alreadyDone].some((label) => text.startsWith(`${label} `))
          );
        })
      ) {
        return true;
      }
      const control = controls.find((element) => {
        const text = textOf(element);
        return (
          labels.has(text) ||
          [...labels].some((label) => text.startsWith(`${label} `))
        );
      });
      if (!control) return false;
      control.click();
      return true;
    }),
    signal,
  );
  if (!accepted) {
    throw new Error(
      "Instagram authorization changed: follow/allow control missing",
    );
  }
}

async function waitForProviderPopup(
  context: BrowserContext,
  openerTarget: ReturnType<Page["target"]>,
  isSafeUrl: (url: string) => boolean,
  signal?: AbortSignal,
): Promise<Page | null> {
  try {
    const target = await context.waitForTarget(
      (candidate) =>
        candidate.opener() === openerTarget && isSafeUrl(candidate.url()),
      { timeout: POPUP_TIMEOUT_MS, signal },
    );
    return await target.page();
  } catch (error) {
    if (signal?.aborted) throw new ProcessCancelledError();
    if (error instanceof Error && error.name === "TimeoutError") return null;
    throw error;
  }
}

function responseLooksLikeDownload(response: HTTPResponse): boolean {
  const headers = response.headers();
  const disposition = headers["content-disposition"] ?? "";
  const contentType = headers["content-type"] ?? "";
  return (
    /attachment/i.test(disposition) ||
    /^audio\//i.test(contentType) ||
    response.url().includes("/gate/download/ul")
  );
}

async function payloadFromDownloadResponse(
  response: HTTPResponse,
  gateUrl: string,
  signal?: AbortSignal,
): Promise<BrowserGatePayload> {
  const headers = response.headers();
  const contentType = headers["content-type"] ?? "";
  if (
    response.url().includes("/gate/download/ul") ||
    contentType.includes("json")
  ) {
    const json = (await withAbort(response.json(), signal)) as {
      download_status?: boolean;
      URL?: string;
      ext?: string;
      name?: string;
      size?: number;
    };
    if (!json.download_status || !json.URL) {
      throw new Error("Hypeddit did not grant the browser download");
    }
    const fileResponse = await fetch(json.URL, {
      headers: { "User-Agent": USER_AGENT, Referer: gateUrl },
      signal,
    });
    if (!fileResponse.ok) {
      throw new Error(`Hypeddit file download failed (${fileResponse.status})`);
    }
    const bytes = new Uint8Array(await fileResponse.arrayBuffer());
    const dispositionName = filenameFromContentDisposition(
      fileResponse.headers.get("content-disposition"),
    );
    return {
      bytes,
      filename:
        dispositionName ??
        (json.name ? `${json.name}.${json.ext || "bin"}` : "hypeddit-download"),
      claimedExt:
        json.ext?.toLowerCase() ??
        extFromNameOrType(
          dispositionName ?? json.name ?? "hypeddit-download",
          fileResponse.headers.get("content-type"),
        ),
      title: json.name ?? null,
      size: json.size ?? bytes.byteLength,
    };
  }

  const bytes = new Uint8Array(await withAbort(response.buffer(), signal));
  const filename =
    filenameFromContentDisposition(headers["content-disposition"] ?? null) ??
    "hypeddit-download";
  return {
    bytes,
    filename,
    claimedExt: extFromNameOrType(filename, contentType),
    title: null,
    size: bytes.byteLength,
  };
}

async function automateSpotifyGate(params: {
  page: Page;
  context: BrowserContext;
  gateUrl: string;
  email: string;
  name: string;
  signal?: AbortSignal;
}): Promise<BrowserGatePayload> {
  const { page, context, signal } = params;
  page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
  await withAbort(
    page.goto(params.gateUrl, {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_TIMEOUT_MS,
    }),
    signal,
  );
  await clickExactControl(page, ["Get Track", "Free Download", "Download"], signal);

  const steps = await readPageSteps(page, signal);
  const supported = new Set(["email", "sc", "ig", "tk", "yt", "fb", "sp"]);
  const unknown = steps.filter((step) => !supported.has(step));
  if (unknown.length > 0) throw new BrowserRequiredError(unknown);

  if (steps.includes("email")) {
    await fillEmailStep(page, params.email, params.name, signal);
  }

  const completeSpotifyStep = async () => {
    await optOutOptionalMarketing(page, signal);
    const openerTarget = page.target();
    await authorizeSpotifyAndConfirmHypedditAction({
      signal,
      clickConnect: () =>
        clickExactControl(
          page,
          ["Connect Spotify", "Connect with Spotify", "Spotify Connect"],
          signal,
          {
            ids: ["login_to_sp"],
            dataTypes: ["spotify"],
            classTokens: ["hype-btn-spotify"],
          },
        ),
      waitForPopup: () =>
        waitForProviderPopup(
          context,
          openerTarget,
          isSafeSpotifyAuthorizationUrl,
          signal,
        ),
      acceptAuthorization: (popup) =>
        acceptSpotifyAuthorizationPage(popup as Page, signal),
      // Hypeddit's callback performs the configured follow/save. We never guess
      // or click a provider action; only positive Hypeddit progression unlocks.
      waitForHypedditActionConfirmation: async () => {
        await rejectExpiredSpotifySession(page, signal);
        await confirmHypedditConfiguredSpotifyAction(page, signal);
      },
    });
  };

  for (const step of steps) {
    if (step === "email") continue;
    if (step === "sc" || step === "ig" || step === "tk" || step === "yt" || step === "fb") {
      await completeOpenTabStep(page, step, signal);
      continue;
    }
    if (step === "sp") {
      await completeSpotifyStep();
    }
  }

  const [response] = await Promise.all([
    page.waitForResponse(responseLooksLikeDownload, {
      timeout: BROWSER_TIMEOUT_MS,
      signal,
    }),
    clickExactControl(page, ["Download", "Download Track"], signal),
  ]);
  return payloadFromDownloadResponse(response, params.gateUrl, signal);
}

export async function downloadHypedditGateWithBrowser(params: {
  gateUrl: string;
  email: string;
  name: string;
  workDir: string;
  cookies: SpotifyBrowserCookie[];
  signal?: AbortSignal;
  launcher?: BrowserLauncher;
  randomId?: () => string;
}): Promise<HypedditDownloadResult> {
  if (params.signal?.aborted) throw new ProcessCancelledError();
  const { withSecureHypedditBrowser } = await import("./hypeddit-browser");
  const payload = await withSecureHypedditBrowser({
    cookies: params.cookies,
    launcher: params.launcher,
    signal: params.signal,
    run: async (page, context) => {
      if (params.signal?.aborted) throw new ProcessCancelledError();
      return automateSpotifyGate({
        page: page as Page,
        context: context as unknown as BrowserContext,
        gateUrl: params.gateUrl,
        email: params.email,
        name: params.name,
        signal: params.signal,
      });
    },
  });
  if (params.signal?.aborted) throw new ProcessCancelledError();

  const bytes = Buffer.from(payload.bytes);
  const claimedExt =
    payload.claimedExt.toLowerCase() ||
    extFromNameOrType(payload.filename, null);
  const ext = sniffAudioExt(bytes) ?? claimedExt;
  const safeBase = payload.filename
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .trim();
  const filename = `${safeBase || "hypeddit-download"}.${ext}`;
  const filePath = path.join(
    params.workDir,
    `hypeddit_${params.randomId?.() ?? randomUUID()}.${ext}`,
  );
  await fs.mkdir(params.workDir, { recursive: true });
  await fs.writeFile(filePath, bytes);
  return {
    filePath,
    ext,
    filename,
    title: payload.title,
    size: payload.size ?? bytes.byteLength,
  };
}

export type SpotifyFallbackDependencies = {
  browserlessDownload: typeof downloadHypedditGate;
  materializeSpotifyCookies: (userId: string) => Promise<string | null>;
  materializeInstagramCookies: (userId: string) => Promise<string | null>;
  readCookieFile: (cookiePath: string) => Promise<string>;
  unlinkCookieFile: (cookiePath: string) => Promise<unknown>;
  browserDownload: (
    params: Omit<Parameters<typeof downloadHypedditGate>[0], never> & {
      cookies: BrowserCookie[];
    },
  ) => Promise<HypedditDownloadResult>;
};

export async function downloadHypedditWithSpotifyFallback(
  params: Parameters<typeof downloadHypedditGate>[0] & {
    userId: string;
  } & Partial<SpotifyFallbackDependencies>,
): Promise<HypedditDownloadResult> {
  const browserlessDownload =
    params.browserlessDownload ?? downloadHypedditGate;
  try {
    return await browserlessDownload(params);
  } catch (error) {
    if (!(error instanceof BrowserRequiredError)) throw error;
    if (
      error.steps.length === 0 ||
      error.steps.some((step) => !BROWSER_SOCIAL_STEPS.has(step))
    ) {
      throw error;
    }

    const cookiePaths: string[] = [];
    const unlinkCookieFile =
      params.unlinkCookieFile ?? ((filePath: string) => fs.unlink(filePath));
    try {
      const materializeSpotifyCookies =
        params.materializeSpotifyCookies ??
        ((userId: string) => materializeCookieFile(userId, "spotify"));
      const materializeInstagramCookies =
        params.materializeInstagramCookies ??
        ((userId: string) => materializeCookieFile(userId, "instagram"));
      const readCookieFile =
        params.readCookieFile ??
        ((filePath: string) => fs.readFile(filePath, "utf8"));
      const cookies: BrowserCookie[] = [];

      const loadCookies = async (
        cookiePath: string | null,
        parse: (text: string) => BrowserCookie[],
        missingMessage: string,
        required: boolean,
      ) => {
        if (!cookiePath) {
          if (required) throw new Error(missingMessage);
          return;
        }
        cookiePaths.push(cookiePath);
        let cookieText: string;
        try {
          cookieText = await readCookieFile(cookiePath);
        } catch {
          if (required) throw new Error(missingMessage);
          return;
        }
        const parsed = parse(cookieText);
        if (parsed.length === 0) {
          if (required) throw new Error(missingMessage);
          return;
        }
        cookies.push(...parsed);
      };

      for (const step of error.steps) {
        if (step === "sp") {
          await loadCookies(
            await materializeSpotifyCookies(params.userId),
            parseSpotifyNetscapeCookies,
            SPOTIFY_SESSION_NEEDED,
            true,
          );
        }
        if (step === "ig") {
          await loadCookies(
            await materializeInstagramCookies(params.userId),
            parseInstagramNetscapeCookies,
            INSTAGRAM_SESSION_NEEDED,
            false,
          );
        }
      }

      const browserDownload =
        params.browserDownload ??
        ((browserParams) =>
          downloadHypedditGateWithBrowser({
            gateUrl: browserParams.gateUrl,
            email: browserParams.email,
            name: browserParams.name,
            workDir: browserParams.workDir,
            signal: browserParams.signal,
            cookies: browserParams.cookies,
          }));
      return await browserDownload({ ...params, cookies });
    } finally {
      await Promise.all(
        cookiePaths.map((cookiePath) =>
          unlinkCookieFile(cookiePath).catch(() => undefined),
        ),
      );
    }
  }
}

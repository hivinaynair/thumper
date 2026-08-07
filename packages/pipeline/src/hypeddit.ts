import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

type GateData = {
  csrfToken: string;
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
 * Throws when the server refuses the download (e.g. verified Spotify Connect).
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
    throw new Error("Hypeddit gate needs your account email (Clerk primary email)");
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
    external_id: "",
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
    const needsSpotify = gate.steps.includes("sp");
    throw new Error(
      needsSpotify
        ? "Hypeddit gate requires Spotify Connect — browser automation not supported yet. Open the Free Download link on SoundCloud and clear the gate manually, then use WAV → AIFF."
        : "Hypeddit did not grant a download URL (gate steps may need a real browser).",
    );
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
    (unlockJson.name ? `${unlockJson.name}.${unlockJson.ext || "bin"}` : null) ||
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

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { youtubePremiumFromMetaJson } from "@thumper/shared";
import { dataRoot } from "./paths";
import { deleteObject, headObject, putBytes, readBytes, userStorageKey } from "./storage";

const ALGO = "aes-256-gcm";

function keyFromEnv(): Buffer {
  const raw = process.env.COOKIE_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error("COOKIE_ENCRYPTION_KEY must be at least 32 characters");
  }
  return createHash("sha256").update(raw).digest();
}

export function encryptBytes(plain: Buffer): Buffer {
  const key = keyFromEnv();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

export function decryptBytes(payload: Buffer): Buffer {
  const key = keyFromEnv();
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const data = payload.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export type CookieProvider = "youtube" | "soundcloud" | "patreon";

function cookieKey(userId: string, provider: CookieProvider): string {
  return userStorageKey(userId, "cookies", `${provider}.cookies.enc`);
}

function cookieMetaKey(userId: string, provider: CookieProvider): string {
  return userStorageKey(userId, "cookies", `${provider}.meta.json`);
}

export async function saveEncryptedCookies(
  userId: string,
  provider: CookieProvider,
  netscapeText: string,
  options?: { premium?: boolean | null },
): Promise<void> {
  const encrypted = encryptBytes(Buffer.from(netscapeText, "utf8"));
  await putBytes(cookieKey(userId, provider), encrypted, {
    contentType: "application/octet-stream",
  });
  if (provider === "youtube" && typeof options?.premium === "boolean") {
    await putBytes(
      cookieMetaKey(userId, provider),
      Buffer.from(JSON.stringify({ premium: options.premium }), "utf8"),
      { contentType: "application/json" },
    );
  }
}

export async function deleteCookies(userId: string, provider: CookieProvider): Promise<void> {
  await Promise.all([
    deleteObject(cookieKey(userId, provider)),
    deleteObject(cookieMetaKey(userId, provider)),
  ]);
}

export type CookieProviderStatus = {
  present: boolean;
  updatedAt: string | null;
  /** Full YouTube Premium. Always null for SoundCloud or an unprobed session. */
  premium: boolean | null;
};

export type CookieStatusMap = Record<"youtube" | "soundcloud", CookieProviderStatus>;

export async function getCookieStatus(userId: string): Promise<CookieStatusMap> {
  const providers = ["youtube", "soundcloud"] as const;
  // Cookie HEADs plus the YouTube Premium sidecar — the page polls this, so
  // don't pay for them one after the other.
  const [metas, youtubeMeta] = await Promise.all([
    Promise.all(providers.map((provider) => headObject(cookieKey(userId, provider)))),
    readBytes(cookieMetaKey(userId, "youtube")),
  ]);
  const youtubePremium = youtubePremiumFromMetaJson(youtubeMeta?.toString("utf8") ?? null);
  const out = {} as CookieStatusMap;
  providers.forEach((provider, i) => {
    const meta = metas[i];
    out[provider] = {
      present: Boolean(meta && meta.size > 0),
      updatedAt: meta?.updatedAt?.toISOString() ?? null,
      premium: provider === "youtube" ? youtubePremium : null,
    };
  });
  return out;
}

/** Decrypt to a temp plaintext Netscape file; caller must always unlink it. */
export async function materializeCookieFile(
  userId: string,
  provider: CookieProvider,
): Promise<string | null> {
  try {
    const encrypted = await readBytes(cookieKey(userId, provider));
    if (!encrypted) return null;
    const plain = decryptBytes(encrypted);
    const tmpDir = path.join(dataRoot(), "tmp");
    await fs.mkdir(tmpDir, { recursive: true });
    const tmp = path.join(
      tmpDir,
      `${provider}-${userId.replace(/[^a-zA-Z0-9]/g, "")}-${Date.now()}.txt`,
    );
    await fs.writeFile(tmp, plain, { mode: 0o600 });
    return tmp;
  } catch {
    return null;
  }
}

export function looksLikeNetscapeCookies(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) return false;
  return lines.some((line) => line.split("\t").length >= 7);
}

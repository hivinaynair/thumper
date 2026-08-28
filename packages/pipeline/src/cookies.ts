import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataRoot } from "./paths";
import {
  deleteObject,
  headObject,
  putBytes,
  readBytes,
  userStorageKey,
} from "./storage";

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

export type CookieProvider =
  | "youtube"
  | "soundcloud"
  | "spotify"
  | "instagram"
  | "patreon";

function cookieKey(userId: string, provider: CookieProvider): string {
  return userStorageKey(userId, "cookies", `${provider}.cookies.enc`);
}

export async function saveEncryptedCookies(
  userId: string,
  provider: CookieProvider,
  netscapeText: string,
): Promise<void> {
  const encrypted = encryptBytes(Buffer.from(netscapeText, "utf8"));
  await putBytes(cookieKey(userId, provider), encrypted, {
    contentType: "application/octet-stream",
  });
}

export async function deleteCookies(
  userId: string,
  provider: CookieProvider,
): Promise<void> {
  await deleteObject(cookieKey(userId, provider));
}

export type CookieProviderStatus = {
  present: boolean;
  updatedAt: string | null;
};

export type CookieStatusMap = Record<
  "youtube" | "soundcloud" | "spotify" | "instagram",
  CookieProviderStatus
>;

export async function getCookieStatus(
  userId: string,
): Promise<CookieStatusMap> {
  const providers = ["youtube", "soundcloud", "spotify", "instagram"] as const;
  const out = {} as CookieStatusMap;
  for (const provider of providers) {
    const meta = await headObject(cookieKey(userId, provider));
    out[provider] = {
      present: Boolean(meta && meta.size > 0),
      updatedAt: meta?.updatedAt?.toISOString() ?? null,
    };
  }
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

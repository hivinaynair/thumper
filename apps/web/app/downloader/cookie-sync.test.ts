import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  COOKIE_SYNC_EXTENSION_VERSION,
  COOKIE_SYNC_RELOAD_MESSAGE,
  cookieSyncMissingInstagram,
  isCookieSyncTooOld,
} from "./cookie-sync";

test("treats Cookie Sync below 0.5 as too old to open Instagram", () => {
  expect(isCookieSyncTooOld(null)).toBe(true);
  expect(isCookieSyncTooOld("")).toBe(true);
  expect(isCookieSyncTooOld("0.4.0")).toBe(true);
  expect(isCookieSyncTooOld("0.5.0")).toBe(false);
  expect(isCookieSyncTooOld("0.5.1")).toBe(false);
});

test("detects the Refresh payload from an extension that never heard of Instagram", () => {
  expect(
    cookieSyncMissingInstagram({
      results: {
        youtube: { status: "synced" },
        soundcloud: { status: "synced" },
        spotify: { status: "synced" },
      },
    }),
  ).toBe(true);
  expect(
    cookieSyncMissingInstagram({
      results: {
        youtube: { status: "synced" },
        instagram: { status: "skipped" },
      },
    }),
  ).toBe(false);
});

test("tells the operator to reload Cookie Sync when Instagram is missing", () => {
  expect(COOKIE_SYNC_RELOAD_MESSAGE).toContain(COOKIE_SYNC_EXTENSION_VERSION);
  expect(COOKIE_SYNC_RELOAD_MESSAGE).toContain("chrome://extensions");
});

test("ships a Cookie Sync build that warms Instagram and always rebuilds the zip", async () => {
  const repoRoot = path.resolve(import.meta.dir, "../../../..");
  const [background, manifest, copyScript, page] = await Promise.all([
    fs.readFile(
      path.join(repoRoot, "apps/extension/src/background.js"),
      "utf8",
    ),
    fs.readFile(path.join(repoRoot, "apps/extension/manifest.json"), "utf8"),
    fs.readFile(
      path.join(repoRoot, "apps/web/scripts/copy-extension.mjs"),
      "utf8",
    ),
    fs.readFile(path.join(import.meta.dir, "page.tsx"), "utf8"),
  ]);

  expect(background).toContain('instagram: "https://www.instagram.com/"');
  expect(background).toContain('"instagram"');
  expect(JSON.parse(manifest).version).toBe(COOKIE_SYNC_EXTENSION_VERSION);
  expect(copyScript).not.toContain("if (!existsSync(zip))");
  expect(copyScript).toContain('["./build.mjs"]');
  expect(page).toContain("COOKIE_SYNC_EXTENSION_VERSION");
  expect(page).toContain("COOKIE_SYNC_RELOAD_MESSAGE");
  expect(page).toContain("cookieSyncTooOld");
});

import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";
import { COOKIE_SYNC_DISCLOSURE, HYPEDDIT_ORIGINAL_COPY } from "./result-copy";

test("describes Hypeddit originals without claiming every file becomes FLAC", () => {
  expect(HYPEDDIT_ORIGINAL_COPY).toStartWith(
    "Artist original preserved — WAV becomes tagged FLAC; other formats stay unchanged.",
  );
});

test("discloses the real Spotify account action authorized by a synced session", () => {
  expect(HYPEDDIT_ORIGINAL_COPY).toContain(
    "your synced session authorizes the real follow/save requested by the gate",
  );
});

test("discloses what a synced session authorizes", () => {
  expect(COOKIE_SYNC_DISCLOSURE).toContain(
    "authorizes the real follow/save requested by Hypeddit gates",
  );
});

test("shows the Spotify action disclosure before the cookie-sync action", async () => {
  const source = await fs.readFile(
    path.join(import.meta.dir, "page.tsx"),
    "utf8",
  );
  // Both anchors are render sites, not declarations: `{COOKIE_SYNC_DISCLOSURE}`
  // is where the copy is painted and `void syncCookies()` is the onClick, so
  // their order in the source is their order on the page. Syncing hands over a
  // session that acts on the user's real accounts — they must read that first.
  const disclosure = source.indexOf("{COOKIE_SYNC_DISCLOSURE}");
  const syncAction = source.indexOf("void syncCookies()");

  expect(disclosure).toBeGreaterThanOrEqual(0);
  expect(syncAction).toBeGreaterThan(disclosure);
});

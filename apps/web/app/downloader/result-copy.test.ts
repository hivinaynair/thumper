import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";
import { HYPEDDIT_ORIGINAL_COPY } from "./result-copy";

test("describes Hypeddit originals without claiming every file becomes FLAC", () => {
  expect(HYPEDDIT_ORIGINAL_COPY).toStartWith(
    "Artist original preserved — WAV becomes tagged FLAC; other formats stay unchanged.",
  );
});

test("discloses the real Spotify account action authorized by a synced session", () => {
  expect(HYPEDDIT_ORIGINAL_COPY).toContain(
    "your synced Spotify session authorizes the real follow/save requested by the gate",
  );
});

test("shows the Spotify action disclosure before the cookie-sync action", async () => {
  const source = await fs.readFile(
    path.join(import.meta.dir, "page.tsx"),
    "utf8",
  );
  const disclosure = source.indexOf(
    "Synced Spotify sessions authorize the real follow/save requested by Hypeddit gates.",
  );
  const syncButton = source.indexOf("className={`cookie-sync-btn");

  expect(disclosure).toBeGreaterThanOrEqual(0);
  expect(syncButton).toBeGreaterThan(disclosure);
  expect(source).toContain("cookie-sync-disclosure");
});

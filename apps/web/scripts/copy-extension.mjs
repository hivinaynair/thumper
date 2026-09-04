import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "..", "extension");
const zip = join(extensionDir, "dist", "thumper-extension.zip");
const publicDir = join(here, "..", "public");

// Always rebuild. A leftover zip from an older Cookie Sync would be copied
// onto the site and ship stale sync behaviour.
console.log("[copy-extension] building extension");
execFileSync("bun", ["./build.mjs"], {
  cwd: extensionDir,
  stdio: "inherit",
});

mkdirSync(publicDir, { recursive: true });
copyFileSync(zip, join(publicDir, "thumper-extension.zip"));
console.log("[copy-extension] public/thumper-extension.zip updated");

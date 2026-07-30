import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "..", "extension");
const zip = join(extensionDir, "dist", "thumper-extension.zip");
const publicDir = join(here, "..", "public");

// Under `turbo run build`, ^build has already produced the zip. Vercel builds
// apps/web directly without that ordering, so build it on demand instead of
// shipping a download link that 404s.
if (!existsSync(zip)) {
  console.log("[copy-extension] zip missing — building extension");
  execFileSync("bun", ["./build.mjs"], {
    cwd: extensionDir,
    stdio: "inherit",
  });
}

mkdirSync(publicDir, { recursive: true });
copyFileSync(zip, join(publicDir, "thumper-extension.zip"));
console.log("[copy-extension] public/thumper-extension.zip updated");

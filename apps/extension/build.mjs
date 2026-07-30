import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "manifest.json"), join(out, "manifest.json"));
cpSync(join(root, "src", "background.js"), join(out, "background.js"));
cpSync(join(root, "src", "popup.html"), join(out, "popup.html"));
cpSync(join(root, "src", "popup.js"), join(out, "popup.js"));
console.log("Built extension to apps/extension/dist (Load unpacked)");

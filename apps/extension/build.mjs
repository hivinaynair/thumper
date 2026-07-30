import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeZip } from "./zip.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "dist");

// The extension's files, in the layout Chrome expects at the root of the
// unpacked folder / zip.
const FILES = [
  ["manifest.json", join(root, "manifest.json")],
  ["background.js", join(root, "src", "background.js")],
  ["content.js", join(root, "src", "content.js")],
  ["popup.html", join(root, "src", "popup.html")],
  ["popup.js", join(root, "src", "popup.js")],
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const [name, src] of FILES) {
  cpSync(src, join(out, name));
}

// Same files as a zip, for the download link on the site. Built from the
// source paths rather than by scanning dist/, so it can't contain itself.
const zip = makeZip(
  FILES.map(([name, src]) => ({ name, data: readFileSync(src) })),
);
writeFileSync(join(out, "thumper-extension.zip"), zip);

console.log(
  "Built extension to apps/extension/dist (Load unpacked) + dist/thumper-extension.zip",
);

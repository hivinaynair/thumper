/**
 * CLI used by Modal's search endpoint — prints JSON candidates to stdout.
 * Usage: bun src/search-sc.ts --query=artist title
 */
import { searchSoundCloudTracks } from "@thumper/pipeline";

const raw =
  process.argv.find((a) => a.startsWith("--query="))?.slice("--query=".length) ??
  "";
const query = decodeURIComponent(raw).trim();

if (!query) {
  console.error("Usage: bun run search-sc --query=<search terms>");
  process.exit(2);
}

try {
  const candidates = await searchSoundCloudTracks(query, { limit: 2 });
  process.stdout.write(JSON.stringify({ ok: true, candidates }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

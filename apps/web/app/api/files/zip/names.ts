/**
 * Two jobs can finish with the same filename (same track twice, or two mirrors
 * of it). Zip entries must be unique or the archive silently loses tracks, so
 * collisions get a " (2)", " (3)" suffix before the extension.
 */
export function uniqueZipNames(filenames: string[]): string[] {
  const seen = new Map<string, number>();
  return filenames.map((filename) => {
    const safe = filename.replace(/[/\\]/g, "_") || "track";
    const count = seen.get(safe) ?? 0;
    seen.set(safe, count + 1);
    if (count === 0) return safe;

    const dot = safe.lastIndexOf(".");
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : "";
    return `${stem} (${count + 1})${ext}`;
  });
}

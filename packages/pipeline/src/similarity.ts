/** Lightweight string helpers inspired by spotDL's slugify + rapidfuzz ratio. */

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/** 0–100 similarity (rapidfuzz-style simple ratio). */
export function ratio(a: string, b: string): number {
  const left = slugify(a);
  const right = slugify(b);
  if (!left && !right) return 100;
  if (!left || !right) return 0;
  const dist = levenshtein(left, right);
  const maxLen = Math.max(left.length, right.length);
  return ((maxLen - dist) / maxLen) * 100;
}

export function containsSlug(haystack: string, needle: string): boolean {
  const h = slugify(haystack).replace(/-/g, "");
  const n = slugify(needle).replace(/-/g, "");
  return n.length > 0 && h.includes(n);
}

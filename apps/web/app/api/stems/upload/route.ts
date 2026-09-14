/**
 * Stem uploads are byte-identical to retag uploads: the same audio formats,
 * the same `users/<id>/uploads/` prefix, the same R2-vs-local handshake.
 * The handlers are re-exported rather than duplicated so the two paths cannot
 * drift — the only thing this file adds is a URL that matches the feature
 * calling it.
 *
 * The response carries a `searchQuery` field the stems page ignores.
 */
export { GET, POST } from "../../retag/upload/route";

// Route segment config has to be statically declared in the route file itself —
// Next.js parses it at compile time and cannot follow a re-export. Keep these
// in step with apps/web/app/api/retag/upload/route.ts.
export const runtime = "nodejs";
export const maxDuration = 300;

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher([
  "/downloader(.*)",
  "/retag(.*)",
  "/stems(.*)",
  "/api/jobs(.*)",
  "/api/files(.*)",
  "/api/cookies(.*)",
  "/api/metadata(.*)",
  "/api/retag(.*)",
  "/api/stems(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next internals, static assets, and stale Serwist SW probes
    "/((?!_next/static|_next/image|favicon.ico|serwist/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|js)$).*)",
  ],
};

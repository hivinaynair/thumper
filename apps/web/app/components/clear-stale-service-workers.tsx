"use client";

import { useEffect } from "react";

/**
 * Clears stale service workers (e.g. Serwist from another app on :3000)
 * that can cause full-page reload loops when /serwist/sw.js 404s.
 */
export function ClearStaleServiceWorkers() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    void (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  return null;
}

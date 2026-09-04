"use client";

import Spline from "@splinetool/react-spline";
import { useState } from "react";

// Served from apps/web/public, so the scene ships with the deploy instead of
// round-tripping to Spline's CDN on every first paint.
export const THUMPER_SPLINE_SCENE = "/scene.splinecode";

export function SplineScene({ className }: { className?: string }) {
  const [ready, setReady] = useState(false);

  return (
    <div
      className={`${className ?? "spline-frame"}${ready ? " is-ready" : ""}`}
    >
      <Spline
        scene={THUMPER_SPLINE_SCENE}
        onLoad={() => setReady(true)}
      />
    </div>
  );
}

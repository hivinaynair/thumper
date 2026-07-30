"use client";

import Spline from "@splinetool/react-spline";
import { useState } from "react";

export const THUMPER_SPLINE_SCENE =
  "https://prod.spline.design/z-u9IDagf12sOdG2/scene.splinecode";

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

"use client";

/** PROTOTYPE — throwaway. Never rendered in production builds. */
import { useEffect, useRef } from "react";

export function PrototypeSwitcher<T extends string>({
  variants,
  current,
  names,
  onChange,
}: {
  variants: readonly T[];
  current: T;
  names?: Partial<Record<T, string>>;
  onChange: (next: T) => void;
}) {
  const index = Math.max(0, variants.indexOf(current));
  const step = (delta: number) => {
    const next = variants[(index + delta + variants.length) % variants.length];
    if (next) onChange(next);
  };

  // One listener for the life of the component: a bare useEffect with no dep
  // array re-registers on every poll-driven re-render and ends up firing the
  // step several times per keypress.
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }
      stepRef.current(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="pv-switcher" role="group" aria-label="Prototype variant">
      <button type="button" onClick={() => step(-1)} aria-label="Previous variant">
        ←
      </button>
      <span className="pv-switcher-label">
        <b>{current}</b>
        {names?.[current] ? ` · ${names[current]}` : ""}
      </span>
      <button type="button" onClick={() => step(1)} aria-label="Next variant">
        →
      </button>
    </div>
  );
}

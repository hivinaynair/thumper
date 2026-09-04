/** Job state as a single dot, shared by the downloader queue and retag. */
export function StatusDot({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "bg-[var(--ui-tier-master)]"
      : status === "failed" || status === "cancelled"
        ? "bg-[var(--ui-tier-unsuitable)]"
        : status === "running"
          ? "bg-primary animate-pulse"
          : "bg-muted-foreground";
  return <span className={`size-2 shrink-0 rounded-full ${tone}`} />;
}

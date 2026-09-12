/**
 * Same signal as packages/shared/src/youtube-premium.ts — keep these in sync.
 * Full YouTube Premium only; YouTube Music Premium does not set this logo.
 */
export function youtubePremiumFromInitialData(data) {
  const renderer = data?.topbar?.desktopTopbarRenderer?.logo?.topbarLogoRenderer;
  if (!renderer) return false;
  if (renderer.iconImage?.iconType === "YOUTUBE_PREMIUM_LOGO") return true;
  const tooltip = renderer.tooltipText;
  const text =
    typeof tooltip?.simpleText === "string"
      ? tooltip.simpleText
      : Array.isArray(tooltip?.runs)
        ? tooltip.runs.map((run) => run.text ?? "").join("")
        : "";
  return /premium/i.test(text);
}

type TextRun = { text?: string };

type TooltipText = {
  simpleText?: string;
  runs?: TextRun[];
};

type TopbarLogo = {
  iconImage?: { iconType?: string };
  tooltipText?: TooltipText;
};

function tooltipText(node: TooltipText | undefined): string {
  if (!node) return "";
  if (typeof node.simpleText === "string") return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((run) => run.text ?? "").join("");
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Same signal yt-dlp uses: the youtube.com topbar logo / tooltip.
 * Full YouTube Premium only — YouTube Music Premium does not set this.
 */
export function youtubePremiumFromInitialData(data: unknown): boolean {
  const topbar = asRecord(asRecord(data)?.topbar);
  const desktop = asRecord(topbar?.desktopTopbarRenderer);
  const logo = asRecord(desktop?.logo);
  const renderer = asRecord(logo?.topbarLogoRenderer) as TopbarLogo | null;
  if (!renderer) return false;
  if (renderer.iconImage?.iconType === "YOUTUBE_PREMIUM_LOGO") return true;
  return /premium/i.test(tooltipText(renderer.tooltipText));
}

export function youtubePremiumFromMetaJson(text: string | null | undefined): boolean | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { premium?: unknown };
    return typeof parsed.premium === "boolean" ? parsed.premium : null;
  } catch {
    return null;
  }
}

import { describe, expect, it } from "bun:test";
import { youtubePremiumFromInitialData, youtubePremiumFromMetaJson } from "./youtube-premium";

function topbar(partial: {
  iconType?: string;
  tooltip?: string;
  tooltipRuns?: Array<{ text: string }>;
}) {
  return {
    topbar: {
      desktopTopbarRenderer: {
        logo: {
          topbarLogoRenderer: {
            ...(partial.iconType ? { iconImage: { iconType: partial.iconType } } : {}),
            ...(partial.tooltip
              ? { tooltipText: { simpleText: partial.tooltip } }
              : partial.tooltipRuns
                ? { tooltipText: { runs: partial.tooltipRuns } }
                : {}),
          },
        },
      },
    },
  };
}

describe("youtubePremiumFromInitialData", () => {
  it("detects a full YouTube Premium session from the topbar logo", () => {
    expect(youtubePremiumFromInitialData(topbar({ iconType: "YOUTUBE_PREMIUM_LOGO" }))).toBe(true);
  });

  it("detects Premium from the topbar tooltip when the icon is missing", () => {
    expect(youtubePremiumFromInitialData(topbar({ tooltip: "YouTube Premium" }))).toBe(true);
    expect(
      youtubePremiumFromInitialData(
        topbar({ tooltipRuns: [{ text: "YouTube " }, { text: "Premium" }] }),
      ),
    ).toBe(true);
  });

  it("does not treat a regular YouTube or Music-only session as Premium", () => {
    expect(youtubePremiumFromInitialData(topbar({ iconType: "YOUTUBE_LOGO" }))).toBe(false);
    expect(youtubePremiumFromInitialData(topbar({ tooltip: "YouTube Home" }))).toBe(false);
    expect(youtubePremiumFromInitialData({})).toBe(false);
    expect(youtubePremiumFromInitialData(null)).toBe(false);
  });
});

describe("youtubePremiumFromMetaJson", () => {
  it("reads the boolean the extension stored next to the cookie jar", () => {
    expect(youtubePremiumFromMetaJson('{"premium":true}')).toBe(true);
    expect(youtubePremiumFromMetaJson('{"premium":false}')).toBe(false);
  });

  it("treats a missing or unreadable file as unknown, not free", () => {
    expect(youtubePremiumFromMetaJson(null)).toBeNull();
    expect(youtubePremiumFromMetaJson("{")).toBeNull();
    expect(youtubePremiumFromMetaJson("{}")).toBeNull();
  });
});

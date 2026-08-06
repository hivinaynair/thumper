import { describe, expect, it } from "bun:test";
import {
  classifySoundCloudPurchaseUrl,
  ManualDownloadRequiredError,
  isManualDownloadRequiredError,
} from "./soundcloud-purchase";

describe("classifySoundCloudPurchaseUrl", () => {
  it("detects hypeddit hosts", () => {
    expect(
      classifySoundCloudPurchaseUrl(
        "https://hypeddit.com/ootoro/richbabydaddydub",
      ),
    ).toBe("hypeddit");
    expect(
      classifySoundCloudPurchaseUrl("https://www.hypeddit.com/tw73g5"),
    ).toBe("hypeddit");
  });

  it("flags other store / gate hosts as other", () => {
    expect(classifySoundCloudPurchaseUrl("https://gaterush.me/DZ7Tfq")).toBe(
      "other",
    );
    expect(
      classifySoundCloudPurchaseUrl(
        "https://artist.bandcamp.com/track/foo",
      ),
    ).toBe("other");
    expect(
      classifySoundCloudPurchaseUrl("https://droploud.com/x"),
    ).toBe("other");
  });
});

describe("ManualDownloadRequiredError", () => {
  it("carries the purchase URL", () => {
    const err = new ManualDownloadRequiredError(
      "https://gaterush.me/x",
      "Free Download",
    );
    expect(isManualDownloadRequiredError(err)).toBe(true);
    expect(err.manualDownloadUrl).toBe("https://gaterush.me/x");
    expect(err.message).toContain("https://gaterush.me/x");
  });
});

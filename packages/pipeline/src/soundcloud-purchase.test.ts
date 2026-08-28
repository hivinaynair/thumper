import { describe, expect, it } from "bun:test";
import {
  classifySoundCloudPurchaseUrl,
  extractSoundCloudGateUrls,
  ManualDownloadRequiredError,
  isManualDownloadRequiredError,
  pickPreferredSoundCloudPurchase,
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

  it("detects direct file hosts", () => {
    expect(
      classifySoundCloudPurchaseUrl(
        "https://www.dropbox.com/scl/fi/abc/track.wav?dl=0",
      ),
    ).toBe("direct");
  });

  it("detects browser-completed download gates", () => {
    expect(classifySoundCloudPurchaseUrl("https://gaterush.me/DZ7Tfq")).toBe(
      "browser-gate",
    );
    expect(
      classifySoundCloudPurchaseUrl("https://droploud.com/gate/abc"),
    ).toBe("browser-gate");
    expect(
      classifySoundCloudPurchaseUrl(
        "https://www.toneden.io/artist/post/track",
      ),
    ).toBe("browser-gate");
    expect(
      classifySoundCloudPurchaseUrl("https://laylo.com/tisoki/brostepforever"),
    ).toBe("browser-gate");
    expect(
      classifySoundCloudPurchaseUrl("https://pl8list.com/finnuh/bootleg"),
    ).toBe("browser-gate");
    expect(
      classifySoundCloudPurchaseUrl("https://app.hive.co/l/3rhhpm"),
    ).toBe("browser-gate");
    expect(
      classifySoundCloudPurchaseUrl(
        "https://danielallanmusic.vault.fm/drop/bandit-flip",
      ),
    ).toBe("browser-gate");
    expect(
      classifySoundCloudPurchaseUrl(
        "https://drop.cobrand.com/d/Zoey808/remixes",
      ),
    ).toBe("browser-gate");
    expect(
      classifySoundCloudPurchaseUrl(
        "https://pumpyoursound.com/f/hoang/space-laces/228062",
      ),
    ).toBe("browser-gate");
    expect(classifySoundCloudPurchaseUrl("https://ipln.io/vmMQ8L8E")).toBe(
      "browser-gate",
    );
    expect(
      classifySoundCloudPurchaseUrl(
        "https://influenceplanner.com/campaign/abc",
      ),
    ).toBe("browser-gate");
  });

  it("detects streaming smart links", () => {
    expect(
      classifySoundCloudPurchaseUrl("https://marshmello.ffm.to/dtmf"),
    ).toBe("stream");
    expect(classifySoundCloudPurchaseUrl("https://nm.ffm.to/talkabout")).toBe(
      "stream",
    );
    expect(
      classifySoundCloudPurchaseUrl(
        "https://listen.ukf.com/casey-club-voicenote-violence",
      ),
    ).toBe("stream");
  });

  it("flags paid store hosts as other", () => {
    expect(
      classifySoundCloudPurchaseUrl(
        "https://artist.bandcamp.com/track/foo",
      ),
    ).toBe("other");
    expect(
      classifySoundCloudPurchaseUrl("https://www.beatport.com/track/x/1"),
    ).toBe("other");
  });
});

describe("ManualDownloadRequiredError", () => {
  it("carries the purchase URL", () => {
    const err = new ManualDownloadRequiredError(
      "https://listen.ukf.com/x",
      "Stream",
    );
    expect(isManualDownloadRequiredError(err)).toBe(true);
    expect(err.manualDownloadUrl).toBe("https://listen.ukf.com/x");
    expect(err.message).toContain("https://listen.ukf.com/x");
  });
});

describe("extractSoundCloudGateUrls", () => {
  it("pulls Hypeddit and ToneDen links out of a SoundCloud description", () => {
    expect(
      extractSoundCloudGateUrls(
        "Free DL → https://hypeddit.com/remyheart/shmoneremyheartflip\nAlso https://www.toneden.io/aydo8/post/joey-valence-brae-jpegmafia-wassup-aydo8-flip",
      ),
    ).toEqual([
      "https://hypeddit.com/remyheart/shmoneremyheartflip",
      "https://www.toneden.io/aydo8/post/joey-valence-brae-jpegmafia-wassup-aydo8-flip",
    ]);
  });
});

describe("pickPreferredSoundCloudPurchase", () => {
  it("prefers a Hypeddit description URL over an InfluencePlanner purchase_url", () => {
    const picked = pickPreferredSoundCloudPurchase({
      purchaseUrl: "https://ipln.io/vmMQ8L8E",
      purchaseTitle: "Free Download",
      description:
        "DL: https://hypeddit.com/remyheart/shmoneremyheartflip",
    });
    expect(picked).toEqual({
      kind: "hypeddit",
      url: "https://hypeddit.com/remyheart/shmoneremyheartflip",
      title: "Free Download",
    });
  });

  it("uses a ToneDen description URL when purchase_url is empty", () => {
    const picked = pickPreferredSoundCloudPurchase({
      purchaseUrl: null,
      description:
        "https://www.toneden.io/aydo8/post/joey-valence-brae-jpegmafia-wassup-aydo8-flip",
    });
    expect(picked.kind).toBe("browser-gate");
    expect(picked.url).toContain("toneden.io");
  });
});

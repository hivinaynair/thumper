import { describe, expect, it } from "bun:test";
import {
  classifySoundCloudPurchaseUrl,
  ManualDownloadRequiredError,
  isManualDownloadRequiredError,
  soundCloudPurchaseApiUrl,
} from "./soundcloud-purchase";

describe("soundCloudPurchaseApiUrl", () => {
  it("fetches playlist children by track id instead of resolving the api-v2 URL", () => {
    const url = soundCloudPurchaseApiUrl(
      "https://api-v2.soundcloud.com/tracks/2218829702",
      "testclientid",
    );
    expect(url.pathname).toBe("/tracks/2218829702");
    expect(url.searchParams.get("client_id")).toBe("testclientid");
    expect(url.searchParams.get("url")).toBeNull();
  });

  it("still resolves permalinks through /resolve", () => {
    const url = soundCloudPurchaseApiUrl(
      "https://soundcloud.com/crankdat/work-crankdat-remix",
      "testclientid",
    );
    expect(url.pathname).toBe("/resolve");
    expect(url.searchParams.get("url")).toBe(
      "https://soundcloud.com/crankdat/work-crankdat-remix",
    );
  });
});

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

import { describe, expect, it } from "bun:test";
import {
  classifySoundCloudPurchaseUrl,
  ManualDownloadRequiredError,
  isManualDownloadRequiredError,
  pickPreferredSoundCloudPurchase,
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

describe("pickPreferredSoundCloudPurchase", () => {
  it("classifies the purchase_url", () => {
    expect(
      pickPreferredSoundCloudPurchase({
        purchaseUrl: "https://listen.ukf.com/casey-club-voicenote-violence",
        purchaseTitle: "Stream",
      }),
    ).toEqual({
      kind: "stream",
      url: "https://listen.ukf.com/casey-club-voicenote-violence",
      title: "Stream",
    });
  });

  it("ignores links in the description — they are artist links, not this track's source", () => {
    expect(
      pickPreferredSoundCloudPurchase({
        purchaseUrl: null,
        purchaseTitle: null,
      }),
    ).toEqual({ kind: "none" });
  });
});

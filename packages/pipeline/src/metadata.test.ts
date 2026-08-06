import { afterEach, describe, expect, it } from "bun:test";
import {
  fetchSoundCloudOEmbed,
  soundCloudOEmbedTarget,
  stripFreeDownloadLabel,
} from "./metadata";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("stripFreeDownloadLabel", () => {
  it("removes free DL / free download markers", () => {
    expect(stripFreeDownloadLabel("Swoon (free DL)")).toBe("Swoon");
    expect(stripFreeDownloadLabel("Swoon (Free Download)")).toBe("Swoon");
    expect(stripFreeDownloadLabel("Swoon [FREE DL]")).toBe("Swoon");
    expect(stripFreeDownloadLabel("Swoon - free download")).toBe("Swoon");
  });
});

describe("soundCloudOEmbedTarget", () => {
  it("rewrites the api-v2 track URLs yt-dlp emits for flat playlists", () => {
    // soundcloud.com/oembed 404s on api-v2 URLs but resolves api.soundcloud.com
    // ones — which is the only handle we have on a geo-blocked playlist entry.
    expect(
      soundCloudOEmbedTarget("https://api-v2.soundcloud.com/tracks/2243789501"),
    ).toBe("https://api.soundcloud.com/tracks/2243789501");
  });

  it("passes permalinks through untouched", () => {
    const permalink = "https://soundcloud.com/danielallantunes/take-me-under";
    expect(soundCloudOEmbedTarget(permalink)).toBe(permalink);
  });
});

describe("fetchSoundCloudOEmbed", () => {
  function stubOEmbed(payload: unknown) {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return calls;
  }

  it("splits SoundCloud's “Title by Artist” form", async () => {
    const calls = stubOEmbed({
      title: "Take Me Under by Daniel Allan",
      author_name: "Daniel Allan",
      thumbnail_url: "http://i1.sndcdn.com/artwork-t500x500.jpg",
    });

    const meta = await fetchSoundCloudOEmbed(
      "https://api-v2.soundcloud.com/tracks/2243789501",
    );

    expect(meta?.title).toBe("Take Me Under");
    expect(meta?.artist).toBe("Daniel Allan");
    expect(meta?.artworkUrl).toBe("https://i1.sndcdn.com/artwork-t500x500.jpg");
    expect(calls[0]).toContain("api.soundcloud.com%2Ftracks%2F2243789501");
  });

  it("only strips the trailing author, not a “by” inside the title", async () => {
    stubOEmbed({
      title: "Taken by the Tide by Oppidan",
      author_name: "Oppidan",
    });

    const meta = await fetchSoundCloudOEmbed(
      "https://soundcloud.com/oppidanmusic/taken-by-the-tide",
    );

    expect(meta?.title).toBe("Taken by the Tide");
    expect(meta?.artist).toBe("Oppidan");
  });

  it("returns null when SoundCloud has nothing for the URL", async () => {
    globalThis.fetch = (async () =>
      new Response("", { status: 404 })) as typeof fetch;
    expect(
      await fetchSoundCloudOEmbed("https://api-v2.soundcloud.com/tracks/1"),
    ).toBeNull();
  });
});

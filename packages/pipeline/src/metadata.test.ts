import { afterEach, describe, expect, it } from "bun:test";
import {
  artistNamesFromInfo,
  fetchSoundCloudOEmbed,
  soundCloudOEmbedTarget,
  stripFreeDownloadLabel,
  isMusicEntry,
  pillarboxColumns,
  stripTopicSuffix,
  youtubeMusicTagsFromInfo,
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

describe("stripTopicSuffix", () => {
  it("removes YouTube's auto-generated channel suffix", () => {
    expect(stripTopicSuffix("MPH - Topic")).toBe("MPH");
    expect(stripTopicSuffix("Lou Nour – Topic")).toBe("Lou Nour");
  });

  it("leaves a real name containing the word alone", () => {
    expect(stripTopicSuffix("Topic")).toBe("Topic");
    expect(stripTopicSuffix("Topic - Breaking Me")).toBe("Topic - Breaking Me");
  });
});

describe("artistNamesFromInfo", () => {
  it("strips the Topic suffix off the uploader fallback", () => {
    expect(artistNamesFromInfo({ uploader: "MPH - Topic" })).toEqual(["MPH"]);
  });

  // Real dump: yt-dlp repeated the credit once per release, and the tag came
  // out "Oscar Wallyn, oscar wallyn, oscar wallyn".
  it("dedupes a credit repeated in different cases, keeping the first casing", () => {
    expect(
      artistNamesFromInfo({
        artists: ["Oscar Wallyn", "oscar wallyn", "oscar wallyn"],
      }),
    ).toEqual(["Oscar Wallyn"]);
  });

  it("dedupes across the separator split too", () => {
    expect(artistNamesFromInfo({ artist: "WINK, wink, borne" })).toEqual([
      "WINK",
      "borne",
    ]);
  });

  it("keeps genuinely different artists in order", () => {
    expect(artistNamesFromInfo({ artists: ["WINK", "borne"] })).toEqual([
      "WINK",
      "borne",
    ]);
  });

  it("ignores surrounding whitespace when comparing", () => {
    expect(artistNamesFromInfo({ artists: ["MPH", " mph "] })).toEqual(["MPH"]);
  });
});

describe("youtubeMusicTagsFromInfo", () => {
  // Fields copied from a real yt-dlp dump of a Topic-channel upload.
  const topic = {
    title: "Shoot To Kill",
    track: "Shoot To Kill",
    artists: ["MPH"],
    uploader: "MPH - Topic",
    album: "Refraction",
    release_date: "20240823",
    thumbnail: "https://i.ytimg.com/vi/YYK_nRLiutM/maxresdefault.jpg",
  };

  it("reads the label-supplied credits off a Topic upload", () => {
    const tags = youtubeMusicTagsFromInfo(topic);
    expect(tags).toMatchObject({
      title: "Shoot To Kill",
      artist: "MPH",
      album: "Refraction",
      date: "2024-08-23",
      source: "youtube-music",
      artworkNeedsSquareCrop: true,
    });
  });

  it("refuses a normal YouTube upload", () => {
    // A video frame is not cover art, so these must keep falling through.
    expect(
      youtubeMusicTagsFromInfo({
        title: "my dj set at the beach",
        uploader: "Some Guy",
        thumbnail: "https://i.ytimg.com/vi/abc/maxresdefault.jpg",
      }),
    ).toBeNull();
  });

  it("leaves the title unset when the dump has none, so the hint wins", () => {
    const tags = youtubeMusicTagsFromInfo({ uploader: "MPH - Topic" });
    expect(tags?.artist).toBe("MPH");
    expect(tags?.title).toBeUndefined();
  });
});

describe("isMusicEntry", () => {
  it("accepts a Topic channel", () => {
    expect(isMusicEntry({ uploader: "MPH - Topic" })).toBe(true);
  });

  it("accepts an Official Artist Channel carrying release metadata", () => {
    // These were silently skipped and came out with no artwork at all.
    expect(
      isMusicEntry({ uploader: "Oppidan", album: "Gravity" }),
    ).toBe(true);
    expect(
      isMusicEntry({ uploader: "Oppidan", artists: ["Oppidan"] }),
    ).toBe(true);
  });

  it("refuses an ordinary upload", () => {
    expect(isMusicEntry({ uploader: "Some Guy", title: "my dj set" })).toBe(
      false,
    );
  });
});

describe("pillarboxColumns", () => {
  const W = 64;
  const H = 36;

  function raster(fill: (x: number, y: number) => number): Uint8Array {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) out[y * W + x] = fill(x, y);
    return out;
  }

  it("measures the flat border of pillarboxed cover art", () => {
    // Square art centred on 16:9 leaves ~14 flat columns each side.
    const bars = raster((x, y) =>
      x < 14 || x >= W - 14 ? 49 : 60 + ((x * 7 + y * 13) % 150),
    );
    expect(pillarboxColumns(bars, W, H)).toBeGreaterThanOrEqual(13);
  });

  it("reports none for a real video frame", () => {
    expect(
      pillarboxColumns(
        raster((x, y) => 40 + ((x * 11 + y * 17) % 180)),
        W,
        H,
      ),
    ).toBe(0);
  });

  it("ignores a flat edge on only one side", () => {
    // A dark scene edge is not a pillarbox; cropping it would cut the image.
    const oneSide = raster((x, y) => (x < 14 ? 49 : 60 + ((x * 7 + y * 13) % 150)));
    expect(pillarboxColumns(oneSide, W, H)).toBe(0);
  });
});

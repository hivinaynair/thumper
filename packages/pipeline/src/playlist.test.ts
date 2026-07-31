import { describe, expect, it } from "bun:test";
import { nameSoundCloudEntries, type PlaylistEntry } from "./playlist";

describe("nameSoundCloudEntries", () => {
  // yt-dlp only hydrates the first few entries of a SoundCloud set; the rest
  // come back as bare api-v2 URLs with no title. Those unnamed entries are
  // exactly the ones a DRM/geo failure has to describe later, so name them up
  // front rather than shipping "?  – track" into the mirror search.
  const entries: PlaylistEntry[] = [
    { url: "https://soundcloud.com/oscar-wallyn/una-una", title: "UNA UNA" },
    { url: "https://api-v2.soundcloud.com/tracks/2243789501" },
    { url: "https://api-v2.soundcloud.com/tracks/1104059689" },
  ];

  it("fills in titles and artists for unnamed entries", async () => {
    const named = await nameSoundCloudEntries(entries, {
      lookup: async (url) =>
        url.endsWith("2243789501")
          ? { title: "Take Me Under", artist: "Daniel Allan" }
          : { title: "Gravity", artist: "Oppidan" },
    });

    expect(named).toEqual([
      { url: "https://soundcloud.com/oscar-wallyn/una-una", title: "UNA UNA" },
      {
        url: "https://api-v2.soundcloud.com/tracks/2243789501",
        title: "Take Me Under",
        artist: "Daniel Allan",
      },
      {
        url: "https://api-v2.soundcloud.com/tracks/1104059689",
        title: "Gravity",
        artist: "Oppidan",
      },
    ]);
  });

  it("names unhydrated permalink entries too", async () => {
    const named = await nameSoundCloudEntries(
      [{ url: "https://soundcloud.com/oscar-wallyn/una-una" }],
      { lookup: async () => ({ title: "UNA UNA", artist: "Oscar Wallyn" }) },
    );
    expect(named[0]).toEqual({
      url: "https://soundcloud.com/oscar-wallyn/una-una",
      title: "UNA UNA",
      artist: "Oscar Wallyn",
    });
  });

  it("leaves non-SoundCloud entries alone", async () => {
    const youtube = [{ url: "https://www.youtube.com/watch?v=abc" }];
    const looked: string[] = [];
    const named = await nameSoundCloudEntries(youtube, {
      lookup: async (url) => {
        looked.push(url);
        return { title: "nope" };
      },
    });
    expect(looked).toEqual([]);
    expect(named).toEqual(youtube);
  });

  it("never looks up an entry yt-dlp already named", async () => {
    const looked: string[] = [];
    await nameSoundCloudEntries(entries, {
      lookup: async (url) => {
        looked.push(url);
        return null;
      },
    });
    expect(looked).not.toContain("https://soundcloud.com/oscar-wallyn/una-una");
    expect(looked).toHaveLength(2);
  });

  it("keeps the playlist intact when lookups fail", async () => {
    const named = await nameSoundCloudEntries(entries, {
      lookup: async () => {
        throw new Error("oembed down");
      },
    });
    expect(named).toEqual(entries);
  });
});

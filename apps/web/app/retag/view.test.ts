import { expect, test } from "bun:test";
import { retagStatus, validMetadataUrl } from "./view";

test("accepts track links and rejects unrelated, unsafe and playlist URLs", () => {
  expect(validMetadataUrl(" https://soundcloud.com/artist/track ")).toBe(
    "https://soundcloud.com/artist/track",
  );
  expect(validMetadataUrl("https://open.spotify.com/track/abc123?si=test")).not.toBeNull();
  for (const value of [
    "javascript:alert(1)",
    "https://soundcloud.com.evil.test/a/b",
    "https://soundcloud.com/artist/sets/album",
    "https://open.spotify.com/playlist/abc",
    "https://example.com",
    "",
  ])
    expect(validMetadataUrl(value)).toBeNull();
});

test("explains actual retag stages and terminal states", () => {
  expect(retagStatus("uploading").title).toBe("Uploading your audio");
  expect(retagStatus("searching").title).toBe("Finding matching track details");
  expect(retagStatus("converting", "resolving", "running").title).toBe("Fetching track details");
  expect(retagStatus("converting", "converting", "running").title).toBe(
    "Updating tags and converting audio",
  );
  expect(retagStatus("converting", "delivering", "running").title).toBe("Saving your updated file");
  expect(retagStatus("converting", "error", "failed").title).toBe("Needs attention");
});

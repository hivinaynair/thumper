import { describe, expect, it } from "bun:test";
import {
  downloadPayloadFromJob,
  playlistContextForChild,
  requeueFields,
} from "./retry-job";

describe("requeueFields", () => {
  it("clears failure so the worker can pick the job up again", () => {
    const patch = requeueFields();
    expect(patch.status).toBe("queued");
    expect(patch.stage).toBe("queued");
    expect(patch.progress).toBe(0);
    expect(patch.error).toBeNull();
    expect(patch.completedAt).toBeNull();
    expect(patch.pgBossId).toBeNull();
  });
});

describe("downloadPayloadFromJob", () => {
  it("prefers the matched mirror URL and keeps playlist Drive + gate flags", () => {
    expect(
      downloadPayloadFromJob({
        id: "child-1",
        userId: "user-1",
        sourceUrl: "https://open.spotify.com/track/abc",
        matchedUrl: "https://www.youtube.com/watch?v=xyz",
        title: "Voicenote Violence",
        artist: "Casey Club",
        audioFormat: "flac",
        destination: "drive",
        result: {
          gateEmail: "hi@vinaynair.dev",
          gateName: "Vinay",
          clubReadyOnly: true,
          driveFolderId: "folder-uk-140",
          parentJobId: "uk-140",
        },
      }),
    ).toEqual({
      jobId: "child-1",
      userId: "user-1",
      url: "https://www.youtube.com/watch?v=xyz",
      audioFormat: "flac",
      destination: "drive",
      titleHint: "Voicenote Violence",
      artistHint: "Casey Club",
      gateEmail: "hi@vinaynair.dev",
      gateName: "Vinay",
      clubReadyOnly: true,
      freeDownloadsOnly: false,
      driveFolderId: "folder-uk-140",
      parentJobId: "uk-140",
    });
  });
});

describe("playlistContextForChild", () => {
  it("recovers parent id and Drive folder from the playlist parent row", () => {
    expect(
      playlistContextForChild("fail-a", [
        {
          id: "uk-140",
          title: "UK 140",
          result: {
            playlist: true,
            childJobIds: ["ok", "fail-a"],
            driveFolderId: "folder-uk-140",
          },
        },
        {
          id: "fail-a",
          title: "Voicenote Violence",
          result: { clubReadyOnly: true },
        },
      ]),
    ).toEqual({
      parentJobId: "uk-140",
      driveFolderId: "folder-uk-140",
    });
  });

  it("prefers a folder id already stored on the child", () => {
    expect(
      playlistContextForChild("fail-a", [
        {
          id: "uk-140",
          title: "UK 140",
          result: { playlist: true, childJobIds: ["fail-a"] },
        },
        {
          id: "fail-a",
          title: "Voicenote Violence",
          result: { driveFolderId: "child-folder" },
        },
      ]),
    ).toEqual({
      parentJobId: "uk-140",
      driveFolderId: "child-folder",
    });
  });
});

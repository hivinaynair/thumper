export function validMetadataUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!["https:", "http:"].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    const path = url.pathname.split("/").filter(Boolean);
    if (
      (host === "soundcloud.com" || host === "www.soundcloud.com") &&
      path.length === 2 &&
      !["sets", "likes", "tracks", "albums", "reposts"].includes(path[1]!)
    )
      return url.href;
    if (
      host === "open.spotify.com" &&
      /^(?:\/intl-[a-z]+)?\/track\/[a-zA-Z0-9]+\/?$/.test(url.pathname)
    )
      return url.href;
    return null;
  } catch {
    return null;
  }
}

export function retagStatus(
  phase: string,
  stage?: string,
  status?: string,
  error = false,
): { title: string; detail: string } {
  if (error || status === "failed" || phase === "error")
    return { title: "Needs attention", detail: "This file couldn’t be updated." };
  if (status === "completed")
    return {
      title: "Your updated FLAC is ready",
      detail: "Title, artist and artwork have been saved.",
    };
  if (status === "cancelled") return { title: "Cancelled", detail: "" };
  if (phase === "waiting")
    return {
      title: "Waiting to upload",
      detail: "This file will upload after the files ahead of it.",
    };
  if (phase === "uploading")
    return {
      title: "Uploading your audio",
      detail: "Sending your file securely. Keep this page open until the upload finishes.",
    };
  if (phase === "searching")
    return {
      title: "Finding matching track details",
      detail:
        "Searching SoundCloud using your filename for a title, artist and artwork. The first search can take longer while the service starts.",
    };
  if (phase === "ready") return { title: "Review match", detail: "" };
  if (stage === "resolving")
    return {
      title: "Fetching track details",
      detail: "Reading the title, artist and artwork from your selected track link.",
    };
  if (stage === "converting")
    return {
      title: "Updating tags and converting audio",
      detail: "Converting your uploaded audio to FLAC and embedding its track details and artwork.",
    };
  if (stage === "delivering" || stage === "cleanup")
    return {
      title: "Saving your updated file",
      detail: "Saving the finished FLAC to your chosen destination.",
    };
  return {
    title: "Waiting to start",
    detail:
      "Your file is queued. Processing starts when a worker is available; wait time depends on the queue and file size.",
  };
}

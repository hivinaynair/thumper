export type ArtistOriginalAction =
  | "convert-wav"
  | "preserve-original"
  | "tag-mp3"
  | "normal-conversion";

export function artistOriginalAction({
  artistOriginal,
  extension,
  hasAttachedArtwork,
}: {
  artistOriginal: boolean;
  extension: string;
  hasAttachedArtwork?: boolean;
}): ArtistOriginalAction {
  if (!artistOriginal) return "normal-conversion";

  const normalizedExtension = extension.toLowerCase().replace(/^\./, "");
  if (normalizedExtension === "wav") return "convert-wav";
  if (normalizedExtension === "mp3" && hasAttachedArtwork === false) {
    return "tag-mp3";
  }
  return "preserve-original";
}

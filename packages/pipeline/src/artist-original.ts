export function artistOriginalAction({
  artistOriginal,
  extension,
}: {
  artistOriginal: boolean;
  extension: string;
}): "convert-wav" | "preserve-original" | "normal-conversion" {
  if (!artistOriginal) return "normal-conversion";

  const normalizedExtension = extension.toLowerCase().replace(/^\./, "");
  return normalizedExtension === "wav" ? "convert-wav" : "preserve-original";
}

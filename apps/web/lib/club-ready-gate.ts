export function clubReadyAllowed(youtubePremium: boolean | null | undefined): boolean {
  return youtubePremium === true;
}

export function clubReadyOnlyRejected(
  clubReadyOnly: boolean,
  youtubePremium: boolean | null | undefined,
): string | null {
  if (!clubReadyOnly || clubReadyAllowed(youtubePremium)) return null;
  return "Club-ready only needs a synced YouTube Premium session";
}

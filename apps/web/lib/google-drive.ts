import { auth, clerkClient } from "@clerk/nextjs/server";
import { oauthScopesIncludeDrive } from "@thumper/shared";

export async function userHasGoogleDriveAccess(
  userId?: string | null,
): Promise<boolean> {
  const id = userId ?? (await auth()).userId;
  if (!id) return false;

  try {
    const client = await clerkClient();
    const res = await client.users.getUserOauthAccessToken(id, "google");
    const entry = res.data[0];
    if (!entry?.token) return false;
    const scopes = entry.scopes ?? [];
    if (scopes.length === 0) return true;
    return oauthScopesIncludeDrive(scopes);
  } catch {
    return false;
  }
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProcessCancelledError, type PlaylistEntry } from "@thumper/pipeline";
import { detectSourceKind, type DownloadJobPayload } from "@thumper/shared";

export const PLAYLIST_FANOUT_DIR = "/tmp/thumper-fanout";

export type PlaylistChildKind = "youtube" | "soundcloud";

export type ChildJobResult = {
  parentJobId: string;
  driveFolderId?: string;
  gateEmail?: string;
  gateName?: string;
  freeDownloadsOnly?: boolean;
  clubReadyOnly?: boolean;
};

export function childJobResult(
  parent: DownloadJobPayload,
  context?: { driveFolderId?: string },
): ChildJobResult {
  return {
    parentJobId: parent.jobId,
    ...(context?.driveFolderId ? { driveFolderId: context.driveFolderId } : {}),
    ...(parent.gateEmail
      ? { gateEmail: parent.gateEmail, gateName: parent.gateName }
      : {}),
    ...(parent.freeDownloadsOnly ? { freeDownloadsOnly: true } : {}),
    ...(parent.clubReadyOnly ? { clubReadyOnly: true } : {}),
  };
}

export function fanoutIdsFromCompletedParent(row: {
  status: string;
  result?: { playlist?: boolean; childJobIds?: unknown } | null;
}): string[] {
  if (row.status !== "completed" || !row.result?.playlist) return [];
  const ids = row.result.childJobIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export async function writeFanoutChildIds(
  parentJobId: string,
  childJobIds: string[],
  directory = PLAYLIST_FANOUT_DIR,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, `${parentJobId}.json`),
    JSON.stringify({ childJobIds }),
    { mode: 0o600 },
  );
}

function trackKind(
  url: string,
  parentUrl: string,
): PlaylistChildKind | null {
  const kind = detectSourceKind(url) ?? detectSourceKind(parentUrl);
  if (kind === "youtube" || kind === "soundcloud") return kind;
  return null;
}

export async function enqueuePlaylistChildren(params: {
  parent: DownloadJobPayload;
  tracks: PlaylistEntry[];
  context?: { driveFolderId?: string };
  signal?: AbortSignal;
  insertChild: (input: {
    kind: PlaylistChildKind;
    track: PlaylistEntry;
    result: ChildJobResult;
  }) => Promise<{ id: string } | null>;
  publishChildIds: (childIds: string[]) => Promise<void>;
  cancelChildren: (ids: string[]) => Promise<void>;
  onInsertError?: (err: unknown, url: string) => void;
}): Promise<string[]> {
  const childIds: string[] = [];
  const result = childJobResult(params.parent, params.context);

  const abort = async () => {
    if (childIds.length > 0) await params.cancelChildren(childIds);
    throw new ProcessCancelledError();
  };

  for (const track of params.tracks) {
    if (params.signal?.aborted) await abort();

    const kind = trackKind(track.url, params.parent.url);
    if (!kind) continue;

    try {
      const child = await params.insertChild({ kind, track, result });
      if (!child) continue;
      childIds.push(child.id);
      await params.publishChildIds([...childIds]);
    } catch (err) {
      if (err instanceof ProcessCancelledError || params.signal?.aborted) {
        await abort();
      }
      params.onInsertError?.(err, track.url);
    }
  }

  if (params.signal?.aborted) await abort();
  return childIds;
}

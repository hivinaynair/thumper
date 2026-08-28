import type { DownloadJobPayload } from "@thumper/shared";

export type JobResultMeta = {
  playlist?: boolean;
  childJobIds?: string[];
  driveFolderId?: string;
  parentJobId?: string;
  gateEmail?: string;
  gateName?: string;
  freeDownloadsOnly?: boolean;
  clubReadyOnly?: boolean;
};

export type StoredJobRow = {
  id: string;
  userId: string;
  sourceUrl: string;
  matchedUrl: string | null;
  title: string | null;
  artist: string | null;
  audioFormat: string;
  destination: DownloadJobPayload["destination"];
  result: JobResultMeta | null;
};

export function requeueFields(): {
  status: "queued";
  stage: "queued";
  progress: 0;
  error: null;
  completedAt: null;
  pgBossId: null;
} {
  return {
    status: "queued",
    stage: "queued",
    progress: 0,
    error: null,
    completedAt: null,
    pgBossId: null,
  };
}

export function downloadPayloadFromJob(
  row: StoredJobRow,
): DownloadJobPayload {
  const result = row.result ?? {};
  return {
    jobId: row.id,
    userId: row.userId,
    url: row.matchedUrl || row.sourceUrl,
    audioFormat: "flac",
    destination: row.destination,
    titleHint: row.title ?? undefined,
    artistHint: row.artist ?? undefined,
    gateEmail: result.gateEmail,
    gateName: result.gateName,
    clubReadyOnly: Boolean(result.clubReadyOnly),
    freeDownloadsOnly: Boolean(result.freeDownloadsOnly),
    ...(result.driveFolderId ? { driveFolderId: result.driveFolderId } : {}),
    ...(result.parentJobId ? { parentJobId: result.parentJobId } : {}),
  };
}

export function playlistContextForChild(
  childId: string,
  jobs: Array<{
    id: string;
    title?: string | null;
    result?: JobResultMeta | null;
  }>,
): { parentJobId?: string; driveFolderId?: string } {
  const child = jobs.find((row) => row.id === childId);
  const parent = jobs.find((row) =>
    row.result?.childJobIds?.includes(childId),
  );
  return {
    ...(parent ? { parentJobId: parent.id } : {}),
    driveFolderId:
      child?.result?.driveFolderId || parent?.result?.driveFolderId,
  };
}

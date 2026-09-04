"use client";

import { detectSourceKind, trackDisplayName } from "@thumper/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cookieNeedsRefresh,
  jobsToRetry,
  retryButtonLabel,
} from "../../lib/cookie-retry";
import { COOKIE_SYNC_EXTENSION_VERSION } from "./cookie-sync";
import { HYPEDDIT_ORIGINAL_COPY } from "./result-copy";

type DjTier = "master" | "club" | "marginal" | "unsuitable";

const CLUB_READY_KEY = "thumper.clubReadyOnly";

type Job = {
  id: string;
  status: string;
  stage: string;
  progress: number;
  sourceUrl: string;
  matchedUrl?: string | null;
  title?: string | null;
  artist?: string | null;
  audioFormat: string;
  destination: string;
  error?: string | null;
  result?: {
    fileId?: string;
    driveUrl?: string;
    qualityLabel?: string;
    playlist?: boolean;
    trackCount?: number;
    childJobIds?: string[];
    unmatchedCount?: number;
    matchScore?: number;
    djTier?: DjTier;
    djHeadline?: string;
    warnings?: string[];
    cutoffHz?: number;
    sourceFormatId?: string;
    /** SoundCloud free-download / original upload (`format_id=download`). */
    soundcloudOriginal?: boolean;
    /** Hypeddit artist original; WAV is tagged FLAC, other formats unchanged. */
    hypedditOriginal?: boolean;
    /** Non-Hypeddit purchase link — open and download manually. */
    manualDownloadUrl?: string;
    manualDownloadTitle?: string | null;
    freeDownloadsOnly?: boolean;
    clubReadyOnly?: boolean;
    qualityRejected?: boolean;
  } | null;
};

const TIER_LABEL: Record<DjTier, string> = {
  master: "Master quality",
  club: "Club-ready",
  marginal: "Marginal quality",
  unsuitable: "Not for club playback",
};

/**
 * The verdict headline already leads with its tier ("Marginal — lossy source,
 * rolls off at 18.2 kHz"), so emphasise that lead rather than prefixing a second
 * label and printing the word twice.
 */
function QualityBadge({ tier, headline }: { tier: DjTier; headline?: string }) {
  const [lead, ...rest] = (headline || TIER_LABEL[tier]).split(" — ");
  return (
    <div className={`quality-badge ${tier}`}>
      <strong>{lead}</strong>
      {rest.length ? ` — ${rest.join(" — ")}` : ""}
    </div>
  );
}

type CookieProviderStatus = {
  present: boolean;
  updatedAt: string | null;
};

type CookieStatus = {
  youtube: CookieProviderStatus;
  soundcloud: CookieProviderStatus;
  spotify: CookieProviderStatus;
};

type SyncResult = {
  ok?: boolean;
  error?: string;
  message?: string;
  version?: string;
  results?: {
    youtube?: { status: string; reason?: string };
    soundcloud?: { status: string; reason?: string };
    spotify?: { status: string; reason?: string };
  };
};

type PlaylistRollup = {
  total: number;
  done: number;
  failed: number;
  pending: number;
  failedTracks: Job[];
};

function jobLabel(job: Job): string {
  if (job.title || job.artist) return trackDisplayName(job.artist, job.title);
  return job.sourceUrl;
}

/**
 * A playlist parent finishes as soon as its tracks are queued, so the only
 * honest progress report is the live state of its children.
 */
function playlistRollup(
  job: Job,
  byId: Map<string, Job>,
): PlaylistRollup | null {
  if (!job.result?.playlist) return null;
  const children = (job.result.childJobIds ?? [])
    .map((id) => byId.get(id))
    .filter((child): child is Job => Boolean(child));
  if (children.length === 0) return null;

  const failedTracks = children.filter(
    (child) => child.status === "failed" || child.status === "cancelled",
  );
  const done = children.filter((child) => child.status === "completed").length;
  return {
    total: children.length,
    done,
    failed: failedTracks.length,
    pending: children.length - done - failedTracks.length,
    failedTracks,
  };
}

function rollupSummary(rollup: PlaylistRollup): string {
  const parts = [`${rollup.done}/${rollup.total} downloaded`];
  if (rollup.failed) parts.push(`${rollup.failed} failed`);
  if (rollup.pending) parts.push(`${rollup.pending} in progress`);
  return parts.join(" · ");
}

/** Mark cookies stale after this — Google rotates sessions often. */
const COOKIE_STALE_MS = 12 * 60 * 60 * 1000;

function formatSyncedAt(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatSyncedAge(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function isCookieStale(iso: string | null): boolean {
  if (!iso) return false;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) && ms >= COOKIE_STALE_MS;
}

function cookiesReadyForUrl(
  url: string,
  cookies: CookieStatus | null,
): { ready: boolean; reason: string | null } {
  if (!cookies) {
    return { ready: false, reason: "Checking cookie sync…" };
  }
  const kind = url.trim() ? detectSourceKind(url.trim()) : null;
  if (
    !kind ||
    (kind !== "youtube" && kind !== "soundcloud" && kind !== "spotify")
  ) {
    if (!cookies.youtube.present && !cookies.soundcloud.present) {
      return {
        ready: false,
        reason: "Sync cookies with the Chrome extension before queuing",
      };
    }
    return { ready: true, reason: null };
  }
  if (kind === "youtube" && !cookies.youtube.present) {
    return {
      ready: false,
      reason: "Sync YouTube cookies before queuing YouTube downloads",
    };
  }
  if (kind === "soundcloud" && !cookies.soundcloud.present) {
    return {
      ready: false,
      reason: "Sync SoundCloud cookies before queuing SoundCloud downloads",
    };
  }
  if (kind === "soundcloud" && !cookies.youtube.present) {
    return {
      ready: true,
      reason:
        "Tip: sync YouTube cookies too — after free downloads, SoundCloud tracks prefer YouTube mirrors",
    };
  }
  if (
    kind === "spotify" &&
    !cookies.youtube.present &&
    !cookies.soundcloud.present
  ) {
    return {
      ready: false,
      reason:
        "Sync YouTube or SoundCloud cookies before queuing Spotify mirrors",
    };
  }
  if (
    (kind === "youtube" || kind === "soundcloud" || kind === "spotify") &&
    cookies.youtube.present &&
    isCookieStale(cookies.youtube.updatedAt)
  ) {
    return {
      ready: true,
      reason:
        "YouTube cookies look stale — hit Refresh so Modal isn’t stuck with a rotated session",
    };
  }
  return { ready: true, reason: null };
}

function requestExtensionSync(timeoutMs = 45000): Promise<SyncResult> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({
        ok: false,
        error:
          "No response from the Thumper extension. Install/reload it, then try again.",
      });
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      const data = event.data as SyncResult & {
        source?: string;
        type?: string;
        requestId?: string;
      };
      if (
        data?.source !== "thumper-extension" ||
        data.type !== "sync-cookies-result" ||
        data.requestId !== requestId
      ) {
        return;
      }
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(data);
    }

    window.addEventListener("message", onMessage);
    window.postMessage(
      { source: "thumper-page", type: "sync-cookies", requestId },
      window.location.origin,
    );
  });
}

export default function DownloaderPage() {
  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState("browser");
  const [freeDownloadsOnly, setFreeDownloadsOnly] = useState(false);
  const [clubReadyOnly, setClubReadyOnly] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [cookies, setCookies] = useState<CookieStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"ok" | "error">("ok");
  const [extensionReady, setExtensionReady] = useState(false);
  const extensionReadyRef = useRef(false);

  useEffect(() => {
    extensionReadyRef.current = extensionReady;
  }, [extensionReady]);

  // Read after mount, not in the initializer: this page renders on the server
  // and touching localStorage during render would break hydration.
  useEffect(() => {
    setClubReadyOnly(window.localStorage.getItem(CLUB_READY_KEY) === "true");
  }, []);

  const refreshJobs = useCallback(async () => {
    const res = await fetch("/api/jobs");
    if (!res.ok) return;
    const data = await res.json();
    setJobs(data.jobs ?? []);
  }, []);

  const refreshCookies = useCallback(async () => {
    const res = await fetch("/api/cookies");
    if (!res.ok) return;
    const data = await res.json();
    setCookies(data.cookies ?? null);
  }, []);

  useEffect(() => {
    void refreshJobs();
    void refreshCookies();
    const jobsTimer = setInterval(() => void refreshJobs(), 1500);
    const cookiesTimer = setInterval(() => void refreshCookies(), 3000);
    const onFocus = () => void refreshCookies();
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as {
        source?: string;
        type?: string;
        version?: string;
      };
      if (
        data?.source === "thumper-extension" &&
        data.type === "extension-ready"
      ) {
        setExtensionReady(true);
      }
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("message", onMessage);

    const ping = () => {
      if (extensionReadyRef.current) return;
      window.postMessage(
        { source: "thumper-page", type: "ping" },
        window.location.origin,
      );
    };
    ping();
    const pingTimer = window.setInterval(ping, 2000);
    return () => {
      clearInterval(jobsTimer);
      clearInterval(cookiesTimer);
      clearInterval(pingTimer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("message", onMessage);
    };
  }, [refreshJobs, refreshCookies]);

  const rollups = useMemo(() => {
    const byId = new Map(jobs.map((job) => [job.id, job]));
    const entries = jobs.flatMap((job) => {
      const rollup = playlistRollup(job, byId);
      return rollup ? [[job.id, rollup] as const] : [];
    });
    return new Map(entries);
  }, [jobs]);
  const gate = useMemo(() => cookiesReadyForUrl(url, cookies), [url, cookies]);
  const canQueue = !busy && gate.ready;
  const finishedCount = jobs.filter(
    (job) =>
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled",
  ).length;
  const downloadableCount = jobs.filter(
    (job) => job.status === "completed" && job.result?.fileId,
  ).length;

  async function createJob(e: React.FormEvent) {
    e.preventDefault();
    if (!canQueue) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          audioFormat: "flac",
          destination,
          freeDownloadsOnly,
          clubReadyOnly,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setUrl("");
      await refreshJobs();
    } catch (err) {
      setMessageTone("error");
      setMessage(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancelJob(id: string) {
    await fetch(`/api/jobs/${id}`, { method: "DELETE" });
    await refreshJobs();
  }

  async function clearFinishedJobs() {
    setClearing(true);
    try {
      const res = await fetch("/api/jobs", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to clear jobs");
      await refreshJobs();
    } catch (err) {
      setMessageTone("error");
      setMessage(err instanceof Error ? err.message : "Failed to clear jobs");
    } finally {
      setClearing(false);
    }
  }

  async function syncCookies() {
    setSyncing(true);
    setMessage(null);
    try {
      const result = await requestExtensionSync();
      if (!result.ok) {
        setMessageTone("error");
        setMessage(result.error || result.message || "Cookie refresh failed");
        return;
      }
      setMessageTone("ok");
      setMessage(result.message || "Cookies refreshed");
      await refreshCookies();
    } finally {
      setSyncing(false);
    }
  }

  async function retryWithNewCookies(jobId: string) {
    setRetryingId(jobId);
    setMessage(null);
    try {
      if (extensionReady) {
        const result = await requestExtensionSync();
        if (result.ok) {
          await refreshCookies();
        }
      }
      const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        retried?: number;
      };
      if (!res.ok) throw new Error(data.error ?? "Retry failed");
      setMessageTone("ok");
      setMessage(
        data.retried === 1
          ? "Retrying with new cookies"
          : `Retrying ${data.retried} tracks with new cookies`,
      );
      await refreshJobs();
    } catch (err) {
      setMessageTone("error");
      setMessage(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetryingId(null);
    }
  }

  const anyCookiesPresent = Boolean(
    cookies?.youtube.present ||
    cookies?.soundcloud.present ||
    cookies?.spotify.present,
  );
  const youtubeStale =
    Boolean(cookies?.youtube.present) &&
    isCookieStale(cookies?.youtube.updatedAt ?? null);
  const failedNeedRefresh = jobs.some(
    (job) => job.status === "failed" && cookieNeedsRefresh(job.error),
  );

  return (
    <main>
      <div className="stack">
        <header className="page-head">
          <div className="page-head-main">
            <h1>Downloader</h1>
          </div>
          <aside
            className="cookie-sync"
            title="Your synced Spotify session authorizes the real follow/save requested by Hypeddit gates."
          >
            <p className="cookie-sync-disclosure">
              Your synced Spotify session authorizes the real follow/save
              requested by Hypeddit gates.
            </p>
            <div className="cookie-sync-top">
              <span className="cookie-sync-label">Cookies</span>
              <ul className="cookie-sync-list">
                {(
                  [
                    ["youtube", "YT"],
                    ["soundcloud", "SC"],
                    ["spotify", "SP"],
                  ] as const
                ).map(([key, label]) => {
                  const status = cookies?.[key];
                  const present = status?.present ?? false;
                  const stale =
                    present && isCookieStale(status?.updatedAt ?? null);
                  const age = formatSyncedAge(status?.updatedAt ?? null);
                  return (
                    <li
                      key={key}
                      className={`cookie-sync-chip${present ? (stale ? " is-stale" : " is-synced") : " is-missing"}`}
                      title={
                        present
                          ? `${stale ? "Stale — " : ""}Updated ${formatSyncedAt(status?.updatedAt ?? null)}`
                          : "Not synced yet"
                      }
                    >
                      <span className="cookie-sync-dot" aria-hidden="true" />
                      {label}
                      {present && age ? (
                        <span className="cookie-sync-age">{age}</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                className={`cookie-sync-btn${youtubeStale || failedNeedRefresh ? " is-urgent" : ""}`}
                onClick={() => void syncCookies()}
                disabled={syncing || !extensionReady}
              >
                {syncing
                  ? "Refreshing…"
                  : anyCookiesPresent
                    ? "Refresh"
                    : "Sync"}
              </button>
            </div>
            {!extensionReady ? (
              <div className="cookie-sync-hint">
                <p>
                  Extension not detected —{" "}
                  <a href="/thumper-extension.zip" download>
                    download v{COOKIE_SYNC_EXTENSION_VERSION}
                  </a>
                </p>
                <ol className="install-steps">
                  <li>Unzip the download</li>
                  <li>
                    Open <code>chrome://extensions</code>, enable Developer mode
                  </li>
                  <li>
                    Load unpacked → pick the unzipped folder (or Reload if
                    already installed), then reload this page
                  </li>
                </ol>
              </div>
            ) : failedNeedRefresh ? (
              <div className="cookie-sync-hint">
                <p>
                  A job failed on stale/blocked cookies — Refresh, then Retry
                  with new cookies on the failed tracks.
                </p>
              </div>
            ) : youtubeStale ? (
              <div className="cookie-sync-hint">
                <p>
                  YouTube session looks older than 12h. Refresh before the next
                  download.
                </p>
              </div>
            ) : null}
          </aside>
        </header>

        <form className="panel" onSubmit={createJob}>
          <h2>New job</h2>
          <label>
            URL
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="YouTube, SoundCloud, or Spotify"
              required
            />
          </label>
          <div className="row">
            <label>
              Destination
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              >
                <option value="browser">Browser</option>
                <option value="drive">Google Drive</option>
                <option value="both">Both</option>
              </select>
            </label>
          </div>
          {destination === "drive" || destination === "both" ? (
            <p className="panel-note">
              Drive needs Google connected with <code>drive.file</code> — open
              your account menu, reconnect Google, then queue again.
            </p>
          ) : null}
          <label className="check-row">
            <input
              type="checkbox"
              checked={freeDownloadsOnly}
              onChange={(e) => setFreeDownloadsOnly(e.target.checked)}
            />
            <span>
              Free downloads only (artist gates)
              <span className="check-row-hint">
                Skip streams and YouTube mirrors. Tracks without a native
                SoundCloud download or a file gate (Hypeddit, ToneDen, DropLoud,
                Laylo, GateRush, Dropbox, and similar) fail so playlist fills
                stay masters-only.
              </span>
            </span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={clubReadyOnly}
              onChange={(e) => {
                setClubReadyOnly(e.target.checked);
                window.localStorage.setItem(
                  CLUB_READY_KEY,
                  String(e.target.checked),
                );
              }}
            />
            <span>
              Club-ready only
              <span className="check-row-hint">
                Rejects anything whose audio stops short of 19 kHz — a lossy
                stream, whatever the file says it is.
              </span>
            </span>
          </label>
          <div>
            <button className="btn" type="submit" disabled={!canQueue}>
              {busy ? "Queuing…" : "Queue download"}
            </button>
          </div>
          {gate.reason ? (
            <p className={`flash${gate.ready ? "" : " error"}`}>
              {gate.reason}
            </p>
          ) : null}
          {message ? (
            <p className={`flash${messageTone === "error" ? " error" : ""}`}>
              {message}
            </p>
          ) : null}
        </form>

        <section className="panel">
          <div className="panel-head">
            <h2>Jobs</h2>
            {downloadableCount > 0 ? (
              // A plain <a> to a streaming API route, not a page: the browser
              // writes it straight to disk instead of buffering in the tab.
              // eslint-disable-next-line @next/next/no-html-link-for-pages
              <a className="btn" href="/api/files/zip">
                {`Download all (${downloadableCount})`}
              </a>
            ) : null}
            {finishedCount > 0 ? (
              <button
                type="button"
                className="btn ghost"
                disabled={clearing}
                onClick={() => void clearFinishedJobs()}
              >
                {clearing ? "Clearing…" : "Clear finished"}
              </button>
            ) : null}
          </div>
          <div className="jobs">
            {jobs.length === 0 ? (
              <p className="muted">No jobs yet.</p>
            ) : (
              jobs.map((job) => {
                const retryTargets = jobsToRetry(job, jobs);
                return (
                <article key={job.id} className="job">
                  <div className="job-head">
                    <div className="job-title">{jobLabel(job)}</div>
                    <span className={`badge status-${job.status}`}>
                      {job.status}
                    </span>
                  </div>
                  <div className="job-meta">
                    {job.stage} · {job.audioFormat} · {job.destination}
                    {job.result?.freeDownloadsOnly
                      ? " · free downloads only"
                      : ""}
                    {job.result?.clubReadyOnly ? " · club-ready only" : ""}
                    {job.result?.playlist
                      ? ` · playlist (${job.result.trackCount ?? "?"} tracks${
                          job.result.unmatchedCount
                            ? `, ${job.result.unmatchedCount} unmatched`
                            : ""
                        })`
                      : ""}
                    {rollups.has(job.id)
                      ? ` · ${rollupSummary(rollups.get(job.id)!)}`
                      : ""}
                    {job.result?.matchScore
                      ? ` · match ${job.result.matchScore}`
                      : ""}
                    {job.result?.qualityLabel
                      ? ` · ${job.result.qualityLabel}`
                      : ""}
                    {job.matchedUrl ? ` · mirror ${job.matchedUrl}` : ""}
                  </div>
                  <div className="bar">
                    <span style={{ width: `${job.progress}%` }} />
                  </div>
                  {job.result?.hypedditOriginal ? (
                    <div className="quality-badge original">
                      <strong>Artist original</strong>
                      {` — ${HYPEDDIT_ORIGINAL_COPY}`}
                    </div>
                  ) : null}
                  {job.result?.soundcloudOriginal ? (
                    <div className="quality-badge original">
                      <strong>SoundCloud original</strong>
                      {" — free download (artist upload, not a stream)"}
                    </div>
                  ) : null}
                  {job.result?.manualDownloadUrl ? (
                    <div className="quality-badge unsuitable">
                      <strong>Download manually</strong>
                      {" — this link is a stream or store page, not a file gate. "}
                      <a
                        href={job.result.manualDownloadUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open gate
                      </a>
                      {", then use Retag to tag it."}
                    </div>
                  ) : null}
                  {job.result?.qualityRejected ? (
                    <div className="quality-badge unsuitable">
                      <strong>Not club-ready</strong>
                    </div>
                  ) : null}
                  {job.result?.djTier &&
                  job.result.djTier !== "master" &&
                  !job.result.qualityRejected ? (
                    <QualityBadge
                      tier={job.result.djTier}
                      headline={job.result.djHeadline}
                    />
                  ) : null}
                  {job.result?.warnings?.length ? (
                    <ul className="job-warnings">
                      {job.result.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  ) : null}
                  {rollups.get(job.id)?.failedTracks.length ? (
                    <div className="job-error">
                      {rollups.get(job.id)!.failed} of{" "}
                      {rollups.get(job.id)!.total} tracks failed:
                      <ul className="job-warnings">
                        {rollups.get(job.id)!.failedTracks.map((track) => (
                          <li key={track.id}>
                            {jobLabel(track)}
                            {track.error ? ` — ${track.error}` : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {job.error ? (
                    <div className="job-error">{job.error}</div>
                  ) : null}
                  <div className="job-actions">
                    {job.status === "queued" || job.status === "running" ? (
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => void cancelJob(job.id)}
                      >
                        Cancel
                      </button>
                    ) : null}
                    {retryTargets.length > 0 ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={retryingId !== null}
                        onClick={() => void retryWithNewCookies(job.id)}
                      >
                        {retryingId === job.id
                          ? "Retrying…"
                          : retryButtonLabel(retryTargets.length)}
                      </button>
                    ) : null}
                    {job.result?.fileId ? (
                      <a
                        className="btn"
                        href={`/api/files/${job.result.fileId}`}
                      >
                        Download
                      </a>
                    ) : null}
                    {job.result?.driveUrl ? (
                      <a
                        className="btn secondary"
                        href={job.result.driveUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open in Drive
                      </a>
                    ) : null}
                    {job.result?.manualDownloadUrl ? (
                      <a
                        className="btn secondary"
                        href={job.result.manualDownloadUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open Free Download
                      </a>
                    ) : null}
                  </div>
                </article>
                );
              })
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

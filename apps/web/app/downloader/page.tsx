"use client";

import { detectSourceKind } from "@thumper/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cookieNeedsRefresh,
  jobsToRetry,
  retryButtonLabel,
} from "../../lib/cookie-retry";
import { COOKIE_SYNC_EXTENSION_VERSION } from "./cookie-sync";
import { COOKIE_SYNC_DISCLOSURE } from "./result-copy";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  groupJobs,
  jobLabel,
  playlistRollup,
  rollupSummary,
  verdictOf,
  type CookieStatus,
  type Job,
  type PlaylistRollup,
  type VerdictTier,
} from "./job-view";
import { StatusDot } from "../components/status-dot";
import "../ui-theme.css";

const CLUB_READY_KEY = "thumper.clubReadyOnly";

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

const TIER_TEXT: Record<VerdictTier, string> = {
  original: "text-[var(--ui-tier-original)]",
  master: "text-[var(--ui-tier-master)]",
  club: "text-[var(--ui-tier-club)]",
  marginal: "text-[var(--ui-tier-marginal)]",
  unsuitable: "text-[var(--ui-tier-unsuitable)]",
  pending: "text-muted-foreground",
};

const TIER_RULE: Record<VerdictTier, string> = {
  original: "border-[var(--ui-tier-original)]",
  master: "border-[var(--ui-tier-master)]",
  club: "border-[var(--ui-tier-club)]",
  marginal: "border-[var(--ui-tier-marginal)]",
  unsuitable: "border-[var(--ui-tier-unsuitable)]",
  pending: "border-border",
};

const COOKIE_PROVIDERS = [
  ["youtube", "YouTube"],
  ["soundcloud", "SoundCloud"],
  ["spotify", "Spotify"],
] as const;

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

  // "Checking cookie sync…" is a load state, not a failure; painting it in the
  // error tone makes a healthy page read as broken on arrival.
  const checkingCookies = !cookies;
  const notice = message ?? (checkingCookies ? null : gate.reason);
  const noticeIsError = message ? messageTone === "error" : !gate.ready;
  const { topLevel, childrenOf } = groupJobs(jobs);
  const driveSelected = destination === "drive" || destination === "both";

  return (
    <div className="ui-scope min-h-screen">
      <div className="mx-auto max-w-2xl px-5 pt-10 pb-28">
        <h1 className="mb-5 text-lg font-semibold tracking-tight">Downloader</h1>

        <form
          onSubmit={createJob}
          className="rounded-xl border border-border bg-card p-5 shadow-lg shadow-black/30"
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste a YouTube, SoundCloud, or Spotify link"
            required
            className="h-12 border-input bg-background text-base md:text-base"
          />

          <div className="mt-3 flex items-center gap-3">
            <Select value={destination} onValueChange={setDestination}>
              <SelectTrigger className="w-44 bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="browser">Browser</SelectItem>
                <SelectItem value="drive">Google Drive</SelectItem>
                <SelectItem value="both">Both</SelectItem>
              </SelectContent>
            </Select>

            <Button type="submit" disabled={!canQueue} className="ml-auto">
              {busy ? (
                <>
                  <Loader2 className="animate-spin" /> Queuing
                </>
              ) : (
                "Queue download"
              )}
            </Button>
          </div>

          {driveSelected ? (
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Drive needs Google connected with <code>drive.file</code> — open
              your account menu, reconnect Google, then queue again.
            </p>
          ) : null}

          <Collapsible className="mt-4">
            <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
              <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
              Filters
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <label className="flex cursor-pointer gap-2.5">
                <Checkbox
                  checked={freeDownloadsOnly}
                  onCheckedChange={(v) => setFreeDownloadsOnly(v === true)}
                  className="mt-0.5"
                />
                <span className="text-xs leading-relaxed text-muted-foreground">
                  <span className="text-foreground">
                    Free downloads only (artist gates)
                  </span>{" "}
                  — skip streams and YouTube mirrors. Tracks without a native
                  SoundCloud download or a file gate (Hypeddit, ToneDen,
                  DropLoud, Laylo, GateRush, Dropbox, and similar) fail, so
                  playlist fills stay masters-only.
                </span>
              </label>
              <label className="flex cursor-pointer gap-2.5">
                <Checkbox
                  checked={clubReadyOnly}
                  onCheckedChange={(v) => {
                    setClubReadyOnly(v === true);
                    window.localStorage.setItem(CLUB_READY_KEY, String(v === true));
                  }}
                  className="mt-0.5"
                />
                <span className="text-xs leading-relaxed text-muted-foreground">
                  <span className="text-foreground">Club-ready only</span> —
                  rejects anything whose audio stops short of 19 kHz, a lossy
                  stream whatever the file says it is.
                </span>
              </label>
            </CollapsibleContent>
          </Collapsible>

          {notice ? (
            <p
              className={`mt-4 rounded-md border px-3 py-2 text-xs ${
                noticeIsError
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-border bg-muted text-muted-foreground"
              }`}
            >
              {notice}
            </p>
          ) : null}
        </form>

        <p className="mt-5 text-[11px] leading-relaxed text-muted-foreground">
          {COOKIE_SYNC_DISCLOSURE}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Sessions</span>
          {COOKIE_PROVIDERS.map(([key, label]) => {
            const status = cookies?.[key];
            const present = status?.present ?? false;
            const stale = present && isCookieStale(status?.updatedAt ?? null);
            const age = formatSyncedAge(status?.updatedAt ?? null);
            return (
              <Badge
                key={key}
                variant="outline"
                title={
                  present
                    ? `${stale ? "Stale — " : ""}Updated ${formatSyncedAt(status?.updatedAt ?? null)}`
                    : "Not synced yet"
                }
                className="gap-1.5 border-border font-normal text-muted-foreground"
              >
                <span
                  className={`size-1.5 rounded-full ${
                    checkingCookies
                      ? "bg-muted-foreground/40"
                      : !present
                        ? "bg-[var(--ui-tier-unsuitable)]"
                        : stale
                          ? "bg-[var(--ui-tier-marginal)]"
                          : "bg-[var(--ui-tier-master)]"
                  }`}
                />
                {label}
                {present && age ? (
                  <span className="text-[10px] opacity-70">{age}</span>
                ) : null}
              </Badge>
            );
          })}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void syncCookies()}
            disabled={syncing || !extensionReady}
          >
            <RefreshCw className={syncing ? "animate-spin" : ""} />
            {anyCookiesPresent ? "Refresh" : "Sync"}
          </Button>

          <span className="ml-auto flex gap-2">
            {downloadableCount > 0 ? (
              <Button asChild variant="secondary" size="sm">
                {/* A plain <a> to a streaming API route, not a page: the browser
                    writes it straight to disk instead of buffering in the tab. */}
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a href="/api/files/zip">Download all ({downloadableCount})</a>
              </Button>
            ) : null}
            {finishedCount > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={clearing}
                onClick={() => void clearFinishedJobs()}
              >
                {clearing ? "Clearing…" : "Clear finished"}
              </Button>
            ) : null}
          </span>
        </div>

        {!extensionReady ? (
          <div className="mt-3 rounded-md border border-border bg-muted px-3 py-2.5 text-xs text-muted-foreground">
            <p>
              Extension not detected —{" "}
              <a
                href="/thumper-extension.zip"
                download
                className="text-primary underline underline-offset-2"
              >
                download v{COOKIE_SYNC_EXTENSION_VERSION}
              </a>
            </p>
            <ol className="mt-1.5 list-decimal space-y-0.5 pl-4">
              <li>Unzip the download</li>
              <li>
                Open <code>chrome://extensions</code>, enable Developer mode
              </li>
              <li>
                Load unpacked → pick the unzipped folder (or Reload if already
                installed), then reload this page
              </li>
            </ol>
          </div>
        ) : failedNeedRefresh ? (
          <p className="mt-3 rounded-md border border-border bg-muted px-3 py-2.5 text-xs text-muted-foreground">
            A job failed on stale or blocked cookies — Refresh, then retry the
            failed tracks.
          </p>
        ) : youtubeStale ? (
          <p className="mt-3 rounded-md border border-border bg-muted px-3 py-2.5 text-xs text-muted-foreground">
            YouTube session looks older than 12h. Refresh before the next
            download.
          </p>
        ) : null}

        <Separator className="my-6" />

        {topLevel.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            Nothing queued yet.
          </p>
        ) : (
          <div className="space-y-7">
            {topLevel.map((job) => {
              const verdict = verdictOf(job);
              const kids = childrenOf(job.id);
              const rollup = rollups.get(job.id);
              const retryTargets = jobsToRetry(job, jobs);
              return (
                <article key={job.id} className="relative pl-5">
                  <span className="absolute top-1.5 left-0">
                    <StatusDot status={job.status} />
                  </span>

                  <h2 className="text-[15px] leading-tight font-semibold">
                    {jobLabel(job)}
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {job.stage} · {job.audioFormat} · {job.destination}
                    {job.result?.freeDownloadsOnly ? " · free downloads only" : ""}
                    {job.result?.clubReadyOnly ? " · club-ready only" : ""}
                    {rollup ? ` · ${rollupSummary(rollup)}` : ""}
                    {job.result?.unmatchedCount
                      ? ` · ${job.result.unmatchedCount} unmatched`
                      : ""}
                    {job.result?.matchScore ? ` · match ${job.result.matchScore}` : ""}
                  </p>

                  {job.status === "running" || job.status === "queued" ? (
                    <div className="mt-2.5 h-0.5 w-full overflow-hidden rounded bg-muted">
                      <span
                        className="block h-full bg-primary transition-[width]"
                        style={{ width: `${job.progress}%` }}
                      />
                    </div>
                  ) : null}

                  {verdict.tier !== "pending" ? (
                    <p
                      className={`mt-3 border-l-2 bg-muted/50 py-2 pl-3 text-[13px] leading-relaxed ${TIER_RULE[verdict.tier]}`}
                    >
                      <span
                        className={`font-semibold tracking-wide uppercase ${TIER_TEXT[verdict.tier]}`}
                      >
                        {verdict.lead}
                      </span>
                      {verdict.detail ? (
                        <span className="text-muted-foreground"> — {verdict.detail}</span>
                      ) : null}
                    </p>
                  ) : null}

                  {job.result?.warnings?.length ? (
                    <ul className="mt-2 space-y-1 pl-4 text-xs text-muted-foreground">
                      {job.result.warnings.map((warning) => (
                        <li key={warning} className="list-disc">
                          {warning}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {kids.length > 0 ? (
                    <ul className="mt-3 space-y-1.5 border-l border-border pl-3">
                      {kids.map((kid) => {
                        const kidVerdict = verdictOf(kid);
                        return (
                          <li key={kid.id} className="flex items-center gap-2.5 text-xs">
                            <StatusDot status={kid.status} />
                            <span className="flex-1 truncate text-muted-foreground">
                              {jobLabel(kid)}
                            </span>
                            <span
                              title={kidVerdict.detail ?? undefined}
                              className={`text-[10px] font-medium tracking-wider uppercase ${TIER_TEXT[kidVerdict.tier]}`}
                            >
                              {kidVerdict.lead}
                            </span>
                            {kid.result?.fileId ? (
                              <Button
                                asChild
                                variant="secondary"
                                size="sm"
                                className="h-6 px-2 text-[11px]"
                              >
                                <a href={`/api/files/${kid.result.fileId}`}>Get</a>
                              </Button>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {job.status === "queued" || job.status === "running" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void cancelJob(job.id)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                    {retryTargets.length > 0 ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={retryingId !== null}
                        onClick={() => void retryWithNewCookies(job.id)}
                      >
                        {retryingId === job.id
                          ? "Retrying…"
                          : retryButtonLabel(retryTargets.length)}
                      </Button>
                    ) : null}
                    {job.result?.fileId ? (
                      <Button asChild size="sm">
                        <a href={`/api/files/${job.result.fileId}`}>Download</a>
                      </Button>
                    ) : null}
                    {job.result?.driveUrl ? (
                      <Button asChild variant="secondary" size="sm">
                        <a href={job.result.driveUrl} target="_blank" rel="noreferrer">
                          Open in Drive
                        </a>
                      </Button>
                    ) : null}
                    {job.result?.manualDownloadUrl ? (
                      <Button asChild variant="secondary" size="sm">
                        <a
                          href={job.result.manualDownloadUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open gate
                        </a>
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

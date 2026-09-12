"use client";

import { detectSourceKind } from "@thumper/shared";
import { ArrowDownToLine, AudioLines, Link2, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cookieNeedsRefresh, jobsToRetry, retryButtonLabel } from "../../lib/cookie-retry";
import {
  type CookieProviderKey,
  type CookieSetupState,
  cookieSetupState,
} from "../../lib/cookie-setup";
import { StatusDot } from "../components/status-dot";
import { COOKIE_SYNC_EXTENSION_VERSION } from "./cookie-sync";
import {
  type CookieStatus,
  groupJobs,
  type Job,
  jobLabel,
  playlistRollup,
  rollupSummary,
  type VerdictTier,
  verdictOf,
} from "./job-view";
import "../ui-theme.css";
import "./downloader.css";

const CLUB_READY_KEY = "thumper.clubReadyOnly";

type SyncResult = {
  ok?: boolean;
  error?: string;
  message?: string;
  version?: string;
  results?: {
    youtube?: { status: string; reason?: string };
    soundcloud?: { status: string; reason?: string };
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
  if (!cookies.youtube.present) {
    return {
      ready: false,
      reason: "Connect your YouTube account before adding downloads.",
    };
  }
  const kind = url.trim() ? detectSourceKind(url.trim()) : null;
  if (kind === "soundcloud" && !cookies.soundcloud.present) {
    return {
      ready: false,
      reason: "Sync SoundCloud cookies before queuing SoundCloud downloads",
    };
  }
  if (
    (kind === "youtube" || kind === "soundcloud" || kind === "spotify") &&
    cookies.youtube.present &&
    isCookieStale(cookies.youtube.updatedAt)
  ) {
    return {
      ready: true,
      reason: "Your YouTube session may have expired. Refresh it before your next download.",
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
        error: "No response from the Thumper extension. Install/reload it, then try again.",
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

/** Providers the extension refused to export because nobody is signed in. */
function skippedFromSync(result: SyncResult): CookieProviderKey[] {
  const out: CookieProviderKey[] = [];
  for (const key of ["youtube", "soundcloud"] as const) {
    if (result.results?.[key]?.status === "skipped") out.push(key);
  }
  return out;
}

const COOKIE_PROVIDERS = [
  ["youtube", "YouTube"],
  ["soundcloud", "SoundCloud"],
] as const;

const PROVIDER_SITES: Record<CookieProviderKey, { label: string; url: string }> = {
  youtube: { label: "YouTube", url: "https://www.youtube.com" },
  soundcloud: { label: "SoundCloud", url: "https://soundcloud.com" },
};

/**
 * One instruction at a time.
 *
 * Everything a download needs from the browser — the extension, a signed-in
 * tab, a fresh sync — fails in a way that looks identical from the queue: jobs
 * just stop working. This panel names the single next action instead, and sits
 * beside the Sync button rather than down in the job list where the old
 * install steps lived.
 */
function CookieSetupPanel({ state }: { state: CookieSetupState }) {
  if (state.step === "ready") return null;

  // Same vocabulary as the session dots: amber for "works, but attend to it",
  // red for "nothing will download until you act".
  const blocking = state.step === "install" || state.step === "sync";
  const accent = blocking ? "var(--ui-tier-unsuitable)" : "var(--ui-tier-marginal)";

  const installSteps = (
    <ol className="mt-1.5 list-decimal space-y-0.5 pl-4">
      <li>Unzip the download</li>
      <li>
        Open <code>chrome://extensions</code>, enable Developer mode
      </li>
      <li>
        Load unpacked → pick the unzipped folder (or Reload if already installed), then reload this
        page
      </li>
    </ol>
  );

  const downloadLink = (
    <a href="/thumper-extension.zip" download className="text-primary underline underline-offset-2">
      download v{COOKIE_SYNC_EXTENSION_VERSION}
    </a>
  );

  return (
    <div
      className="downloader-cookie-setup mt-3 rounded-md border border-border border-l-2 bg-muted px-3 py-2.5 text-xs text-muted-foreground"
      style={{ borderLeftColor: accent }}
    >
      {state.step === "install" ? (
        <>
          <p className="font-medium text-foreground">
            Install the Thumper extension to start downloading
          </p>
          <p className="mt-1">
            It copies your signed-in YouTube and SoundCloud sessions to Thumper so downloads can use
            them — {downloadLink}
          </p>
          {installSteps}
        </>
      ) : null}

      {state.step === "update" ? (
        <>
          <p className="font-medium text-foreground">Extension v{state.installed} is out of date</p>
          <p className="mt-1">
            v{COOKIE_SYNC_EXTENSION_VERSION} changed which sessions get synced. Until you update,
            syncing may look like it worked but leave Thumper without usable cookies —{" "}
            {downloadLink}
          </p>
          {installSteps}
        </>
      ) : null}

      {state.step === "signin" ? (
        <>
          <p className="font-medium text-foreground">
            Sign in to {state.providers.map((k) => PROVIDER_SITES[k].label).join(" and ")} in this
            browser
          </p>
          <p className="mt-1">
            The last sync skipped{" "}
            {state.providers.map((k, i) => (
              <span key={k}>
                {i > 0 ? ", " : ""}
                <a
                  href={PROVIDER_SITES[k].url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  {PROVIDER_SITES[k].label}
                </a>
              </span>
            ))}{" "}
            because no session was found. Sign in there, then sync again.
          </p>
        </>
      ) : null}

      {state.step === "sync" ? (
        <p>
          <span className="font-medium text-foreground">Almost there.</span> Extension installed —
          sync your sessions to Thumper and you can start queueing links.
        </p>
      ) : null}

      {state.step === "refresh" ? (
        <p>
          {state.reason === "failed"
            ? "A job failed on stale or blocked cookies. Refresh, then retry the failed tracks."
            : "YouTube session looks older than 12h. Refresh before the next download."}
        </p>
      ) : null}
    </div>
  );
}

export default function DownloaderPage() {
  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState("browser");
  const [clubReadyOnly, setClubReadyOnly] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const hasActiveJobsRef = useRef(false);
  const [cookies, setCookies] = useState<CookieStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"ok" | "error">("ok");
  // The version, not just presence: an extension left on an older build syncs
  // providers the API now rejects, which reads as "cookies broken" unless the
  // page says outright that the extension is stale.
  const [extensionVersion, setExtensionVersion] = useState<string | null>(null);
  const [skippedProviders, setSkippedProviders] = useState<CookieProviderKey[]>([]);
  const extensionReady = extensionVersion !== null;
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

    // Both endpoints are comparatively heavy — /api/jobs returns the whole
    // queue, /api/cookies does object-store HEADs — and neither can change
    // while the tab is hidden and idle. Poll fast only while work is running.
    let idleTicks = 0;
    const jobsTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (hasActiveJobsRef.current) {
        idleTicks = 0;
        void refreshJobs();
        return;
      }
      idleTicks += 1;
      if (idleTicks >= 8) {
        idleTicks = 0;
        void refreshJobs();
      }
    }, 1500);
    const cookiesTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshCookies();
    }, 3000);
    const onFocus = () => void refreshCookies();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refreshJobs();
      void refreshCookies();
    };
    document.addEventListener("visibilitychange", onVisible);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as {
        source?: string;
        type?: string;
        version?: string;
      };
      if (data?.source === "thumper-extension" && data.type === "extension-ready") {
        setExtensionVersion(typeof data.version === "string" ? data.version : "unknown");
      }
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("message", onMessage);

    const ping = () => {
      if (extensionReadyRef.current) return;
      window.postMessage({ source: "thumper-page", type: "ping" }, window.location.origin);
    };
    ping();
    const pingTimer = window.setInterval(ping, 2000);
    return () => {
      clearInterval(jobsTimer);
      clearInterval(cookiesTimer);
      clearInterval(pingTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("message", onMessage);
    };
  }, [refreshJobs, refreshCookies]);

  useEffect(() => {
    hasActiveJobsRef.current = jobs.some(
      (job) => job.status === "queued" || job.status === "running" || job.status === "cancelling",
    );
  }, [jobs]);

  const rollups = useMemo(() => {
    const byId = new Map(jobs.map((job) => [job.id, job]));
    const entries = jobs.flatMap((job) => {
      const rollup = playlistRollup(job, byId);
      return rollup ? [[job.id, rollup] as const] : [];
    });
    return new Map(entries);
  }, [jobs]);
  const gate = useMemo(() => cookiesReadyForUrl(url, cookies), [url, cookies]);
  const canQueue = !busy && gate.ready && url.trim().length > 0;
  const finishedCount = jobs.filter(
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled",
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
          url: url.trim(),
          audioFormat: "flac",
          destination,
          clubReadyOnly,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setUrl("");
      await refreshJobs();
      setMessageTone("ok");
      setMessage("Added to your queue. You can paste another link.");
    } catch (err) {
      setMessageTone("error");
      setMessage(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancelJob(id: string) {
    try {
      const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not cancel this download. Try again.");
      await refreshJobs();
    } catch (err) {
      setMessageTone("error");
      setMessage(err instanceof Error ? err.message : "Could not cancel this download.");
    }
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
      if (result.version) setExtensionVersion(result.version);
      if (!result.ok) {
        setMessageTone("error");
        setMessage(result.error || result.message || "Cookie refresh failed");
        setSkippedProviders(skippedFromSync(result));
        return;
      }
      setMessageTone("ok");
      setMessage(result.message || "Cookies refreshed");
      setSkippedProviders(skippedFromSync(result));
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

  const anyCookiesPresent = Boolean(cookies?.youtube.present || cookies?.soundcloud.present);
  const youtubeStale =
    Boolean(cookies?.youtube.present) && isCookieStale(cookies?.youtube.updatedAt ?? null);
  const failedNeedRefresh = jobs.some(
    (job) => job.status === "failed" && cookieNeedsRefresh(job.error),
  );

  // "Checking cookie sync…" is a load state, not a failure; painting it in the
  // error tone makes a healthy page read as broken on arrival.
  const setupState = cookieSetupState({
    extensionVersion,
    expectedVersion: COOKIE_SYNC_EXTENSION_VERSION,
    cookies,
    skipped: skippedProviders,
    youtubeStale,
    failedNeedRefresh,
  });
  const checkingCookies = !cookies;
  const notice = message ?? (checkingCookies ? null : gate.reason);
  const noticeIsError = Boolean(message && messageTone === "error");
  const { topLevel, childrenOf } = groupJobs(jobs);
  const driveSelected = destination === "drive" || destination === "both";

  return (
    <div className="ui-scope downloader min-h-screen">
      <div className="downloader-shell">
        <header className="downloader-heading">
          <div>
            <h1>Download music</h1>
            <p>Save audio from YouTube, SoundCloud and Spotify links.</p>
          </div>
          <span className="downloader-format">
            <AudioLines size={16} /> Audio format: FLAC
          </span>
        </header>

        <div className="downloader-workspace">
          <form onSubmit={createJob} className="downloader-composer">
            <div className="downloader-section-title">
              <Link2 size={18} />
              <h2>New download</h2>
            </div>
            <p className="downloader-description">Add a single track or an entire playlist.</p>
            <label htmlFor="download-url" className="downloader-label">
              Track or playlist link
            </label>
            <Input
              id="download-url"
              type="url"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="download-help"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste your link here…"
              required
              className="h-12 border-input bg-background text-base md:text-base"
            />

            <div className="downloader-options">
              <div>
                <label htmlFor="download-destination" className="downloader-label">
                  Save to
                </label>
                <Select value={destination} onValueChange={setDestination}>
                  <SelectTrigger id="download-destination" className="w-full bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start" sideOffset={6}>
                    <SelectItem value="browser">This device</SelectItem>
                    <SelectItem value="drive">Google Drive</SelectItem>
                    <SelectItem value="both">Device + Google Drive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={!canQueue} className="downloader-submit">
                {busy ? (
                  <>
                    <Loader2 className="animate-spin" /> Queuing
                  </>
                ) : (
                  <>
                    <ArrowDownToLine /> Add to queue
                  </>
                )}
              </Button>
            </div>

            {driveSelected ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Connect Google Drive from your account menu before downloading to Drive.
              </p>
            ) : null}

            <p id="download-help" className="downloader-description mt-3">
              {destination === "browser"
                ? "Download finished files from your queue below."
                : "Files will be saved to your connected Google Drive."}
            </p>
            <div className="downloader-quality">
              {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the shadcn Checkbox, which biome cannot resolve to an input element. */}
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
                  <span className="text-foreground">Club-ready only</span> — skips tracks with a
                  frequency cutoff below 19 kHz. Passing this check doesn’t mean the audio is
                  lossless.
                </span>
              </label>
            </div>

            {notice ? (
              <p
                role={noticeIsError ? "alert" : "status"}
                className={`mt-4 rounded-md border px-3 py-2 text-xs ${
                  noticeIsError
                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : "border-border bg-muted text-muted-foreground"
                }`}
              >
                {notice}
                {!message && !gate.ready ? (
                  <>
                    {" "}
                    ·{" "}
                    <a href="#connections-heading" className="underline underline-offset-2">
                      View setup
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
          </form>

          <aside
            className="downloader-connections downloader-session-card"
            data-ready={setupState.step === "ready"}
            aria-labelledby="connections-heading"
          >
            <div className="downloader-section-title">
              <h2 id="connections-heading" tabIndex={-1}>
                Connections
              </h2>
            </div>
            <p className="downloader-description">
              Connect your YouTube account through the Chrome extension to start downloading.
            </p>
            <div className="downloader-sessions">
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
                    className="downloader-session gap-1.5 border-border font-normal text-muted-foreground"
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
                    <span className="ml-auto text-xs">
                      {checkingCookies
                        ? "Checking…"
                        : !present
                          ? "Not connected"
                          : stale
                            ? "Refresh needed"
                            : "Ready"}
                    </span>
                    {present && age ? <span className="text-[10px] opacity-70">{age}</span> : null}
                  </Badge>
                );
              })}
              <Button
                type="button"
                variant="outline"
                className="h-10 w-full mt-2"
                onClick={() => void syncCookies()}
                disabled={syncing || !extensionReady}
              >
                <RefreshCw className={syncing ? "animate-spin" : ""} />
                {syncing
                  ? "Connecting…"
                  : anyCookiesPresent
                    ? "Refresh connections"
                    : "Connect accounts"}
              </Button>
            </div>
            <CookieSetupPanel state={setupState} />
          </aside>
        </div>

        <section className="downloader-queue" aria-labelledby="queue-heading">
          <div className="downloader-queue-heading">
            <div>
              <h2 id="queue-heading">
                Download queue <span>{topLevel.length}</span>
              </h2>
              <p className="downloader-description">
                Track your downloads and save completed files.
              </p>
            </div>
            <span className="ml-auto flex gap-2">
              {downloadableCount > 0 ? (
                <Button asChild variant="secondary" size="sm">
                  {/* A plain <a> to a streaming API route, not a page: the browser
                    writes it straight to disk instead of buffering in the tab. */}
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

          {topLevel.length === 0 ? (
            <div className="downloader-empty">
              <div className="downloader-empty-icon">
                <AudioLines size={26} />
              </div>
              <h3>No downloads yet</h3>
              <p>
                Paste a track or playlist link above.
                <br />
                Your downloads will appear here.
              </p>
            </div>
          ) : (
            <div className="space-y-7">
              {topLevel.map((job) => {
                const verdict = verdictOf(job);
                const kids = childrenOf(job.id);
                const rollup = rollups.get(job.id);
                const retryTargets = jobsToRetry(job, jobs);
                return (
                  <article key={job.id} className="downloader-job relative pl-5">
                    <span className="absolute top-1.5 left-0">
                      <StatusDot status={job.status} />
                    </span>

                    <h3 className="break-words text-[15px] leading-tight font-semibold">
                      {jobLabel(job)}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {job.stage} · {job.audioFormat} · {job.destination}
                      {job.result?.clubReadyOnly ? " · club-ready only" : ""}
                      {rollup ? ` · ${rollupSummary(rollup)}` : ""}
                      {job.result?.unmatchedCount
                        ? ` · ${job.result.unmatchedCount} unmatched`
                        : ""}
                      {job.result?.matchScore ? ` · match ${job.result.matchScore}` : ""}
                    </p>

                    {job.status === "running" || job.status === "queued" ? (
                      <div
                        role="progressbar"
                        aria-label={`${jobLabel(job)} progress`}
                        aria-valuenow={Math.min(100, Math.max(0, job.progress))}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        className="mt-2.5 h-1 w-full overflow-hidden rounded bg-muted"
                      >
                        <span
                          className="block h-full bg-primary transition-[width]"
                          style={{ width: `${Math.min(100, Math.max(0, job.progress))}%` }}
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
                              <span
                                title={jobLabel(kid)}
                                className="min-w-0 flex-1 truncate text-muted-foreground"
                              >
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
                                  <a
                                    href={`/api/files/${kid.result.fileId}`}
                                    aria-label={`Download ${jobLabel(kid)}`}
                                  >
                                    Download
                                  </a>
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
                          <a href={job.result.manualDownloadUrl} target="_blank" rel="noreferrer">
                            Open link
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

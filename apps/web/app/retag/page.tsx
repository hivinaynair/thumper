"use client";

import { useAuth } from "@clerk/nextjs";
import { isRetagInput, RETAG_INPUT_LABEL, trackDisplayName } from "@thumper/shared";
import { Check, Download, ExternalLink, Link2, Loader2, Music2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { retagStatus, validMetadataUrl } from "./view";
import "./retag.css";
import "../ui-theme.css";
import "../downloader/downloader.css";
import "../audio-tools.css";
import { readJson, uploadAudio } from "@/lib/upload-audio";
import { AudioUpload } from "../components/audio-upload";

type Candidate = {
  url: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  durationSec: number;
};

type Job = {
  id: string;
  status: string;
  stage: string;
  progress: number;
  sourceUrl: string;
  title?: string | null;
  artist?: string | null;
  error?: string | null;
  result?: {
    fileId?: string;
    driveUrl?: string;
    qualityLabel?: string;
    retag?: boolean;
  } | null;
};

type TrackItem = {
  id: string;
  filename: string;
  inputStorageKey: string;
  searchQuery: string;
  candidates: Candidate[];
  selected: Candidate | null;
  overrideUrl: string;
  draftUrl?: string;
  urlError?: string;
  uploadProgress?: number;
  startedAt?: number;
  conversionRequested?: boolean;
  showOverride: boolean;
  approved: boolean;
  status: "waiting" | "uploading" | "ready" | "searching" | "error";
  error?: string;
  jobId?: string;
  job?: Job;
};

type Step = "upload" | "confirm" | "converting" | "done";

function newId(): string {
  return crypto.randomUUID();
}

const STEPS = [
  ["upload", "Upload"],
  ["confirm", "Review matches"],
  ["converting", "Update & save"],
  ["done", "Done"],
] as const;

export default function RetagPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { userId } = useAuth();
  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TrackItem[]>([]);
  const [destination, setDestination] = useState("browser");

  const reset = useCallback(() => {
    setStep("upload");
    setBusy(false);
    setError(null);
    setTracks([]);
    setDestination("browser");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const runSearch = useCallback(async (opts: { query?: string; filename?: string }) => {
    const res = await fetch("/api/retag/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(String(data.error || "Search failed"));
    return data as unknown as { query: string; candidates: Candidate[] };
  }, []);

  const uploadOne = useCallback(
    (file: File, onProgress: (percentage: number) => void) =>
      uploadAudio(file, "/api/retag/upload", userId, onProgress),
    [userId],
  );

  const onFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = [...fileList].filter((f) => isRetagInput(f.name, f.type));
      if (files.length === 0) {
        setError(`Select one or more ${RETAG_INPUT_LABEL} files`);
        return;
      }

      setError(null);
      setBusy(true);
      setStep("confirm");
      const next: TrackItem[] = files.map((file) => ({
        id: newId(),
        filename: file.name,
        inputStorageKey: "",
        searchQuery: "",
        candidates: [],
        selected: null,
        overrideUrl: "",
        showOverride: false,
        approved: false,
        status: "waiting",
      }));
      setTracks(next);
      const patch = (id: string, values: Partial<TrackItem>) =>
        setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, ...values } : t)));
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i]!;
          const item = next[i]!;
          patch(item.id, { status: "uploading", startedAt: Date.now() });
          try {
            const up = await uploadOne(file, (uploadProgress) =>
              patch(item.id, { uploadProgress }),
            );
            patch(item.id, {
              inputStorageKey: up.key,
              filename: up.filename,
              status: "searching",
              searchQuery: up.searchQuery,
            });
            const found = await runSearch({ filename: up.filename });
            patch(item.id, {
              searchQuery: found.query,
              candidates: found.candidates,
              selected: found.candidates[0] ?? null,
              approved: Boolean(found.candidates[0]),
              status: "ready",
            });
          } catch (err) {
            patch(item.id, {
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [uploadOne, runSearch],
  );

  const updateTrack = useCallback((id: string, patch: Partial<TrackItem>) => {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const approveAll = useCallback(() => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.status !== "ready") return t;
        const hasMatch = Boolean(t.selected?.url || t.overrideUrl.trim());
        return hasMatch ? { ...t, approved: true } : t;
      }),
    );
  }, []);

  const metadataUrlFor = (t: TrackItem): string | null =>
    t.overrideUrl || t.selected?.url?.trim() || null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: metadataUrlFor is pure over its argument, so omitting it cannot go stale; listing it would rebuild this callback every render.
  const convertApproved = useCallback(async () => {
    const approved = tracks.filter((t) => {
      if (!t.approved || t.status !== "ready") return false;
      return Boolean(metadataUrlFor(t));
    });
    if (approved.length === 0) {
      setError("Approve at least one track with a SoundCloud match or URL");
      return;
    }

    setError(null);
    setBusy(true);
    setStep("converting");

    setTracks((prev) =>
      prev.map((t) =>
        approved.some((a) => a.id === t.id)
          ? { ...t, conversionRequested: true, startedAt: Date.now(), error: undefined }
          : t,
      ),
    );
    try {
      for (const t of approved) {
        try {
          const res = await fetch("/api/retag/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              inputStorageKey: t.inputStorageKey,
              metadataUrl: metadataUrlFor(t),
              titleHint: t.overrideUrl ? undefined : t.selected?.title,
              artistHint: t.overrideUrl ? undefined : t.selected?.artist,
              destination,
            }),
          });
          const data = await readJson(res);
          if (!res.ok) throw new Error(String(data.error || "Could not start updating this file"));
          const job = data.job as Job;
          updateTrack(t.id, { jobId: job.id, job });
        } catch (err) {
          updateTrack(t.id, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    } finally {
      setBusy(false);
    }
  }, [tracks, destination, updateTrack]);

  useEffect(() => {
    if (step !== "converting") return;
    const active = tracks.filter((t) => t.conversionRequested);
    if (active.length === 0) return;

    const allDone = active.every(
      (t) =>
        t.error ||
        (t.job &&
          (t.job.status === "completed" ||
            t.job.status === "failed" ||
            t.job.status === "cancelled")),
    );
    if (allDone && !busy) {
      setStep("done");
      return;
    }

    const id = window.setInterval(async () => {
      try {
        const res = await fetch("/api/jobs");
        if (!res.ok) return;
        const data = await readJson(res);
        const rows = (data.jobs ?? []) as Job[];
        setTracks((prev) =>
          prev.map((t) => {
            if (!t.jobId) return t;
            const current = rows.find((row) => row.id === t.jobId);
            return current ? { ...t, job: current } : t;
          }),
        );
      } catch {
        /* keep polling */
      }
    }, 1500);

    return () => window.clearInterval(id);
  }, [step, tracks, busy]);

  useEffect(() => {
    if (!busy && step !== "converting") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy, step]);

  const convertingTracks = tracks.filter((t) => t.conversionRequested);
  const approvedCount = tracks.filter(
    (t) => t.approved && t.status === "ready" && metadataUrlFor(t),
  ).length;

  const stepIndex = STEPS.findIndex(([key]) => key === step);

  return (
    <div className="ui-scope downloader min-h-screen">
      <div className="downloader-shell">
        <header className="downloader-heading">
          <div>
            <h1>Update track details</h1>
            <p>
              Add track titles, artists and artwork to your audio files, then save them as FLAC.
            </p>
          </div>
          <span className="downloader-format">Audio format: FLAC</span>
        </header>

        <div className="audio-steps">
          {STEPS.map(([key, label], i) => (
            <span
              key={key}
              aria-current={i === stepIndex ? "step" : undefined}
              className="flex items-center gap-2"
            >
              <span
                className={`text-[11px] tracking-wide uppercase ${
                  i === stepIndex
                    ? "font-semibold text-primary"
                    : i < stepIndex
                      ? "text-muted-foreground"
                      : "text-muted-foreground"
                }`}
              >
                {label}
              </span>
              {i < STEPS.length - 1 ? <span className="h-px w-5 bg-border" /> : null}
            </span>
          ))}
          {step !== "upload" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-7 text-xs"
              onClick={reset}
              disabled={busy || step === "converting"}
            >
              <RotateCcw /> Start over
            </Button>
          ) : null}
        </div>

        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
        {step === "upload" ? (
          <div className="downloader-workspace mt-6">
            <section className="downloader-composer">
              <div className="downloader-section-title">
                <h2>Upload audio</h2>
              </div>
              <p className="downloader-description">Select the files you want to update.</p>
              <AudioUpload
                busy={busy}
                inputRef={fileInputRef}
                onFiles={(files) => void onFiles(files)}
              />
            </section>
            <aside className="downloader-connections">
              <div className="downloader-section-title">
                <h2>How it works</h2>
              </div>
              <ol className="audio-guide">
                <li>
                  <strong>Upload your files</strong>
                  <p>Add one track or several at once.</p>
                </li>
                <li>
                  <strong>Review the matches</strong>
                  <p>
                    Check the suggested SoundCloud title, artist and artwork. Choose another match
                    or paste a link if needed.
                  </p>
                </li>
                <li>
                  <strong>Save your updated tracks</strong>
                  <p>Convert to FLAC and download to your device or Google Drive.</p>
                </li>
              </ol>
              <p className="audio-note">
                Converting to FLAC preserves the source quality; it won’t restore detail lost in a
                compressed file.
              </p>
            </aside>
          </div>
        ) : null}

        {step === "confirm" ? (
          <>
            <div className="retag-review-heading">
              <h2>{busy ? "Preparing your tracks" : "Review your matches"}</h2>
              <p>
                {busy
                  ? "Each file is uploaded, then we search SoundCloud for its title, artist and artwork."
                  : "Check the suggested details below. Only selected tracks will be updated; your audio comes from your uploaded file."}
              </p>
            </div>
            <div className="retag-toolbar">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={approveAll}
              >
                Select all matches
              </Button>
              <Select value={destination} onValueChange={setDestination}>
                <SelectTrigger aria-label="Save to" className="h-8 w-44 bg-background text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start" sideOffset={6}>
                  <SelectItem value="browser">This device</SelectItem>
                  <SelectItem value="drive">Google Drive</SelectItem>
                  <SelectItem value="both">Device + Google Drive</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                className="ml-auto"
                disabled={busy || approvedCount === 0 || tracks.some((t) => t.showOverride)}
                onClick={() => void convertApproved()}
              >
                {busy ? (
                  <>
                    <Loader2 className="animate-spin" /> Queuing
                  </>
                ) : (
                  `Update ${approvedCount} ${approvedCount === 1 ? "track" : "tracks"}`
                )}
              </Button>
            </div>

            <div className="space-y-6">
              {tracks.map((t) => {
                const matchable =
                  Boolean(t.inputStorageKey) &&
                  (t.status === "ready" || t.status === "error") &&
                  Boolean(t.selected || t.overrideUrl.trim());
                return (
                  <article key={t.id} className="retag-track">
                    <div className="flex items-center gap-2.5">
                      <Checkbox
                        checked={t.approved}
                        disabled={!matchable || busy}
                        onCheckedChange={(v) => updateTrack(t.id, { approved: v === true })}
                        id={`approve-${t.id}`}
                      />
                      <label htmlFor={`approve-${t.id}`} className="retag-filename">
                        {t.filename}
                      </label>
                      <Badge variant="outline" className="retag-status">
                        {t.status === "uploading" || t.status === "searching" ? (
                          <Loader2 className="animate-spin" size={12} />
                        ) : null}
                        {retagStatus(t.status).title === "Review match"
                          ? t.overrideUrl
                            ? "Custom link"
                            : t.selected
                              ? "Match found"
                              : "No match found"
                          : retagStatus(t.status).title}
                      </Badge>
                    </div>
                    {t.status === "waiting" ||
                    t.status === "uploading" ||
                    t.status === "searching" ? (
                      <div className="retag-progress-panel" role="status">
                        <strong>{retagStatus(t.status).title}</strong>
                        <p>{retagStatus(t.status).detail}</p>
                        {t.status === "uploading" ? (
                          <div
                            className="retag-progress"
                            role="progressbar"
                            aria-label={`Uploading ${t.filename}`}
                            aria-valuenow={t.uploadProgress}
                            aria-valuemin={0}
                            aria-valuemax={100}
                          >
                            <span style={{ width: `${t.uploadProgress ?? 0}%` }} />
                          </div>
                        ) : null}
                        <small>
                          {t.uploadProgress !== undefined && t.status === "uploading"
                            ? `${Math.round(t.uploadProgress)}% uploaded · `
                            : ""}
                          {t.startedAt
                            ? `${Math.max(0, Math.floor((now - t.startedAt) / 1000))}s elapsed`
                            : "Waiting for the previous file"}
                        </small>
                      </div>
                    ) : null}

                    {t.status === "error" ? (
                      <p className="mt-2 border-l-2 border-[var(--ui-tier-unsuitable)] bg-muted/50 py-2 pl-3 text-[13px] text-[var(--ui-tier-unsuitable)]">
                        {t.error}
                      </p>
                    ) : null}

                    {!t.overrideUrl && (t.selected || t.candidates.length > 0) ? (
                      <div className="retag-match">
                        {t.selected?.artworkUrl ? (
                          <img
                            src={t.selected.artworkUrl}
                            alt=""
                            width={56}
                            height={56}
                            className="size-14 shrink-0 rounded-md object-cover"
                          />
                        ) : (
                          <div className="retag-artwork" aria-hidden>
                            <Music2 />
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">
                            {t.selected?.title || "No match selected"}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {t.selected?.artist || "—"}
                          </p>
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                            Suggested metadata · review before updating
                          </p>
                        </div>
                      </div>
                    ) : null}

                    {!t.overrideUrl && t.candidates.length > 1 ? (
                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {t.candidates.map((c) => {
                          const active = !t.showOverride && t.selected?.url === c.url;
                          return (
                            <Button
                              variant="outline"
                              disabled={busy}
                              aria-pressed={active}
                              key={c.url}
                              type="button"
                              onClick={() =>
                                updateTrack(t.id, {
                                  selected: c,
                                  overrideUrl: "",
                                  showOverride: false,
                                  approved: true,
                                })
                              }
                              className={`h-auto min-w-0 justify-start whitespace-normal flex items-center gap-2 rounded-md border p-2 text-left transition-colors ${
                                active ? "border-primary bg-accent" : "border-border hover:bg-muted"
                              }`}
                            >
                              {c.artworkUrl ? (
                                <img
                                  src={c.artworkUrl}
                                  alt=""
                                  width={36}
                                  height={36}
                                  className="size-9 shrink-0 rounded object-cover"
                                />
                              ) : (
                                <div className="size-9 shrink-0 rounded bg-muted" aria-hidden />
                              )}
                              <span className="min-w-0">
                                <span className="block truncate text-xs font-medium">
                                  {c.title || "Untitled"}
                                </span>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  {c.artist || "Unknown artist"}
                                </span>
                              </span>
                            </Button>
                          );
                        })}
                      </div>
                    ) : null}

                    {t.status === "ready" || (t.status === "error" && t.inputStorageKey) ? (
                      <div className="retag-source-editor">
                        {t.overrideUrl ? (
                          <div className="retag-custom-source">
                            <Link2 size={16} />
                            <div>
                              <strong>Use details from this link</strong>
                              <a href={t.overrideUrl} target="_blank" rel="noreferrer">
                                {t.overrideUrl}
                                <ExternalLink size={12} />
                              </a>
                              <p>
                                The title, artist and artwork will be fetched when you update this
                                track.
                              </p>
                            </div>
                          </div>
                        ) : !t.selected ? (
                          <p>
                            No match found. Add a track link to supply the title, artist and
                            artwork.
                          </p>
                        ) : null}
                        {t.showOverride ? (
                          <form
                            onSubmit={(event) => {
                              event.preventDefault();
                              const url = validMetadataUrl(t.draftUrl ?? "");
                              if (!url) {
                                updateTrack(t.id, {
                                  urlError: "Enter a SoundCloud or Spotify track link.",
                                });
                                return;
                              }
                              updateTrack(t.id, {
                                overrideUrl: url,
                                showOverride: false,
                                approved: true,
                                status: "ready",
                                error: undefined,
                                urlError: undefined,
                              });
                            }}
                          >
                            <label htmlFor={`metadata-${t.id}`}>
                              Use a different track’s details
                            </label>
                            <p>
                              Paste a SoundCloud or Spotify track link. We’ll use its title, artist
                              and artwork for your file.
                            </p>
                            <div className="retag-link-controls">
                              <Input
                                id={`metadata-${t.id}`}
                                type="url"
                                value={t.draftUrl ?? ""}
                                aria-invalid={Boolean(t.urlError)}
                                aria-describedby={t.urlError ? `metadata-error-${t.id}` : undefined}
                                onChange={(e) =>
                                  updateTrack(t.id, {
                                    draftUrl: e.target.value,
                                    urlError: undefined,
                                  })
                                }
                                placeholder="Paste a SoundCloud or Spotify track link"
                                disabled={busy}
                                autoFocus
                              />
                              <Button
                                type="submit"
                                variant="secondary"
                                disabled={busy || !t.draftUrl?.trim()}
                              >
                                Use this link
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                onClick={() =>
                                  updateTrack(t.id, { showOverride: false, urlError: undefined })
                                }
                              >
                                Cancel
                              </Button>
                            </div>
                            {t.urlError ? (
                              <p
                                id={`metadata-error-${t.id}`}
                                role="alert"
                                className="text-destructive"
                              >
                                {t.urlError}
                              </p>
                            ) : null}
                          </form>
                        ) : (
                          <div className="retag-change-actions">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                updateTrack(t.id, {
                                  showOverride: true,
                                  draftUrl: t.overrideUrl,
                                  urlError: undefined,
                                })
                              }
                            >
                              <Link2 />
                              {t.overrideUrl
                                ? "Change link"
                                : t.selected
                                  ? "Change match"
                                  : "Add track link"}
                            </Button>
                            {t.overrideUrl && t.selected ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  updateTrack(t.id, { overrideUrl: "", approved: true })
                                }
                              >
                                Use suggested match
                              </Button>
                            ) : null}
                            {t.selected && !t.overrideUrl ? (
                              <a href={t.selected.url} target="_blank" rel="noreferrer">
                                Check on SoundCloud <ExternalLink size={12} />
                              </a>
                            ) : null}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </>
        ) : null}

        {(step === "converting" || step === "done") && convertingTracks.length > 0 ? (
          <div className="mt-6 space-y-6">
            {convertingTracks.map((t) => {
              const job = t.job;
              const fileId = job?.result?.fileId;
              const driveUrl = job?.result?.driveUrl;
              return (
                <article key={t.id} className="retag-track">
                  <div className="retag-result-heading">
                    <span className="retag-artwork">
                      <Music2 />
                    </span>
                    <div>
                      <h3>
                        {job?.artist || job?.title
                          ? trackDisplayName(job.artist, job.title)
                          : t.filename}
                      </h3>
                      <p>
                        {retagStatus("converting", job?.stage, job?.status, Boolean(t.error)).title}
                      </p>
                    </div>
                    <Badge variant="outline">
                      {job?.status === "completed" ? (
                        <Check size={12} />
                      ) : t.error ||
                        job?.status === "failed" ||
                        job?.status === "cancelled" ? null : (
                        <Loader2 size={12} className="animate-spin" />
                      )}
                      {job?.status === "completed"
                        ? "Complete"
                        : t.error || job?.status === "failed"
                          ? "Failed"
                          : job?.status === "cancelled"
                            ? "Cancelled"
                            : "In progress"}
                    </Badge>
                  </div>
                  {!t.error &&
                  (!job || !["completed", "failed", "cancelled"].includes(job.status)) ? (
                    <div className="retag-progress-panel" role="status">
                      <p>{retagStatus("converting", job?.stage, job?.status).detail}</p>
                      <div
                        className="retag-progress"
                        role="progressbar"
                        aria-label={`Updating ${t.filename}`}
                        aria-valuenow={job?.progress ?? 0}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <span
                          style={{ width: `${Math.min(100, Math.max(0, job?.progress ?? 0))}%` }}
                        />
                      </div>
                      <small>
                        {Math.max(0, Math.floor((now - (t.startedAt ?? now)) / 1000))}s elapsed ·{" "}
                        {job?.progress ?? 0}% complete · We’ll update this automatically.
                      </small>
                    </div>
                  ) : null}
                  {t.error ? (
                    <p role="alert" className="text-destructive mt-3 text-xs">
                      {t.error}
                    </p>
                  ) : null}
                  {job?.error ? (
                    <p className="mt-3 border-l-2 border-[var(--ui-tier-unsuitable)] bg-muted/50 py-2 pl-3 text-[13px] text-[var(--ui-tier-unsuitable)]">
                      {job.error}
                    </p>
                  ) : null}
                  {job?.status === "completed" ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {fileId ? (
                        <Button asChild size="sm">
                          <a href={`/api/files/${fileId}`}>
                            <Download /> Download FLAC
                          </a>
                        </Button>
                      ) : null}
                      {driveUrl ? (
                        <Button asChild variant="secondary" size="sm">
                          <a href={driveUrl} target="_blank" rel="noreferrer">
                            Open in Drive
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

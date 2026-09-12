"use client";

import { useAuth } from "@clerk/nextjs";
import { isRetagInput, RETAG_INPUT_LABEL, type StemRole } from "@thumper/shared";
import { Download, Loader2, RotateCcw, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusDot } from "../components/status-dot";
import "../ui-theme.css";
import { readJson, uploadAudio } from "@/lib/upload-audio";

type StemFile = {
  fileId: string;
  role: StemRole;
  filename: string;
  mime: string;
  sizeBytes: number;
  driveUrl?: string;
};

type Job = {
  id: string;
  status: string;
  stage: string;
  progress: number;
  title?: string | null;
  artist?: string | null;
  error?: string | null;
  result?: {
    stems?: boolean;
    stemModel?: string;
    stemFiles?: StemFile[];
  } | null;
};

type TrackItem = {
  id: string;
  filename: string;
  jobId?: string;
  job?: Job;
  error?: string;
};

type Step = "upload" | "working" | "done";

const TERMINAL = ["completed", "failed", "cancelled"];

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export default function StemsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { userId } = useAuth();
  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [progressNote, setProgressNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TrackItem[]>([]);
  const [destination, setDestination] = useState("browser");

  const reset = useCallback(() => {
    setStep("upload");
    setBusy(false);
    setProgressNote(null);
    setError(null);
    setTracks([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const uploadOne = useCallback(
    async (file: File): Promise<string> =>
      (await uploadAudio(file, "/api/stems/upload", userId)).key,
    [userId],
  );

  const onFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const selected = [...fileList].filter((f) => isRetagInput(f.name, f.type));
      if (selected.length === 0) {
        setError(`Select one or more ${RETAG_INPUT_LABEL} files`);
        return;
      }

      setError(null);
      setBusy(true);
      setStep("working");
      const next: TrackItem[] = [];

      try {
        for (let i = 0; i < selected.length; i++) {
          const file = selected[i]!;
          const item: TrackItem = {
            id: crypto.randomUUID(),
            filename: file.name,
          };
          next.push(item);
          setTracks([...next]);

          setProgressNote(`Uploading ${i + 1}/${selected.length}: ${file.name}`);
          try {
            const key = await uploadOne(file);
            const res = await fetch("/api/stems/start", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                inputStorageKey: key,
                destination,
              }),
            });
            const data = await readJson(res);
            if (!res.ok) throw new Error(String(data.error || "Could not start separation"));
            const job = data.job as Job;
            item.jobId = job.id;
            item.job = job;
          } catch (err) {
            item.error = err instanceof Error ? err.message : String(err);
          }
          setTracks([...next]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        setProgressNote(null);
      }
    },
    [uploadOne, destination],
  );

  // Poll while anything is still running.
  useEffect(() => {
    if (step !== "working") return;
    const active = tracks.filter((t) => t.jobId);
    if (active.length === 0) return;

    if (active.every((t) => t.job && TERMINAL.includes(t.job.status))) {
      setStep("done");
      return;
    }

    const id = window.setInterval(async () => {
      try {
        const res = await fetch("/api/jobs");
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
  }, [step, tracks]);

  const queued = tracks.filter((t) => t.jobId || t.error);

  return (
    <div className="ui-scope min-h-screen">
      <div className="mx-auto max-w-2xl px-5 pt-10 pb-28">
        <h1 className="text-lg font-semibold tracking-tight">Stem separation</h1>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Split a track into instrumental and vocals. One pass produces both — download whichever
          you need.
        </p>

        {step !== "upload" ? (
          <div className="mt-5 flex items-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-7 text-xs"
              onClick={reset}
            >
              <RotateCcw /> Start over
            </Button>
          </div>
        ) : null}

        {error ? (
          <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {progressNote ? (
          <p className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            {progressNote}
          </p>
        ) : null}

        {step === "upload" ? (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
              <span className="text-xs text-muted-foreground">Deliver to</span>
              <Select value={destination} onValueChange={setDestination}>
                <SelectTrigger className="h-8 w-44 bg-background text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="browser">Browser download</SelectItem>
                  <SelectItem value="drive">Google Drive</SelectItem>
                  <SelectItem value="both">Both</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="mt-4 rounded-xl border border-border bg-card p-5 shadow-lg shadow-black/30">
              <label
                className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-input px-6 py-10 text-center transition-colors hover:border-primary/60 hover:bg-muted/50 ${
                  busy ? "pointer-events-none opacity-60" : ""
                }`}
              >
                {busy ? (
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                ) : (
                  <Upload className="size-5 text-muted-foreground" />
                )}
                <span className="text-sm font-medium">
                  {busy ? "Working…" : "Choose audio files"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {RETAG_INPUT_LABEL} — up to 500 MB each
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="sr-only"
                  accept=".wav,.mp3,.m4a,.flac,audio/wav,audio/x-wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/flac"
                  multiple
                  disabled={busy}
                  onChange={(e) => void onFiles(e.target.files)}
                />
              </label>
            </div>
          </>
        ) : null}

        {queued.length > 0 ? (
          <div className="mt-6 space-y-7">
            {queued.map((t) => {
              const job = t.job;
              const stems = job?.result?.stemFiles ?? [];
              const failed = Boolean(t.error) || job?.status === "failed";
              return (
                <article key={t.id} className="relative pl-5">
                  <span className="absolute top-1.5 left-0">
                    <StatusDot status={failed ? "failed" : (job?.status ?? "queued")} />
                  </span>
                  <h2 className="truncate text-[15px] leading-tight font-semibold">
                    {job?.title || t.filename}
                  </h2>

                  {job && job.status !== "completed" && !failed ? (
                    <>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {job.stage} · {job.progress}%
                      </p>
                      <div className="mt-2.5 h-0.5 w-full overflow-hidden rounded bg-muted">
                        <span
                          className="block h-full bg-primary transition-[width]"
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                    </>
                  ) : null}

                  {t.error || job?.error ? (
                    <p className="mt-3 border-l-2 border-[var(--ui-tier-unsuitable)] bg-muted/50 py-2 pl-3 text-[13px] text-[var(--ui-tier-unsuitable)]">
                      {t.error || job?.error}
                    </p>
                  ) : null}

                  {stems.length > 0 ? (
                    <div className="mt-3 space-y-3">
                      {stems.map((s) => (
                        <div key={s.fileId} className="rounded-lg border border-border bg-card p-3">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold capitalize">{s.role}</span>
                            <span className="text-[11px] text-muted-foreground">
                              {formatSize(s.sizeBytes)}
                            </span>
                            <div className="ml-auto flex gap-2">
                              <Button asChild size="sm" variant="secondary">
                                <a href={`/api/files/${s.fileId}`}>
                                  <Download /> FLAC
                                </a>
                              </Button>
                              {s.driveUrl ? (
                                <Button asChild size="sm" variant="ghost">
                                  <a href={s.driveUrl} target="_blank" rel="noreferrer">
                                    Drive
                                  </a>
                                </Button>
                              ) : null}
                            </div>
                          </div>
                          {/* biome-ignore lint/a11y/useMediaCaption: a separated
                              stem has no caption track to provide. */}
                          <audio
                            controls
                            preload="none"
                            className="mt-2 h-9 w-full"
                            src={`/api/files/${s.fileId}`}
                          />
                        </div>
                      ))}
                      {stems.length > 1 ? (
                        <Button asChild size="sm" variant="outline">
                          <a href={`/api/files/zip?jobId=${job?.id}`}>
                            <Download /> Download both (zip)
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  ) : null}

                  {job?.result?.stemModel ? (
                    <p className="mt-2 font-mono text-[10px] text-muted-foreground/60">
                      {job.result.stemModel}
                    </p>
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

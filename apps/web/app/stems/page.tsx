"use client";

import { useAuth } from "@clerk/nextjs";
import { isRetagInput, RETAG_INPUT_LABEL, type StemRole } from "@thumper/shared";
import { Check, Download, LoaderCircle, Music2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { processingEstimate, stageInfo } from "./progress";
import { StemPlayer } from "./stem-player";
import "./stems.css";
import "../ui-theme.css";
import "../downloader/downloader.css";
import "../audio-tools.css";
import { readJson, uploadAudio } from "@/lib/upload-audio";
import { AudioUpload } from "../components/audio-upload";

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
  uploadState?: "waiting" | "uploading" | "starting";
  uploadProgress?: number;
  startedAt: number;
  sample?: { progress: number; at: number };
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
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TrackItem[]>([]);
  const [destination, setDestination] = useState("browser");

  const reset = useCallback(() => {
    setStep("upload");
    setBusy(false);
    setError(null);
    setTracks([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const uploadOne = useCallback(
    async (file: File, onProgress: (percentage: number) => void): Promise<string> =>
      (await uploadAudio(file, "/api/stems/upload", userId, onProgress)).key,
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
      const next: TrackItem[] = selected.map((file) => ({
        id: crypto.randomUUID(),
        filename: file.name,
        startedAt: Date.now(),
        uploadState: "waiting",
      }));
      setTracks(next);
      const patch = (id: string, update: Partial<TrackItem>) =>
        setTracks((prev) => prev.map((item) => (item.id === id ? { ...item, ...update } : item)));
      try {
        for (let i = 0; i < selected.length; i++) {
          const file = selected[i]!;
          const item = next[i]!;
          patch(item.id, { uploadState: "uploading", startedAt: Date.now() });
          try {
            const key = await uploadOne(file, (uploadProgress) =>
              patch(item.id, { uploadProgress }),
            );
            patch(item.id, { uploadState: "starting" });
            const res = await fetch("/api/stems/start", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ inputStorageKey: key, destination }),
            });
            const data = await readJson(res);
            if (!res.ok) throw new Error(String(data.error || "Could not start separation"));
            const job = data.job as Job;
            patch(item.id, { jobId: job.id, job, uploadState: undefined });
          } catch (err) {
            patch(item.id, {
              error: err instanceof Error ? err.message : String(err),
              uploadState: undefined,
            });
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [uploadOne, destination],
  );

  // Poll while anything is still running.
  useEffect(() => {
    if (step !== "working") return;
    if (
      !busy &&
      tracks.length > 0 &&
      tracks.every((t) => t.error || (t.job && TERMINAL.includes(t.job.status)))
    ) {
      setStep("done");
    }
  }, [step, tracks, busy]);

  useEffect(() => {
    if (step !== "working") return;
    let polling = false;
    const controller = new AbortController();
    const id = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const res = await fetch("/api/jobs", { signal: controller.signal });
        if (!res.ok) return;
        const data = await readJson(res);
        const rows = (data.jobs ?? []) as Job[];
        setTracks((prev) =>
          prev.map((t) => {
            if (!t.jobId) return t;
            const current = rows.find((row) => row.id === t.jobId);
            return current
              ? {
                  ...t,
                  job: current,
                  sample:
                    current.stage === "separating" && !t.sample
                      ? { progress: current.progress, at: Date.now() }
                      : t.sample,
                }
              : t;
          }),
        );
      } catch {
        /* keep polling */
      } finally {
        polling = false;
      }
    }, 1500);

    return () => {
      controller.abort();
      window.clearInterval(id);
    };
  }, [step]);

  useEffect(() => {
    if (step !== "working") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  const queued = tracks;

  return (
    <div className="ui-scope downloader min-h-screen">
      <div className="downloader-shell">
        <header className="downloader-heading">
          <div>
            <h1>Separate vocals and music</h1>
            <p>
              Split your tracks into vocals and instrumental audio. Preview and download each part.
            </p>
          </div>
          <span className="downloader-format">Audio format: FLAC</span>
        </header>

        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
        {step === "upload" ? (
          <div>
            <section className="downloader-composer">
              <div className="downloader-section-title">
                <h2>Upload audio</h2>
              </div>
              <p className="downloader-description">
                Choose where to save your files before uploading.
              </p>
              <label className="downloader-label" htmlFor="stems-destination">
                Save to
              </label>
              <Select value={destination} onValueChange={setDestination}>
                <SelectTrigger id="stems-destination" className="w-full bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start" sideOffset={6}>
                  <SelectItem value="browser">This device</SelectItem>
                  <SelectItem value="drive">Google Drive</SelectItem>
                  <SelectItem value="both">Device + Google Drive</SelectItem>
                </SelectContent>
              </Select>
              {destination !== "browser" ? (
                <p className="downloader-description">
                  Connect Google Drive from your account menu before uploading.
                </p>
              ) : null}
              <AudioUpload
                busy={busy}
                inputRef={fileInputRef}
                onFiles={(files) => void onFiles(files)}
              />
              <p className="downloader-description">
                Separation starts as soon as you choose your files.
              </p>
            </section>
          </div>
        ) : null}

        <section className="downloader-queue" aria-labelledby="stems-results">
          <div className="downloader-queue-heading">
            <div>
              <h2 id="stems-results">
                Your tracks <span>{queued.length}</span>
              </h2>
              <p className="downloader-description">
                Follow progress and listen to the separated audio here.
              </p>
            </div>
            {step !== "upload" ? (
              <div className="mt-5 flex items-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7 text-xs"
                  onClick={reset}
                  disabled={
                    busy ||
                    (step === "working" &&
                      tracks.some((t) => t.jobId && !TERMINAL.includes(t.job?.status ?? "queued")))
                  }
                >
                  <RotateCcw /> Start over
                </Button>
              </div>
            ) : null}
          </div>
          {queued.length === 0 ? (
            <div className="downloader-empty">
              <h3>No tracks yet</h3>
              <p>Choose audio files above to get started.</p>
            </div>
          ) : null}
          {queued.length > 0 ? (
            <div className="mt-6 space-y-7">
              {queued.map((t) => {
                const job = t.job;
                const stems = job?.result?.stemFiles ?? [];
                const failed = Boolean(t.error) || job?.status === "failed";
                const info = stageInfo(t.uploadState, job?.stage, job?.status, failed);
                const elapsed = Math.max(0, Math.floor((now - t.startedAt) / 1000));
                const estimate = processingEstimate(t.sample, job?.progress ?? 0, now);
                const finished = failed || (job && TERMINAL.includes(job.status));
                const stagePercent =
                  t.uploadState === "uploading"
                    ? t.uploadProgress
                    : job?.stage === "separating"
                      ? Math.max(0, Math.min(100, Math.round(((job.progress - 10) / 60) * 100)))
                      : undefined;
                return (
                  <article key={t.id} className="stem-track">
                    <header className="stem-track-heading">
                      <span className="stem-track-icon">
                        <Music2 size={21} />
                      </span>
                      <div>
                        <h3>{job?.title || t.filename}</h3>
                        <p>{"Vocals + instrumental · FLAC"}</p>
                      </div>
                      <span className="stem-status" data-complete={job?.status === "completed"}>
                        {job?.status === "completed" ? (
                          <Check size={14} />
                        ) : !finished ? (
                          <LoaderCircle size={14} className="animate-spin" />
                        ) : null}
                        {info.title}
                      </span>
                    </header>
                    {!finished ? (
                      <div className="stem-processing">
                        <ol className="stem-stages" aria-label="Separation progress">
                          {["Upload", "AI separation", "Save files"].map((label, index) => (
                            <li
                              key={label}
                              data-active={index === info.step}
                              data-done={index < info.step}
                              aria-current={index === info.step ? "step" : undefined}
                            >
                              <span>{index < info.step ? <Check size={13} /> : index + 1}</span>
                              {label}
                            </li>
                          ))}
                        </ol>
                        <div className="stem-progress-copy" role="status">
                          <strong>{info.title}</strong>
                          <span>
                            {t.uploadState === "uploading" && t.uploadProgress !== undefined
                              ? `${Math.round(t.uploadProgress)}% uploaded`
                              : job?.stage === "separating"
                                ? `${Math.max(0, Math.min(100, Math.round((((job.progress ?? 10) - 10) / 60) * 100)))}% separated`
                                : null}
                          </span>
                        </div>
                        <p>{info.description}</p>
                        <div
                          className="stem-progress"
                          role="progressbar"
                          aria-label={info.title}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={stagePercent}
                        >
                          <span
                            className={stagePercent === undefined ? "stem-indeterminate" : ""}
                            style={{ width: `${stagePercent ?? 30}%` }}
                          />
                        </div>
                        <div className="stem-timing">
                          <span>
                            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}{" "}
                            elapsed
                          </span>
                          <span>
                            {job?.stage === "separating"
                              ? (estimate ?? "Estimating time as the AI makes progress…")
                              : t.uploadState === "uploading"
                                ? "Upload time depends on file size and your connection."
                                : "We’ll update this automatically."}
                          </span>
                        </div>
                      </div>
                    ) : null}

                    {t.error || job?.error ? (
                      <p className="mt-3 border-l-2 border-[var(--ui-tier-unsuitable)] bg-muted/50 py-2 pl-3 text-[13px] text-[var(--ui-tier-unsuitable)]">
                        {t.error || job?.error}
                      </p>
                    ) : null}

                    {stems.length > 0 ? (
                      <div className="mt-3 space-y-3">
                        {stems.map((s) => (
                          <StemPlayer
                            key={s.fileId || s.role}
                            fileId={s.fileId}
                            role={s.role}
                            size={formatSize(s.sizeBytes)}
                            driveUrl={s.driveUrl}
                          />
                        ))}
                        {stems.length > 1 && stems.every((s) => s.fileId) ? (
                          <Button asChild size="sm" variant="outline">
                            <a href={`/api/files/zip?jobId=${job?.id}`}>
                              <Download /> Download both (zip)
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
        </section>
      </div>
    </div>
  );
}

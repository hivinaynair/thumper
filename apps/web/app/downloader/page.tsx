"use client";

import { useCallback, useEffect, useState } from "react";

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
    unmatchedCount?: number;
    matchScore?: number;
  } | null;
};

export default function DownloaderPage() {
  const [url, setUrl] = useState("");
  const [audioFormat, setAudioFormat] = useState("flac");
  const [destination, setDestination] = useState("browser");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [cookieProvider, setCookieProvider] = useState("youtube");
  const [cookieText, setCookieText] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/jobs");
    if (!res.ok) return;
    const data = await res.json();
    setJobs(data.jobs ?? []);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [refresh]);

  async function createJob(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, audioFormat, destination }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setUrl("");
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancelJob(id: string) {
    await fetch(`/api/jobs/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function saveCookies(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const res = await fetch("/api/cookies", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: cookieProvider, cookies: cookieText }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error ?? "Cookie upload failed");
      return;
    }
    setCookieText("");
    setMessage("Cookies saved (encrypted at rest)");
  }

  return (
    <div style={{ display: "grid", gap: "1.25rem" }}>
      <div>
        <h1 style={{ margin: "0 0 0.35rem" }}>Downloader</h1>
        <p className="muted" style={{ margin: 0 }}>
          Jobs run on the worker (concurrency 1). Spotify links are mirrored to
          YouTube/SoundCloud with a confidence score — audio is never taken from
          Spotify.
        </p>
      </div>

      <form className="panel" onSubmit={createJob}>
        <h2>New job</h2>
        <label>
          URL (YouTube / SoundCloud / Spotify playlist or track)
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            required
          />
        </label>
        <div className="row">
          <label>
            Format
            <select
              value={audioFormat}
              onChange={(e) => setAudioFormat(e.target.value)}
            >
              <option value="flac">FLAC (default)</option>
              <option value="wav">WAV</option>
              <option value="alac">ALAC</option>
            </select>
          </label>
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
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Queuing…" : "Queue download"}
        </button>
        {message ? <p className="muted">{message}</p> : null}
      </form>

      <form className="panel" onSubmit={saveCookies}>
        <h2>Cookies</h2>
        <p className="muted" style={{ margin: 0 }}>
          Netscape format. Encrypted at rest. Or use the Thumper Chrome
          extension.
        </p>
        <label>
          Provider
          <select
            value={cookieProvider}
            onChange={(e) => setCookieProvider(e.target.value)}
          >
            <option value="youtube">YouTube</option>
            <option value="soundcloud">SoundCloud</option>
          </select>
        </label>
        <label>
          Cookie file contents
          <textarea
            rows={5}
            value={cookieText}
            onChange={(e) => setCookieText(e.target.value)}
            placeholder="# Netscape HTTP Cookie File"
            required
          />
        </label>
        <button className="btn secondary" type="submit">
          Save encrypted cookies
        </button>
      </form>

      <section className="panel">
        <h2>Jobs</h2>
        <div className="jobs">
          {jobs.length === 0 ? (
            <p className="muted">No jobs yet.</p>
          ) : (
            jobs.map((job) => (
              <article key={job.id} className="job">
                <header>
                  <strong>
                    {job.artist ? `${job.artist} — ` : ""}
                    {job.title ?? job.sourceUrl}
                  </strong>
                  <span className={`status-${job.status}`}>{job.status}</span>
                </header>
                <div className="muted">
                  {job.stage} · {job.audioFormat} · {job.destination}
                  {job.result?.playlist
                    ? ` · playlist (${job.result.trackCount ?? "?"} tracks${
                        job.result.unmatchedCount
                          ? `, ${job.result.unmatchedCount} unmatched`
                          : ""
                      })`
                    : ""}
                  {job.result?.matchScore
                    ? ` · match ${job.result.matchScore}`
                    : ""}
                  {job.result?.qualityLabel
                    ? ` · ${job.result.qualityLabel}`
                    : ""}
                </div>
                {job.matchedUrl ? (
                  <div className="muted">Mirror: {job.matchedUrl}</div>
                ) : null}
                <div className="bar">
                  <span style={{ width: `${job.progress}%` }} />
                </div>
                {job.error ? (
                  <div className="status-failed">{job.error}</div>
                ) : null}
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  {job.status === "queued" || job.status === "running" ? (
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => void cancelJob(job.id)}
                    >
                      Cancel
                    </button>
                  ) : null}
                  {job.result?.fileId ? (
                    <a className="btn" href={`/api/files/${job.result.fileId}`}>
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
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

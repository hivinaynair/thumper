"use client";

/**
 * PROTOTYPE — Variant A: "Console".
 *
 * Bet: the queue is a work list, not a feed. Everything collapses to one
 * sticky command bar plus a dense table, so 40 playlist tracks fit on screen
 * and playlist children nest under their parent instead of running flat.
 */
import { trackDisplayName } from "@thumper/shared";
import { useState } from "react";
import { jobsToRetry, retryButtonLabel } from "../../../lib/cookie-retry";
import type { Job } from "../page";
import {
  groupJobs,
  shortSource,
  verdictOf,
  type DownloaderViewModel,
} from "./view-model";
import "./prototype.css";

const COOKIE_KEYS = [
  ["youtube", "YT"],
  ["soundcloud", "SC"],
  ["spotify", "SP"],
  ["instagram", "IG"],
] as const;

function name(job: Job): string {
  if (job.title || job.artist) return trackDisplayName(job.artist, job.title);
  return job.sourceUrl;
}

export function VariantAConsole(vm: DownloaderViewModel) {
  const { topLevel, childrenOf } = groupJobs(vm.jobs);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const Row = ({ job, child }: { job: Job; child?: boolean }) => {
    const verdict = verdictOf(job);
    const retryTargets = jobsToRetry(job, vm.jobs);
    const kids = child ? [] : childrenOf(job.id);
    const isGroup = kids.length > 0;
    return (
      <>
        <tr className={isGroup ? "pv-group" : child ? "pv-child" : undefined}>
          <td className="pv-name">
            {isGroup ? (
              <button
                type="button"
                className="pv-disclose"
                onClick={() => toggle(job.id)}
              >
                {collapsed.has(job.id) ? "▸" : "▾"}
              </button>
            ) : null}
            <span className={`pv-dot ${job.status}`} /> {name(job)}
            {isGroup ? (
              <span className="pv-tier"> · {kids.length} tracks</span>
            ) : null}
          </td>
          <td className="pv-num">{shortSource(job)}</td>
          <td className="pv-num">{job.audioFormat}</td>
          <td>
            <span
              className={`pv-tier ${verdict.tier}`}
              title={verdict.detail ?? undefined}
            >
              {verdict.lead}
            </span>
          </td>
          <td>
            <div className="pv-rail">
              <span style={{ width: `${job.progress}%` }} />
            </div>
          </td>
          <td>
            <div className="pv-row-actions">
              {job.status === "queued" || job.status === "running" ? (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => vm.cancelJob(job.id)}
                >
                  Cancel
                </button>
              ) : null}
              {retryTargets.length > 0 ? (
                <button
                  type="button"
                  className="btn"
                  disabled={vm.retryingId !== null}
                  onClick={() => vm.retryWithNewCookies(job.id)}
                >
                  {vm.retryingId === job.id
                    ? "…"
                    : retryButtonLabel(retryTargets.length)}
                </button>
              ) : null}
              {job.result?.fileId ? (
                <a className="btn" href={`/api/files/${job.result.fileId}`}>
                  Get
                </a>
              ) : null}
              {job.result?.manualDownloadUrl ? (
                <a
                  className="btn secondary"
                  href={job.result.manualDownloadUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Gate
                </a>
              ) : null}
            </div>
          </td>
        </tr>
        {job.error && !child ? (
          <tr>
            <td colSpan={6} className="job-error">
              {job.error}
            </td>
          </tr>
        ) : null}
        {isGroup && !collapsed.has(job.id)
          ? kids.map((kid) => <Row key={kid.id} job={kid} child />)
          : null}
      </>
    );
  };

  return (
    <main className="pv-console">
      <form className="pv-console-bar" onSubmit={vm.createJob}>
        <h1>Downloader</h1>
        <input
          type="text"
          value={vm.url}
          onChange={(e) => vm.setUrl(e.target.value)}
          placeholder="YouTube, SoundCloud, or Spotify"
          required
        />
        <select
          value={vm.destination}
          onChange={(e) => vm.setDestination(e.target.value)}
        >
          <option value="browser">Browser</option>
          <option value="drive">Drive</option>
          <option value="both">Both</option>
        </select>
        <button className="btn" type="submit" disabled={!vm.canQueue}>
          {vm.busy ? "Queuing…" : "Queue"}
        </button>
        <div className="pv-console-flags">
          <label>
            <input
              type="checkbox"
              checked={vm.freeDownloadsOnly}
              onChange={(e) => vm.setFreeDownloadsOnly(e.target.checked)}
            />
            free only
          </label>
          <label>
            <input
              type="checkbox"
              checked={vm.clubReadyOnly}
              onChange={(e) => vm.setClubReadyOnly(e.target.checked)}
            />
            club-ready
          </label>
        </div>
        <div className="pv-console-chips">
          {COOKIE_KEYS.map(([key, label]) => (
            <span
              key={key}
              className={`cookie-sync-chip${vm.cookies?.[key]?.present ? " is-synced" : " is-missing"}`}
            >
              <span className="cookie-sync-dot" aria-hidden="true" />
              {label}
            </span>
          ))}
          <button
            type="button"
            className="cookie-sync-btn"
            onClick={() => vm.syncCookies()}
            disabled={vm.syncing || !vm.extensionReady}
          >
            {vm.syncing ? "…" : vm.anyCookiesPresent ? "Refresh" : "Sync"}
          </button>
          {vm.downloadableCount > 0 ? (
            // eslint-disable-next-line @next/next/no-html-link-for-pages
            <a className="btn" href="/api/files/zip">
              Zip ({vm.downloadableCount})
            </a>
          ) : null}
          {vm.finishedCount > 0 ? (
            <button
              type="button"
              className="btn ghost"
              disabled={vm.clearing}
              onClick={() => vm.clearFinishedJobs()}
            >
              Clear
            </button>
          ) : null}
        </div>
      </form>

      {vm.gate.reason || vm.message ? (
        <p
          className={`flash${vm.messageTone === "error" || !vm.gate.ready ? " error" : ""}`}
          style={{ margin: "10px 14px" }}
        >
          {vm.message ?? vm.gate.reason}
        </p>
      ) : null}

      {topLevel.length === 0 ? (
        <p className="muted" style={{ padding: "40px 14px" }}>
          No jobs yet.
        </p>
      ) : (
        <table className="pv-table">
          <thead>
            <tr>
              <th>Track</th>
              <th>Source</th>
              <th>Fmt</th>
              <th>Quality</th>
              <th>Progress</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {topLevel.map((job) => (
              <Row key={job.id} job={job} />
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

"use client";

/**
 * PROTOTYPE — Variant B: "Focus".
 *
 * Bet: the per-job verdict is the valuable part, and the current page can't
 * show it without burying every other job under badges. So the list gets thin
 * (name + state only) and one selected job gets a whole pane.
 */
import { trackDisplayName } from "@thumper/shared";
import { useState } from "react";
import { jobsToRetry, retryButtonLabel } from "../../../lib/cookie-retry";
import { HYPEDDIT_ORIGINAL_COPY } from "../result-copy";
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

export function VariantBFocus(vm: DownloaderViewModel) {
  const { topLevel, childrenOf } = groupJobs(vm.jobs);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    vm.jobs.find((job) => job.id === selectedId) ?? topLevel[0] ?? null;
  const kids = selected ? childrenOf(selected.id) : [];
  const rollup = selected ? vm.rollups.get(selected.id) : undefined;
  const retryTargets = selected ? jobsToRetry(selected, vm.jobs) : [];

  return (
    <main className="pv-focus">
      <div className="pv-focus-rail">
        <form className="pv-focus-compose" onSubmit={vm.createJob}>
          <input
            type="text"
            value={vm.url}
            onChange={(e) => vm.setUrl(e.target.value)}
            placeholder="Paste a link…"
            required
          />
          <details>
            <summary>Options</summary>
            <select
              value={vm.destination}
              onChange={(e) => vm.setDestination(e.target.value)}
            >
              <option value="browser">Browser</option>
              <option value="drive">Google Drive</option>
              <option value="both">Both</option>
            </select>
            <label className="check-row">
              <input
                type="checkbox"
                checked={vm.freeDownloadsOnly}
                onChange={(e) => vm.setFreeDownloadsOnly(e.target.checked)}
              />
              <span>Free downloads only</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={vm.clubReadyOnly}
                onChange={(e) => vm.setClubReadyOnly(e.target.checked)}
              />
              <span>Club-ready only</span>
            </label>
          </details>
          <button className="btn" type="submit" disabled={!vm.canQueue}>
            {vm.busy ? "Queuing…" : "Queue download"}
          </button>
          {vm.message ?? vm.gate.reason ? (
            <p
              className={`flash${vm.messageTone === "error" || !vm.gate.ready ? " error" : ""}`}
            >
              {vm.message ?? vm.gate.reason}
            </p>
          ) : null}
        </form>

        <div className="pv-focus-list">
          {topLevel.length === 0 ? (
            <p className="muted" style={{ padding: 14 }}>
              No jobs yet.
            </p>
          ) : (
            topLevel.map((job) => {
              const count = childrenOf(job.id).length;
              return (
                <button
                  key={job.id}
                  type="button"
                  className={`pv-focus-item${selected?.id === job.id ? " is-active" : ""}`}
                  onClick={() => setSelectedId(job.id)}
                >
                  <span className="pv-focus-item-top">
                    <span className={`pv-dot ${job.status}`} />
                    <span className="pv-focus-item-name">{name(job)}</span>
                  </span>
                  <span className="pv-focus-item-sub">
                    {count > 0 ? `${count} tracks · ` : ""}
                    {job.audioFormat} ·{" "}
                    <span className={`pv-tier ${verdictOf(job).tier}`}>
                      {verdictOf(job).lead}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="pv-focus-cookies">
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
        </div>
      </div>

      <div className="pv-focus-detail">
        {!selected ? (
          <p className="pv-focus-empty">Queue something to see it here.</p>
        ) : (
          <>
            <h2>{name(selected)}</h2>
            <p className="muted">{selected.sourceUrl}</p>

            <div className="bar" style={{ marginTop: 18 }}>
              <span style={{ width: `${selected.progress}%` }} />
            </div>

            <dl className="pv-focus-grid">
              <div>
                <dt>Status</dt>
                <dd>
                  {selected.status} · {selected.stage}
                </dd>
              </div>
              <div>
                <dt>Format</dt>
                <dd>{selected.audioFormat}</dd>
              </div>
              <div>
                <dt>Destination</dt>
                <dd>{selected.destination}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{shortSource(selected)}</dd>
              </div>
              {selected.result?.matchScore ? (
                <div>
                  <dt>Match</dt>
                  <dd>{selected.result.matchScore}</dd>
                </div>
              ) : null}
              {selected.result?.qualityLabel ? (
                <div>
                  <dt>Quality</dt>
                  <dd>{selected.result.qualityLabel}</dd>
                </div>
              ) : null}
            </dl>

            {selected.result?.hypedditOriginal ? (
              <div className="quality-badge original">
                <strong>Artist original</strong>
                {` — ${HYPEDDIT_ORIGINAL_COPY}`}
              </div>
            ) : null}
            {selected.result?.soundcloudOriginal ? (
              <div className="quality-badge original">
                <strong>SoundCloud original</strong>
                {" — free download (artist upload, not a stream)"}
              </div>
            ) : null}
            {verdictOf(selected).detail ? (
              <div className={`quality-badge ${verdictOf(selected).tier}`}>
                <strong>{verdictOf(selected).lead}</strong>
                {` — ${verdictOf(selected).detail}`}
              </div>
            ) : null}
            {selected.result?.warnings?.length ? (
              <ul className="job-warnings">
                {selected.result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
            {selected.error ? (
              <div className="job-error">{selected.error}</div>
            ) : null}

            <div className="job-actions" style={{ marginTop: 20 }}>
              {selected.status === "queued" || selected.status === "running" ? (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => vm.cancelJob(selected.id)}
                >
                  Cancel
                </button>
              ) : null}
              {retryTargets.length > 0 ? (
                <button
                  type="button"
                  className="btn"
                  disabled={vm.retryingId !== null}
                  onClick={() => vm.retryWithNewCookies(selected.id)}
                >
                  {vm.retryingId === selected.id
                    ? "Retrying…"
                    : retryButtonLabel(retryTargets.length)}
                </button>
              ) : null}
              {selected.result?.fileId ? (
                <a className="btn" href={`/api/files/${selected.result.fileId}`}>
                  Download
                </a>
              ) : null}
              {selected.result?.driveUrl ? (
                <a
                  className="btn secondary"
                  href={selected.result.driveUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Drive
                </a>
              ) : null}
            </div>

            {kids.length > 0 ? (
              <>
                <h3 style={{ marginTop: 30 }}>
                  Tracks{rollup ? ` — ${rollup.done}/${rollup.total} done` : ""}
                </h3>
                <div className="pv-focus-list" style={{ marginTop: 10 }}>
                  {kids.map((kid) => (
                    <button
                      key={kid.id}
                      type="button"
                      className="pv-focus-item"
                      onClick={() => setSelectedId(kid.id)}
                    >
                      <span className="pv-focus-item-top">
                        <span className={`pv-dot ${kid.status}`} />
                        <span className="pv-focus-item-name">{name(kid)}</span>
                      </span>
                      <span className="pv-focus-item-sub">
                        <span className={`pv-tier ${verdictOf(kid).tier}`}>
                          {verdictOf(kid).lead}
                        </span>
                        {verdictOf(kid).detail ? ` — ${verdictOf(kid).detail}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}

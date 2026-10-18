# Download failure reasons and retry

Make every failed download say why it failed, in the queue, and let any
failure be re-run — one track or the whole batch.

## Why

A 43-track Spotify playlist finished 32/43 with 11 failures. The queue
showed each failed track as a bare red `FAILED`. The reason existed — the
pipeline writes a usable sentence to `jobs.error` — but the UI only hung it
on a `title` tooltip, so it was invisible in practice.

Retry existed too, but `jobsToRetry` filtered to cookie-class failures only
(`cookieNeedsRefresh`), and only from the playlist parent. A track that
failed on a rate limit, a Drive token, or an unreadable playlist had no
button at all. Re-queueing meant pasting the link again by hand.

## Shape

Three pieces, none of which need a migration.

### Classify `jobs.error` in the web app

New `apps/web/app/downloader/failure.ts`: `classifyFailure(job)` returns
`{ code, headline, hint, retryable }` from `job.error` plus `job.result`.

Pattern-matching the stored string, rather than adding an `errorCode`
column and typed errors at every throw site, because:

- It works on rows that already failed. A column would leave the 11
  failures in the queue classified as `unknown` forever.
- The pipeline's messages are already written as user-facing copy
  ("YouTube blocked this download (bot check), even with your synced
  cookies. Re-sync…"). The classifier picks a short headline and a next
  step; it does not have to invent the explanation.
- A column still needs the string fallback for old rows, so it is strictly
  more code, not less.

If the regexes start drifting from the pipeline copy, add codes then.

| code | headline | hint |
| --- | --- | --- |
| `youtube-bot-check` | YouTube bot check | Re-sync YouTube cookies, then retry |
| `youtube-no-formats` | No playable YouTube audio | Cookies may be stale — re-sync |
| `soundcloud-preview` | Preview only | Geo-blocked or Go+. Try the artist's free download, then Retag |
| `soundcloud-session` | SoundCloud session expired | Re-sync SoundCloud cookies |
| `no-mirror` | No match found | Queue the YouTube or SoundCloud link directly |
| `quality-gate` | Below club-ready | Turn off Club-ready only to take it anyway |
| `manual-download` | Store or stream page | Download by hand, then Retag |
| `rate-limited` | Rate limited | Wait a minute and retry |
| `drive` | Google Drive | Reconnect Google in your account menu |
| `playlist-unreadable` | Playlist unreadable | Retry in a minute |
| `unknown` | Download failed | *(raw error shown instead)* |

`unknown` shows the verbatim string rather than hiding it behind friendly
copy that says nothing.

### Show the reason inline

A failed track row gains a second line: `headline — hint`, muted, always
visible, so eleven reasons are scannable without eleven hovers. The row
becomes a button that expands to the verbatim `jobs.error`. Top-level
failed jobs get the same treatment inside `download-row-details`.

`verdictOf` keeps the one-word tier badge. The classifier owns the
explanation. The two do not overlap.

### Widen retry

`jobsToRetry` drops the `cookieNeedsRefresh` filter: any `failed` job
qualifies — a playlist parent contributes its failed children, a lone job
contributes itself. `POST /api/jobs/[id]/retry` is unchanged in shape; it
already handles Drive folder context, pg-boss vs Modal, concurrency-limited
waking, and the requeue field reset.

Per-track retry needs no new route. `enqueuePlaylistChildren` stamps
`parentJobId`, `driveFolderId`, and `clubReadyOnly` onto each child's own
`result`, and `downloadPayloadFromJob` reads them from the row, so a child
re-queues correctly when POSTed on its own id.

Two existing behaviours are wrong once retry is no longer cookie-only:

- The cookie precheck 400s the entire batch when cookies are missing. With
  a mixed batch (7 bot-check + 4 rate-limited) that blocks four retries
  that would have worked. Make it partial: retry what it can, respond
  `{ retried, skipped, reason }`.
- `requeueFields()` clears `error` but not `result`, so a retried job keeps
  `qualityRejected` / `manualDownloadUrl` / `djTier` until a new result
  lands, rendering a stale "Open link" button on a queued job. Clear the
  failure-specific result fields on requeue.

## Tests

`failure.test.ts` asserts the classifier against the actual strings thrown
in `run-job.ts` and `download.ts`, so a copy change that breaks a regex
fails a test rather than silently degrading to `unknown`. Extend
`cookie-retry.test.ts` for the widened `jobsToRetry` and the partial-skip
response, and `job-view.test.ts` for the expand state.

The cookie-setup banner (`failedNeedRefresh`, `cookieNeedsRefresh`) keeps
its current meaning — it is about prompting a re-sync, not about retry
eligibility.

## Out of scope

Spotify tracks with no confident mirror never become child rows; they are
only `result.unmatchedCount`. Making them visible and retryable means
persisting rows that do not exist today, in playlist fan-out. Separate
task.

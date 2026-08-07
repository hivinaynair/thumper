# Club-ready-only download gate — design

2026-08-07

## Problem

Thumper measures how usable a downloaded track is on a club system and does
nothing with the answer. `classifyForDj` in
[`audio-verify.ts`](../../packages/pipeline/src/audio-verify.ts) already returns a
`master` / `club` / `marginal` / `unsuitable` tier derived from the *measured*
spectral cutoff — the only check that catches a 128 kbps stream rewrapped as
ALAC. [`run-job.ts:397`](../../packages/pipeline/src/run-job.ts) runs it on the
pre-conversion source, stores the tier, and renders a badge. The verdict never
blocks anything, so unusable files still land in Drive.

Add a switch that makes the verdict binding.

## The bar

`master` or `club` — measured content reaching 19 kHz or higher, regardless of
container. Expressed as one pure predicate in `audio-verify.ts`:

```ts
export const isClubReady = (tier: DjTier) => tier === "master" || tier === "club";
```

`marginal` and `unsuitable` are rejected. The existing "peaks above −0.1 dBFS,
no headroom" warning stays advisory — clipping is a mixer-trim problem, not a
reason to discard the file. Bandwidth is the only rejection criterion.

Analysis failure (undecodable file, flat spectrum) counts as a rejection when
the switch is on. A gate that silently passes what it could not measure is not
a guarantee. With the switch off the failure stays swallowed, as today.

## Plumbing

`clubReadyOnly: boolean` follows the `freeDownloadsOnly` path exactly, with no
new patterns:

| Layer | File |
|---|---|
| zod, both create schemas | `packages/shared/src/index.ts` |
| gate meta on the parent job | `apps/web/app/api/jobs/route.ts` |
| playlist child fan-out | `apps/worker/src/process-one.ts`, `apps/worker/src/index.ts` |
| enforcement | `packages/pipeline/src/run-job.ts` |

## Enforcement and fallback

The gate is measurement-based, so it can only run once the bytes are on disk.
"Doesn't download" means downloads, measures, discards, does not deliver. A
rejected SoundCloud track can cost two downloads if a mirror is also tried.

At the existing verdict site in `processTrack`:

1. Analysis throw → `QualityGateError` when the switch is on.
2. `!isClubReady(verdict.tier)` → unlink the temp file, then either fall back or
   throw `QualityGateError` (carrying tier and `cutoffHz`).

Alternate sources, mostly already wired:

- **SC → YouTube-first** — the `catch` around that path already returns
  `youtube_failed`, so a mirror that flunks the gate falls through to the
  SoundCloud stream attempt with no change.
- **SC free-download or stream flunks** — verification currently sits *outside*
  the try/catch that owns fallback, so it cannot reach it. Add an explicit
  branch after the verdict: when `soundcloud && !youtubeAlreadyTried &&
  allowYoutubeFallback !== false`, call `fallbackSoundCloudToYoutube` with a new
  `reason: "low-quality"`. That recursion runs with `allowYoutubeFallback:
  false`, so it terminates after one hop.
- **Direct YouTube / Spotify-matched** — no alternate; fails immediately.

## Hypeddit

`processHypedditRetag` hands the gate download straight to the retag step with
no verification at all. A Hypeddit "free download" is frequently a 320 kbps MP3
that then gets rewrapped as AIFF — exactly the laundered-lossy case this module
exists to catch. Verify the downloaded file before the retag handoff, under the
same switch.

This is a downloader-initiated job, distinct from the user-upload `/retag` page,
which is out of scope.

## Failure shape

Rejected jobs finish `status: "failed"` with a human error string, plus
`result.qualityRejected: true` alongside the existing `djTier`, `cutoffHz`, and
`djHeadline`. The UI can then render "Rejected — not club-ready, cut at 16.2
kHz" instead of a generic error. Same shape as the `manualDownloadUrl`
precedent already in `run-job.ts`.

Playlist children fail individually; the parent job still completes.

## UI

A Switch beside the free-downloads-only checkbox on the downloader page:
"Club-ready only", sublabel "Reject anything that doesn't reach 19 kHz". State
persists in `localStorage` — sticky per browser, no migration and no settings
API. The unused `user_settings` table stays unused.

Rejected job cards get their own chip styling, distinct from an error.

## Testing

Pure functions only; no run-job integration harness exists and this does not
build one.

- `isClubReady` across all four tiers.
- The rejection-message builder, extracted as a pure function.
- The new `low-quality` fallback reason text.

## Out of scope

- The `/retag` upload page.
- A configurable minimum-tier dropdown.
- Wiring `defaultFormat` / `defaultDestination` in `user_settings`.
- Rejecting on clipping or headroom.

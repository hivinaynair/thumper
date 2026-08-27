# Preserve SoundCloud artist originals

## Goal

Preserve the audio quality of SoundCloud and Hypeddit artist free downloads.
An artist-provided file is already the preferred source and must not receive
stream-oriented gain, normalization, limiting, resampling, or lossy encoding.

## Behavior

- WAV artist originals are converted losslessly to FLAC so metadata and artwork
  can be added. Their sample rate, channel count, and meaningful bit depth are
  preserved. No audio filter is applied.
- MP3 artist originals that already embed artwork are delivered as the exact
  downloaded bytes.
- MP3 artist originals with no attached artwork are copy-tagged: FFmpeg writes
  ID3v2.3 title/artist/album tags and embeds the SoundCloud cover as APIC
  without re-encoding, gain, limiting, or resampling.
- AIFF, FLAC, and any other artist-original format are delivered as the exact
  downloaded bytes. Existing metadata is not rewritten by FFmpeg.
- The user's selected output format does not override preservation for artist
  originals.
- Quality analysis may inspect an original before delivery but never mutates it.
- YouTube and SoundCloud streams retain the existing conversion path. Minimal
  peak limiting remains available only for decoded lossy streams that exceed
  integer PCM full scale.

This behavior applies equally to direct SoundCloud `format_id=download` files
and files unlocked through a supported Hypeddit Free Download gate.

## Hypeddit social gates

The browserless gate request must carry Hypeddit's page-provided `external_id`.
Email, Instagram, SoundCloud, TikTok, YouTube, and Facebook steps remain on the
fast HTTP path because Hypeddit treats them as client-side completion.

A non-skippable Spotify step falls back to headless Chromium. The worker loads
the user's encrypted, synced Spotify cookies into an isolated browser context,
opens the Hypeddit gate, and accepts Spotify OAuth only on
`accounts.spotify.com`. Hypeddit's OAuth callback performs its configured
follow/save action; the worker proceeds only after positive Hypeddit progression
confirms that action completed. The current accepted authoritative signal is
Hypeddit's hidden `input#nwSteps` (or the same input selected by
`name="nwSteps"`) no longer containing `sp`; generic Next/Download controls are
not completion evidence. No Spotify completion class or attribute is accepted
without a captured current-page reference. The worker then downloads the
unlocked file. This is a real account action, not a fabricated verification
response. Browser state is temporary and is closed and deleted after the job.

Production images create uid/gid 922 (`chromium-worker`) and point Puppeteer at
`/usr/local/bin/chromium-worker`. The worker process remains root so a fixed
Python wrapper can `setgid`/`setgroups`/`setuid` to 922 and exec system
Chromium. `setpriv` is not used: it applies a capability bounding set that
Docker and Modal seccomp reject (`apply bounding set: Operation not permitted`).
Docker and Modal already isolate the worker container, while their runtimes
block Chromium's nested PID/network namespaces; therefore the wrapper adds
`--no-sandbox` only at this container boundary. Isolation is verified with
`modal run apps/modal/thumper_worker.py --chromium-smoke` on the live worker
image, not a local Docker smoke target.

The Python parent and Docker entrypoint set umask 077, keeping worker job files
root-private. Each browser launch gets a mode-0700 profile directory chowned to
uid/gid 922 and deleted in `finally`. The wrapper wipes the process environment
down to `PATH`, `HOME`, `TMPDIR`, and `LANG` before exec, so worker, database,
storage, Google, and Modal credentials cannot ride into Chromium even if a
caller forgets to pass a stripped `env`. Spotify cookies enter only through
Puppeteer's `setCookie`. The value import of `puppeteer-core` lives in the
dynamically loaded worker-only `hypeddit-browser.ts` module.

## Data flow

After download and source verification, classify the source as an artist
original and inspect its downloaded extension:

1. Artist-original WAV: resolve metadata and artwork, then convert WAV to FLAC
   without audio filters.
2. Artist-original MP3 without attached artwork: resolve metadata and artwork,
   then copy the audio bitstream into a tagged MP3.
3. Any other artist original, including MP3 that already has artwork: bypass
   metadata resolution and conversion, then deliver the downloaded file
   directly.
4. Stream or mirror: continue through the existing metadata, conversion, and
   stream peak-protection path.

Browser/object-storage and Google Drive delivery must support both a converted
output and an untouched downloaded input while reporting the actual extension,
MIME type, and file size.

## Error handling

- If the source format is unknown, preserve and deliver the original rather
  than guessing that it is WAV and converting it.
- Existing cancellation, quality-gate, storage, and Drive errors retain their
  current behavior.
- Temporary originals are deleted only after successful durable delivery or
  existing job cleanup.
- A verified Spotify gate fails with a specific request to refresh Spotify
  cookies if no usable synced session exists, Spotify returns to login, or its
  popup/callback reports an authorization/session error.
- Unknown or changed Hypeddit selectors fail closed rather than clicking an
  unrelated control.

## Tests

- Direct SoundCloud WAV originals select unfiltered FLAC conversion.
- Hypeddit WAV originals select unfiltered FLAC conversion.
- MP3, AIFF, FLAC, and unknown originals bypass FFmpeg and retain their bytes,
  extension, and MIME type.
- User-selected output format cannot force conversion of an artist original.
- Streams still use the existing requested output and limiter rules.
- 24-bit WAV-to-FLAC conversion preserves 24-bit audio.
- Instagram gate requests include the parsed `external_id`.
- Spotify gates invoke the browser fallback; other supported gates do not.
- The browser imports only Spotify cookies, handles OAuth popup/no-popup cases,
  confirms Hypeddit completed its configured Spotify action, observes
  cancellation, and always closes.

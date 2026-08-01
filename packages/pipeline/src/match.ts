import { MAX_PLAYLIST_TRACKS } from "@thumper/shared";
import { getYtDlpPath } from "./paths";
import type { PlaylistEntry } from "./playlist";
import { runCommandOk, type SpawnOptions } from "./process";
import { splitArtistNames, stripDecorative } from "./metadata";
import { containsSlug, ratio, slugify } from "./similarity";
import {
  buildSoundCloudSearchQuery,
  buildYoutubeSearchQuery,
  type SpotifyTrackMeta,
} from "./spotify";

/**
 * Label uploads often title tracks "WINK & borne - Drown" with uploader "UKF".
 * Mirror search needs the real credit + song name, not the label as artist.
 */
export function parseCreditTitle(
  rawTitle: string,
): { artists: string[]; title: string } | null {
  const trimmed = stripDecorative(rawTitle);
  // Prefer " - " (SoundCloud / YouTube convention); also accept en-dash.
  const match = trimmed.match(/^(.+?)\s+[–—-]\s+(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  const left = match[1].trim();
  let right = match[2].trim();
  // Drop trailing "(Official Video)" / "[Free Download]" noise from the song.
  right = right
    .replace(/\s*[\[(][^)\]]*(official|video|audio|lyric|visualiser|visualizer|free\s*download)[^)\]]*[)\]]\s*$/i, "")
    .trim();
  if (!left || !right) return null;
  // Avoid treating "Song Title - Live at Brixton" as artist/title.
  const artists = splitArtistNames(left);
  if (artists.length === 0) return null;
  if (artists.length === 1 && left.length > 48) return null;
  return { artists, title: right };
}

/**
 * Normalize title/artists for YouTube search + scoring:
 * 1) strip emoji junk
 * 2) split collab credits
 * 3) parse "Artist - Song" titles (label uploads)
 */
export function normalizeTrackForMatch(
  track: SpotifyTrackMeta,
): SpotifyTrackMeta {
  let title = stripDecorative(track.title);
  let artists = track.artists.map(stripDecorative).filter(Boolean);
  const parsed = parseCreditTitle(title);
  if (parsed) {
    title = parsed.title;
    // Replace a lone label credit ("UKF") with artists from the title.
    // Keep multi-artist dumpJson credits ("WINK, borne") when already good.
    if (artists.length <= 1) artists = parsed.artists;
  }
  return { ...track, title, artists };
}

/** Reject mirrors below this spotDL-inspired score (0–100). */
export const MIN_MATCH_SCORE = 78;

const FILLER_TOKENS = [
  "live",
  "cover",
  "karaoke",
  "remix",
  "mix",
  "slowed",
  "sped-up",
  "spedup",
  "nightcore",
  "8d",
  "acoustic",
  "instrumental",
  "mashup",
  "bootleg",
  "edit",
  "reverb",
  "lyrics",
] as const;

export type MirrorCandidate = {
  url: string;
  title: string;
  uploader: string;
  durationSec: number;
  views: number;
  source: "youtube" | "soundcloud";
};

export type ScoredMirror = MirrorCandidate & {
  score: number;
  breakdown: {
    artist: number;
    name: number;
    time: number;
    penalties: number;
    bonuses: number;
  };
};

function parseCandidates(
  stdout: string,
  source: "youtube" | "soundcloud",
): MirrorCandidate[] {
  const out: MirrorCandidate[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [url, title, uploader, duration, views] = trimmed.split("\t");
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const durationSec = Number.parseFloat(duration ?? "");
    const viewCount = Number.parseFloat(views ?? "");
    out.push({
      url,
      title: title && title !== "NA" ? title : "",
      uploader: uploader && uploader !== "NA" ? uploader : "",
      durationSec: Number.isFinite(durationSec) ? durationSec : 0,
      views: Number.isFinite(viewCount) ? viewCount : 0,
      source,
    });
  }
  return out;
}

async function searchCandidates(
  query: string,
  source: "youtube" | "soundcloud",
  options: SpawnOptions,
): Promise<MirrorCandidate[]> {
  const args = [
    "--flat-playlist",
    "--skip-download",
    "--no-warnings",
    "--print",
    "%(webpage_url)s\t%(title)s\t%(uploader)s\t%(duration)s\t%(view_count)s",
    query,
  ];
  try {
    const { stdout } = await runCommandOk(getYtDlpPath(), args, options);
    return parseCandidates(stdout, source);
  } catch {
    return [];
  }
}

function calcArtistMatch(track: SpotifyTrackMeta, candidate: MirrorCandidate): number {
  const main = track.artists[0] ?? "";
  if (!main) return 50;

  const channel = ratio(main, candidate.uploader);
  let inTitle = 0;
  const titleSlug = slugify(candidate.title).replace(/-/g, "");
  let hits = 0;
  for (const artist of track.artists) {
    if (containsSlug(candidate.title, artist) || containsSlug(candidate.uploader, artist)) {
      hits += 1;
    }
  }
  if (track.artists.length) {
    inTitle = (hits / track.artists.length) * 100;
  }

  // Also compare main artist against title when channel is a Topic/label dump
  const mainInTitle = containsSlug(candidate.title, main) ? 85 : 0;
  return Math.max(channel, inTitle, mainInTitle);
}

function calcNameMatch(track: SpotifyTrackMeta, candidate: MirrorCandidate): number {
  const song = track.title;
  const direct = ratio(song, candidate.title);
  // Strip common suffixes in candidate titles: "Artist - Title (Official Audio)"
  const cleaned = candidate.title
    .replace(/\([^)]*official[^)]*\)/gi, "")
    .replace(/\[[^\]]*official[^\]]*\]/gi, "")
    .replace(/\([^)]*lyric[^)]*\)/gi, "")
    .replace(/official\s+(audio|video|music\s+video)/gi, "")
    .replace(/topic/gi, "")
    .trim();
  const cleanedRatio = ratio(song, cleaned);
  // If title is "Artist - Song", compare against song part
  const afterDash = cleaned.includes(" - ")
    ? cleaned.split(" - ").slice(1).join(" - ")
    : cleaned;
  const dashRatio = ratio(song, afterDash);
  return Math.max(direct, cleanedRatio, dashRatio);
}

function calcTimeMatch(track: SpotifyTrackMeta, candidate: MirrorCandidate): number {
  if (!track.durationMs || track.durationMs <= 0 || candidate.durationSec <= 0) {
    return 55; // unused when timeKnown is false — see scoreMirrorCandidate
  }
  const songSec = track.durationMs / 1000;
  const diff = Math.abs(songSec - candidate.durationSec);
  // Softer than spotDL's 0.1 — SoundCloud vs YouTube lengths commonly differ
  // by 10–20s (intros, radio edits, trailing silence) on the same track.
  return Math.exp(-0.06 * diff) * 100;
}

function durationDiffSec(
  track: SpotifyTrackMeta,
  candidate: MirrorCandidate,
): number | null {
  if (!track.durationMs || track.durationMs <= 0 || candidate.durationSec <= 0) {
    return null;
  }
  return Math.abs(track.durationMs / 1000 - candidate.durationSec);
}

function fillerPenalty(track: SpotifyTrackMeta, candidate: MirrorCandidate): number {
  const songSlug = slugify(`${track.title} ${track.artists.join(" ")}`);
  const candSlug = slugify(`${candidate.title} ${candidate.uploader}`);
  let penalty = 0;
  for (const token of FILLER_TOKENS) {
    const t = slugify(token);
    if (candSlug.includes(t) && !songSlug.includes(t)) {
      penalty += token === "live" || token === "cover" || token === "karaoke" ? 18 : 10;
    }
  }
  return Math.min(penalty, 40);
}

function matchBonus(candidate: MirrorCandidate): number {
  const t = slugify(candidate.title);
  const u = slugify(candidate.uploader);
  let bonus = 0;
  if (t.includes("official-audio") || t.includes("officialaudio")) bonus += 8;
  if (t.includes("official-video") || t.includes("official-music-video")) bonus += 4;
  if (u.endsWith("-topic") || u.includes("-topic")) bonus += 10;
  if (t.includes("audio") && !t.includes("lyrics")) bonus += 3;
  return Math.min(bonus, 15);
}

export function scoreMirrorCandidate(
  track: SpotifyTrackMeta,
  candidate: MirrorCandidate,
): ScoredMirror {
  const artist = calcArtistMatch(track, candidate);
  let name = calcNameMatch(track, candidate);
  const time = calcTimeMatch(track, candidate);
  const penalties = fillerPenalty(track, candidate);
  const bonuses = matchBonus(candidate);
  const diffSec = durationDiffSec(track, candidate);

  // Duration is only evidence when both sides report one. SoundCloud withholds
  // it for exactly the tracks that need a mirror — geo-blocked ones extract
  // nothing, preview-only ones report 30s — and averaging in the neutral 55
  // placeholder capped even a perfect match at 77.5, just under the confidence
  // gate. When time is unknown, score on artist + name alone.
  const timeKnown = diffSec !== null;

  // Soften name when fillers present in candidate but not song
  if (penalties > 0) name = Math.max(0, name - Math.min(15, penalties / 2));

  // spotDL-like gates: weak title or terrible duration → kill
  if (name <= 60) {
    return {
      ...candidate,
      score: 0,
      breakdown: { artist, name, time, penalties, bonuses },
    };
  }

  const average = (artist + name) / 2;
  // Perfect (or near-perfect) identity: tolerate SC/YT length skew up to 25s.
  // A hard time<25 kill previously rejected Drown (185s SC vs 171s YT) at
  // score 0 despite artist+title both being 100.
  const strongIdentity = average >= 88;
  const mildSkew = timeKnown && diffSec !== null && diffSec <= 25;
  const useTime = timeKnown && !(strongIdentity && mildSkew);

  // Wildly wrong length (different song / live set) — still kill.
  if (timeKnown && diffSec !== null && diffSec > 45) {
    return {
      ...candidate,
      score: 0,
      breakdown: { artist, name, time, penalties, bonuses },
    };
  }
  if (useTime && time < 15) {
    return {
      ...candidate,
      score: 0,
      breakdown: { artist, name, time, penalties, bonuses },
    };
  }

  if (useTime && time < 50 && average < 75) {
    return {
      ...candidate,
      score: Math.min(average, 60),
      breakdown: { artist, name, time, penalties, bonuses },
    };
  }

  let score = useTime ? (average + time) / 2 : average;
  score = score - penalties + bonuses;
  score = Math.max(0, Math.min(100, score));

  return {
    ...candidate,
    score,
    breakdown: { artist, name, time, penalties, bonuses },
  };
}

function artistChannelBonus(
  track: SpotifyTrackMeta,
  candidate: MirrorCandidate,
): number {
  // Prefer the artist's own channel over a label dump when scores tie.
  for (const artist of track.artists) {
    if (containsSlug(candidate.uploader, artist)) return 1;
  }
  return 0;
}

function pickBest(
  track: SpotifyTrackMeta,
  candidates: MirrorCandidate[],
): ScoredMirror | null {
  const scored = candidates
    .map((c) => scoreMirrorCandidate(track, c))
    .filter((c) => c.score >= MIN_MATCH_SCORE)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const channel = artistChannelBonus(track, b) - artistChannelBonus(track, a);
      if (channel !== 0) return channel;
      return b.views - a.views;
    });
  return scored[0] ?? null;
}

/**
 * Find a confident YouTube mirror for a track (title + artists + optional duration).
 */
export async function matchTrackToYoutube(
  track: SpotifyTrackMeta,
  options: SpawnOptions = {},
): Promise<(PlaylistEntry & { matchScore: number; mirrorSource: "youtube" }) | null> {
  // Extract real artist + song before search — label pages otherwise search
  // "UKF WINK & borne - Drown official audio" and miss the track entirely.
  const cleaned = normalizeTrackForMatch(track);
  const ytQuery = buildYoutubeSearchQuery(cleaned);
  const ytCandidates = await searchCandidates(ytQuery, "youtube", options);

  const addAltCandidates = async () => {
    const artists = cleaned.artists.slice(0, 2).join(" ");
    const altQueries = [
      `ytsearch8:${artists} ${cleaned.title}`.trim(),
      `ytsearch8:${cleaned.artists[0] ?? ""} ${cleaned.title} official audio`.trim(),
    ];
    const seen = new Set(ytCandidates.map((c) => c.url));
    for (const q of altQueries) {
      if (!q || q === `ytsearch8: ${cleaned.title}`) continue;
      const alt = await searchCandidates(q, "youtube", options);
      for (const c of alt) {
        if (!seen.has(c.url)) {
          seen.add(c.url);
          ytCandidates.push(c);
        }
      }
    }
  };

  // Primary query is bare "artists + title". If nothing clears the threshold,
  // widen the pool with alt phrasings (incl. official audio).
  let bestYt = pickBest(cleaned, ytCandidates);
  if (!bestYt) {
    await addAltCandidates();
    bestYt = pickBest(cleaned, ytCandidates);
  }
  if (!bestYt) return null;
  return {
    url: bestYt.url,
    title: cleaned.title || track.title,
    artist: cleaned.artists.join(", ") || undefined,
    spotifyUrl: track.spotifyUrl,
    matchScore: Math.round(bestYt.score),
    mirrorSource: "youtube",
  };
}

/**
 * Mirror a Spotify track onto YouTube (preferred) then SoundCloud.
 * Uses multi-candidate search + spotDL-inspired scoring. Never downloads Spotify audio.
 */
export async function matchSpotifyTrackToMirror(
  track: SpotifyTrackMeta,
  options: SpawnOptions = {},
): Promise<(PlaylistEntry & { matchScore: number; mirrorSource: string }) | null> {
  const bestYt = await matchTrackToYoutube(track, options);
  if (bestYt) return bestYt;

  const scCandidates = await searchCandidates(
    buildSoundCloudSearchQuery(track),
    "soundcloud",
    options,
  );
  const bestSc = pickBest(track, scCandidates);
  if (bestSc) {
    return {
      url: bestSc.url,
      title: track.title,
      artist: track.artists.join(", ") || undefined,
      spotifyUrl: track.spotifyUrl,
      matchScore: Math.round(bestSc.score),
      mirrorSource: "soundcloud",
    };
  }

  return null;
}

export async function mirrorSpotifyTracks(
  tracks: SpotifyTrackMeta[],
  options: SpawnOptions = {},
): Promise<{ matched: PlaylistEntry[]; failed: SpotifyTrackMeta[] }> {
  const matched: PlaylistEntry[] = [];
  const failed: SpotifyTrackMeta[] = [];
  const limited = tracks.slice(0, MAX_PLAYLIST_TRACKS);

  for (const track of limited) {
    if (options.signal?.aborted) break;
    const hit = await matchSpotifyTrackToMirror(track, options);
    if (hit) matched.push(hit);
    else failed.push(track);
  }

  return { matched, failed };
}

import { MAX_PLAYLIST_TRACKS } from "@thumper/shared";
import { getYtDlpPath } from "./paths";
import type { PlaylistEntry } from "./playlist";
import { runCommandOk, type SpawnOptions } from "./process";
import { containsSlug, ratio, slugify } from "./similarity";
import {
  buildSoundCloudSearchQuery,
  buildYoutubeSearchQuery,
  type SpotifyTrackMeta,
} from "./spotify";

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
  return Math.exp(-0.1 * diff) * 100;
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

  // Duration is only evidence when both sides report one. SoundCloud withholds
  // it for exactly the tracks that need a mirror — geo-blocked ones extract
  // nothing, preview-only ones report 30s — and averaging in the neutral 55
  // placeholder capped even a perfect match at 77.5, just under the confidence
  // gate. When time is unknown, score on artist + name alone.
  const timeKnown = Boolean(
    track.durationMs && track.durationMs > 0 && candidate.durationSec > 0,
  );

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
  if (timeKnown && time < 25) {
    return {
      ...candidate,
      score: 0,
      breakdown: { artist, name, time, penalties, bonuses },
    };
  }

  const average = (artist + name) / 2;
  if (timeKnown && time < 50 && average < 75) {
    return {
      ...candidate,
      score: Math.min(average, 60),
      breakdown: { artist, name, time, penalties, bonuses },
    };
  }

  let score = timeKnown ? (average + time) / 2 : average;
  score = score - penalties + bonuses;
  score = Math.max(0, Math.min(100, score));

  return {
    ...candidate,
    score,
    breakdown: { artist, name, time, penalties, bonuses },
  };
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
  const ytQuery = buildYoutubeSearchQuery(track);
  const ytCandidates = await searchCandidates(ytQuery, "youtube", options);

  const addAltCandidates = async () => {
    const artist = track.artists[0] ?? "";
    const alt = await searchCandidates(
      `ytsearch8:${artist} ${track.title}`.trim(),
      "youtube",
      options,
    );
    const seen = new Set(ytCandidates.map((c) => c.url));
    for (const c of alt) {
      if (!seen.has(c.url)) ytCandidates.push(c);
    }
  };

  // The primary query appends "official audio", which pulls YouTube's results
  // toward unrelated tracks that happen to have an official upload. A full
  // pool of wrong answers is as useless as an empty one, so retry on a bare
  // "artist title" query whenever nothing clears the threshold — not just when
  // the pool is thin.
  let bestYt = pickBest(track, ytCandidates);
  if (!bestYt) {
    await addAltCandidates();
    bestYt = pickBest(track, ytCandidates);
  }
  if (!bestYt) return null;
  return {
    url: bestYt.url,
    title: track.title,
    artist: track.artists.join(", ") || undefined,
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

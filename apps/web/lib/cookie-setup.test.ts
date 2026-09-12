import { describe, expect, it } from "bun:test";
import { type CookieSetupInput, cookieSetupState } from "./cookie-setup";

const base: CookieSetupInput = {
  extensionVersion: "0.7.0",
  expectedVersion: "0.7.0",
  cookies: {
    youtube: { present: true, updatedAt: "2026-09-12T10:00:00.000Z" },
    soundcloud: { present: true, updatedAt: "2026-09-12T10:00:00.000Z" },
  },
  skipped: [],
  youtubeStale: false,
  failedNeedRefresh: false,
};

describe("cookieSetupState", () => {
  it("asks a first-time visitor to install the extension", () => {
    expect(cookieSetupState({ ...base, extensionVersion: null })).toEqual({
      step: "install",
    });
  });

  // A friend still on 0.6.0 syncs Spotify and hits an endpoint that now
  // rejects it — the sync half-works, so it has to be called out explicitly.
  it("flags an outdated extension before blaming the cookies", () => {
    expect(cookieSetupState({ ...base, extensionVersion: "0.6.0" })).toEqual({
      step: "update",
      installed: "0.6.0",
    });
  });

  it("names the provider to sign into when a sync skipped it", () => {
    expect(
      cookieSetupState({
        ...base,
        skipped: ["youtube"],
        cookies: {
          youtube: { present: false, updatedAt: null },
          soundcloud: { present: true, updatedAt: null },
        },
      }),
    ).toEqual({ step: "signin", providers: ["youtube"] });
  });

  it("asks for a first sync once the extension is installed", () => {
    expect(
      cookieSetupState({
        ...base,
        cookies: {
          youtube: { present: false, updatedAt: null },
          soundcloud: { present: false, updatedAt: null },
        },
      }),
    ).toEqual({ step: "sync" });
  });

  it("prioritises a concrete job failure over a stale-looking clock", () => {
    expect(cookieSetupState({ ...base, failedNeedRefresh: true, youtubeStale: true })).toEqual({
      step: "refresh",
      reason: "failed",
    });
  });

  it("nudges a refresh when the YouTube session has aged out", () => {
    expect(cookieSetupState({ ...base, youtubeStale: true })).toEqual({
      step: "refresh",
      reason: "stale",
    });
  });

  it("stays quiet when everything is synced and fresh", () => {
    expect(cookieSetupState(base)).toEqual({ step: "ready" });
  });

  it("treats an unknown cookie status as still loading, not broken", () => {
    expect(cookieSetupState({ ...base, cookies: null })).toEqual({
      step: "ready",
    });
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BrowserRequiredError,
  authorizeInstagramAndConfirmHypedditAction,
  authorizeSpotifyAndConfirmHypedditAction,
  downloadHypedditGate,
  downloadHypedditGateWithBrowser,
  downloadHypedditWithSpotifyFallback,
  isAllowedGateControlHref,
  isHypedditSmartLinkPage,
  isSafeInstagramUrl,
  isSafeSpotifyAuthorizationUrl,
  isSafeSoundCloudConnectUrl,
  isAllowedGateControlUrl,
  parseInstagramNetscapeCookies,
  parseSoundCloudNetscapeCookies,
  parseSpotifyNetscapeCookies,
  sniffAudioExt,
} from "./hypeddit";
import { ProcessCancelledError } from "./process";
import { ManualDownloadRequiredError } from "./soundcloud-purchase";

const originalFetch = globalThis.fetch;
const tempDirectories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function gateHtml(params: {
  steps: string;
  externalIdMarkup?: string;
}): string {
  return `
    <meta name="csrf-token" content="csrf">
    <input id="gvt" value="gate-token">
    <input id="current_download_file_listner" value="file-id">
    <input id="nwSteps" value="${params.steps}">
    <input id="wrndk" value="nonce">
    <input id="fan_gate_id" value="42">
    <input id="duration" value="1000">
    ${params.externalIdMarkup ?? ""}
  `;
}

async function runGateWithFetch(
  html: string,
  fetchImpl: typeof fetch,
): Promise<Awaited<ReturnType<typeof downloadHypedditGate>>> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "hypeddit-test-"));
  tempDirectories.push(workDir);
  globalThis.fetch = fetchImpl;
  return downloadHypedditGate({
    gateUrl: "https://hypeddit.com/artist/track",
    email: "listener@example.com",
    name: "Listener",
    workDir,
  });
}

function successFetch(
  html: string,
  requests: Array<{ url: string; body: URLSearchParams | null }>,
): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      body:
        init?.body instanceof URLSearchParams
          ? new URLSearchParams(init.body)
          : null,
    });
    if (url.endsWith("/artist/track")) return new Response(html);
    if (url.endsWith("/gate/download/ul")) {
      return Response.json({
        download_status: true,
        URL: "https://cdn.example.test/original",
        ext: "mp3",
        name: "Artist - Track",
      });
    }
    if (url === "https://cdn.example.test/original") {
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 4]));
    }
    return new Response("{}");
  }) as typeof fetch;
}

describe("sniffAudioExt", () => {
  it("detects WAV (RIFF/WAVE)", () => {
    const buf = new Uint8Array(12);
    buf.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(sniffAudioExt(buf)).toBe("wav");
  });

  it("detects MP3 (ID3 and frame sync)", () => {
    const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]);
    expect(sniffAudioExt(id3)).toBe("mp3");
    const frame = new Uint8Array([
      0xff, 0xfb, 0xe4, 0x44, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(sniffAudioExt(frame)).toBe("mp3");
  });

  it("detects FLAC", () => {
    const buf = new Uint8Array([
      0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(sniffAudioExt(buf)).toBe("flac");
  });
});

describe("Hypeddit Trap playlist page shapes", () => {
  it("treats Play/Buy smart links as manual downloads, not parse failures", async () => {
    const html = `
      <div class="hype-smartlink">
        <a id="fanclubLink" class="smartlink-click-button" href="https://open.spotify.com">Play</a>
      </div>
    `;
    expect(isHypedditSmartLinkPage(html)).toBe(true);
    const promise = runGateWithFetch(html, async () => new Response(html));
    expect(promise).rejects.toBeInstanceOf(ManualDownloadRequiredError);
    await promise.catch(() => undefined);
  });

  it("allows javascript:void landing Download anchors", () => {
    expect(
      isAllowedGateControlHref(
        "javascript:void(0);",
        "https://hypeddit.com/sportmode/holdmyhandsportmodeflip",
      ),
    ).toBe(true);
    expect(
      isAllowedGateControlHref(
        "javascript:void(0);",
        "https://hypeddit.com/66jz3n",
      ),
    ).toBe(true);
  });
});

describe("downloadHypedditGate browserless contract", () => {
  it("sends externID parsed from page JavaScript as external_id", async () => {
    const requests: Array<{ url: string; body: URLSearchParams | null }> = [];
    await runGateWithFetch(
      gateHtml({
        steps: "tk",
        externalIdMarkup: `<script>window.externID = "instagram-user-17";</script>`,
      }),
      successFetch(
        gateHtml({
          steps: "tk",
          externalIdMarkup: `<script>window.externID = "instagram-user-17";</script>`,
        }),
        requests,
      ),
    );

    const unlock = requests.find(({ url }) =>
      url.endsWith("/gate/download/ul"),
    );
    expect(unlock?.body?.get("external_id")).toBe("instagram-user-17");
  });

  it("sends external_id parsed from a hidden field", async () => {
    const requests: Array<{ url: string; body: URLSearchParams | null }> = [];
    const html = gateHtml({
      steps: "tk",
      externalIdMarkup: `<input type="hidden" name="external_id" value="hidden-user-9">`,
    });
    await runGateWithFetch(html, successFetch(html, requests));

    const unlock = requests.find(({ url }) =>
      url.endsWith("/gate/download/ul"),
    );
    expect(unlock?.body?.get("external_id")).toBe("hidden-user-9");
  });

  it("skips only explicitly allowlisted browserless social steps", async () => {
    const requests: Array<{ url: string; body: URLSearchParams | null }> = [];
    const html = gateHtml({ steps: "email,tk,yt,fb" });
    await runGateWithFetch(html, successFetch(html, requests));

    const unlock = requests.find(({ url }) =>
      url.endsWith("/gate/download/ul"),
    );
    expect(unlock?.body?.getAll("skip_gate_steps[]")).toEqual([
      "tk",
      "yt",
      "fb",
    ]);
  });

  for (const step of ["sp", "ig", "sc", "future-provider"]) {
    it(`requires a browser for ${step} before attempting unlock`, async () => {
      const requests: Array<{ url: string; body: URLSearchParams | null }> = [];
      const html = gateHtml({ steps: `email,${step}` });

      const promise = runGateWithFetch(html, successFetch(html, requests));

      expect(promise).rejects.toBeInstanceOf(BrowserRequiredError);
      await promise.catch(() => undefined);
      expect(
        requests.some(({ url }) => url.endsWith("/gate/download/ul")),
      ).toBe(false);
    });
  }
});

describe("Spotify Netscape cookies", () => {
  it("parses only Spotify domains and maps Netscape fields for Puppeteer", () => {
    const cookies = parseSpotifyNetscapeCookies(
      [
        "# Netscape HTTP Cookie File",
        ".spotify.com\tTRUE\t/\tTRUE\t2147483647\tsp_dc\tsecret",
        "#HttpOnly_.accounts.spotify.com\tTRUE\t/login\tTRUE\t2147483647\tsp_key\tvalue",
        ".example.com\tTRUE\t/\tTRUE\t2147483647\tleak\tnever",
      ].join("\n"),
      1_700_000_000,
    );

    expect(cookies).toEqual([
      {
        name: "sp_dc",
        value: "secret",
        domain: ".spotify.com",
        path: "/",
        secure: true,
        httpOnly: false,
        expires: 2147483647,
      },
      {
        name: "sp_key",
        value: "value",
        domain: ".accounts.spotify.com",
        path: "/login",
        secure: true,
        httpOnly: true,
        expires: 2147483647,
      },
    ]);
  });

  it("drops malformed, expired, and deceptive suffix domains", () => {
    const cookies = parseSpotifyNetscapeCookies(
      [
        "not-a-cookie",
        ".spotify.com.evil.test\tTRUE\t/\tTRUE\t2147483647\tbad\tcookie",
        ".spotify.com\tTRUE\t/\tTRUE\t100\told\tcookie",
      ].join("\n"),
      101,
    );

    expect(cookies).toEqual([]);
  });
});

describe("Instagram Netscape cookies", () => {
  it("parses only Instagram domains and maps Netscape fields for Puppeteer", () => {
    const cookies = parseInstagramNetscapeCookies(
      [
        "# Netscape HTTP Cookie File",
        ".instagram.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\tsecret",
        "#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t2147483647\tds_user_id\t17",
        ".spotify.com\tTRUE\t/\tTRUE\t2147483647\tsp_dc\tnever",
      ].join("\n"),
      1_700_000_000,
    );

    expect(cookies).toEqual([
      {
        name: "sessionid",
        value: "secret",
        domain: ".instagram.com",
        path: "/",
        secure: true,
        httpOnly: false,
        expires: 2147483647,
      },
      {
        name: "ds_user_id",
        value: "17",
        domain: ".instagram.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expires: 2147483647,
      },
    ]);
  });

  it("drops malformed, expired, and deceptive suffix domains", () => {
    const cookies = parseInstagramNetscapeCookies(
      [
        "not-a-cookie",
        ".instagram.com.evil.test\tTRUE\t/\tTRUE\t2147483647\tbad\tcookie",
        ".instagram.com\tTRUE\t/\tTRUE\t100\told\tcookie",
      ].join("\n"),
      101,
    );

    expect(cookies).toEqual([]);
  });
});

describe("SoundCloud Netscape cookies", () => {
  it("parses only SoundCloud domains for ToneDen follow unlocks", () => {
    const cookies = parseSoundCloudNetscapeCookies(
      [
        "# Netscape HTTP Cookie File",
        ".soundcloud.com\tTRUE\t/\tTRUE\t2147483647\toauth_token\tsc-secret",
        ".example.com\tTRUE\t/\tTRUE\t2147483647\tleak\tnever",
      ].join("\n"),
      1_700_000_000,
    );

    expect(cookies).toEqual([
      {
        name: "oauth_token",
        value: "sc-secret",
        domain: ".soundcloud.com",
        path: "/",
        secure: true,
        httpOnly: false,
        expires: 2147483647,
      },
    ]);
  });

  it("allows only SoundCloud connect/oauth hosts", () => {
    expect(
      isSafeSoundCloudConnectUrl(
        "https://soundcloud.com/connect?client_id=toneden",
      ),
    ).toBe(true);
    expect(
      isSafeSoundCloudConnectUrl("https://secure.soundcloud.com/oauth/authorize"),
    ).toBe(true);
    expect(
      isSafeSoundCloudConnectUrl("https://soundcloud.com.evil.test/connect"),
    ).toBe(false);
    expect(isSafeSoundCloudConnectUrl("https://soundcloud.com/mayetrix")).toBe(
      false,
    );
  });
});

describe("Hypeddit gate control hosts", () => {
  const gate = "https://hypeddit.com/lucky/turnupthespeakersluckyflip";

  it("allows same-page javascript Download handlers", () => {
    expect(isAllowedGateControlUrl("javascript:void(0);", gate)).toBe(true);
    expect(isAllowedGateControlUrl("javascript:void(0)", gate)).toBe(true);
  });

  it("allows Hypeddit, Spotify, Instagram, and SoundCloud hosts, including www", () => {
    expect(
      isAllowedGateControlUrl("https://www.hypeddit.com/track/download", gate),
    ).toBe(true);
    expect(
      isAllowedGateControlUrl("https://accounts.spotify.com/authorize", gate),
    ).toBe(true);
    expect(
      isAllowedGateControlUrl("https://www.instagram.com/artist/", gate),
    ).toBe(true);
    expect(
      isAllowedGateControlUrl("https://soundcloud.com/connect", gate),
    ).toBe(true);
  });

  it("refuses lookalike or unrelated download hosts", () => {
    expect(
      isAllowedGateControlUrl(
        "https://hypeddit.com.evil.test/lucky/turnupthespeakersluckyflip",
        gate,
      ),
    ).toBe(false);
    expect(isAllowedGateControlUrl("https://evil.test/download", gate)).toBe(
      false,
    );
  });
});

describe("Spotify authorization state machine", () => {
  it("authorizes on accounts.spotify.com then requires Hypeddit to confirm its configured action", async () => {
    const calls: string[] = [];
    await authorizeSpotifyAndConfirmHypedditAction({
      signal: new AbortController().signal,
      clickConnect: async () => calls.push("connect"),
      waitForPopup: async () => ({
        url: () => "https://accounts.spotify.com/authorize?client_id=x",
      }),
      acceptAuthorization: async () => calls.push("accept"),
      waitForHypedditActionConfirmation: async () =>
        calls.push("hypeddit-confirm"),
    });

    expect(calls).toEqual(["connect", "accept", "hypeddit-confirm"]);
  });

  it("still requires Hypeddit action confirmation when Spotify was already authorized", async () => {
    const calls: string[] = [];
    await authorizeSpotifyAndConfirmHypedditAction({
      signal: new AbortController().signal,
      clickConnect: async () => calls.push("connect"),
      waitForPopup: async () => null,
      acceptAuthorization: async () => calls.push("accept"),
      waitForHypedditActionConfirmation: async () =>
        calls.push("hypeddit-confirm"),
    });

    expect(calls).toEqual(["connect", "hypeddit-confirm"]);
  });

  it("refuses to accept authorization on a lookalike or non-Spotify host", async () => {
    expect(
      isSafeSpotifyAuthorizationUrl("https://accounts.spotify.com/authorize"),
    ).toBe(true);
    expect(
      isSafeSpotifyAuthorizationUrl(
        "https://accounts.spotify.com.evil.test/authorize",
      ),
    ).toBe(false);
    expect(
      isSafeSpotifyAuthorizationUrl("https://hypeddit.com/authorize"),
    ).toBe(false);

    const promise = authorizeSpotifyAndConfirmHypedditAction({
      signal: new AbortController().signal,
      clickConnect: async () => undefined,
      waitForPopup: async () => ({
        url: () => "https://accounts.spotify.com.evil.test/authorize",
      }),
      acceptAuthorization: async () => {
        throw new Error("must not click");
      },
      waitForHypedditActionConfirmation: async () => undefined,
    });

    expect(promise).rejects.toThrow("accounts.spotify.com");
  });

  it("honors cancellation between authorization stages", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const promise = authorizeSpotifyAndConfirmHypedditAction({
      signal: controller.signal,
      clickConnect: async () => {
        calls.push("connect");
        controller.abort();
      },
      waitForPopup: async () => {
        calls.push("popup");
        return null;
      },
      acceptAuthorization: async () => calls.push("accept"),
      waitForHypedditActionConfirmation: async () => calls.push("progress"),
    });

    expect(promise).rejects.toBeInstanceOf(ProcessCancelledError);
    await promise.catch(() => undefined);
    expect(calls).toEqual(["connect"]);
  });
});

describe("Instagram authorization state machine", () => {
  it("follows on instagram.com then requires Hypeddit to confirm its configured action", async () => {
    const calls: string[] = [];
    await authorizeInstagramAndConfirmHypedditAction({
      signal: new AbortController().signal,
      clickConnect: async () => calls.push("connect"),
      waitForPopup: async () => ({
        url: () => "https://www.instagram.com/artist/",
      }),
      acceptAuthorization: async () => calls.push("follow"),
      waitForHypedditActionConfirmation: async () =>
        calls.push("hypeddit-confirm"),
    });

    expect(calls).toEqual(["connect", "follow", "hypeddit-confirm"]);
  });

  it("refuses to act on a lookalike or non-Instagram host", async () => {
    expect(isSafeInstagramUrl("https://www.instagram.com/artist/")).toBe(true);
    expect(
      isSafeInstagramUrl("https://www.instagram.com.evil.test/artist/"),
    ).toBe(false);
    expect(isSafeInstagramUrl("https://hypeddit.com/instagram")).toBe(false);

    const promise = authorizeInstagramAndConfirmHypedditAction({
      signal: new AbortController().signal,
      clickConnect: async () => undefined,
      waitForPopup: async () => ({
        url: () => "https://www.instagram.com.evil.test/artist/",
      }),
      acceptAuthorization: async () => {
        throw new Error("must not click");
      },
      waitForHypedditActionConfirmation: async () => undefined,
    });

    expect(promise).rejects.toThrow("instagram.com");
  });
});

describe("Spotify browser fallback selection", () => {
  it("launches Chromium for Spotify without cookies because opening the tab is enough", async () => {
    let launched = false;
    const expected = {
      filePath: "/tmp/master.flac",
      ext: "flac",
      filename: "master.flac",
      title: "master",
      size: 4,
    };
    const result = await downloadHypedditWithSpotifyFallback({
      gateUrl: "https://hypeddit.com/artist/track",
      email: "listener@example.com",
      name: "Listener",
      workDir: "/tmp/unused",
      signal: new AbortController().signal,
      userId: "user-1",
      browserlessDownload: async () => {
        throw new BrowserRequiredError(["sp"]);
      },
      materializeSpotifyCookies: async () => null,
      browserDownload: async ({ cookies }) => {
        launched = true;
        expect(cookies).toEqual([]);
        return expected;
      },
      readCookieFile: async () => "",
      unlinkCookieFile: async () => undefined,
    });

    expect(launched).toBe(true);
    expect(result).toBe(expected);
  });

  it("does not use the browser for non-typed browserless failures", async () => {
    let materialized = false;
    const original = new Error("HTTP gate failed");
    const promise = downloadHypedditWithSpotifyFallback({
      gateUrl: "https://hypeddit.com/artist/track",
      email: "listener@example.com",
      name: "Listener",
      workDir: "/tmp/unused",
      signal: new AbortController().signal,
      userId: "user-1",
      browserlessDownload: async () => {
        throw original;
      },
      materializeSpotifyCookies: async () => {
        materialized = true;
        return "/tmp/cookies";
      },
      browserDownload: async () => {
        throw new Error("must not launch");
      },
      readCookieFile: async () => "",
      unlinkCookieFile: async () => undefined,
    });

    expect(promise).rejects.toBe(original);
    await promise.catch(() => undefined);
    expect(materialized).toBe(false);
  });

  it("does not launch Chromium for a typed unknown-provider reason", async () => {
    let materialized = false;
    let launched = false;
    const promise = downloadHypedditWithSpotifyFallback({
      gateUrl: "https://hypeddit.com/artist/track",
      email: "listener@example.com",
      name: "Listener",
      workDir: "/tmp/unused",
      signal: new AbortController().signal,
      userId: "user-1",
      browserlessDownload: async () => {
        throw new BrowserRequiredError(["future-provider"]);
      },
      materializeSpotifyCookies: async () => {
        materialized = true;
        return "/tmp/cookies";
      },
      browserDownload: async () => {
        launched = true;
        throw new Error("must not launch");
      },
    });

    expect(promise).rejects.toBeInstanceOf(BrowserRequiredError);
    await promise.catch(() => undefined);
    expect(materialized).toBe(false);
    expect(launched).toBe(false);
  });

  it("always unlinks the materialized cookie file after browser failure", async () => {
    const unlinked: string[] = [];
    const promise = downloadHypedditWithSpotifyFallback({
      gateUrl: "https://hypeddit.com/artist/track",
      email: "listener@example.com",
      name: "Listener",
      workDir: "/tmp/unused",
      signal: new AbortController().signal,
      userId: "user-1",
      browserlessDownload: async () => {
        throw new BrowserRequiredError(["sp"]);
      },
      materializeSpotifyCookies: async () => "/tmp/spotify.txt",
      readCookieFile: async () =>
        ".spotify.com\tTRUE\t/\tTRUE\t2147483647\tsp_dc\tsecret",
      browserDownload: async () => {
        throw new Error("selector changed");
      },
      unlinkCookieFile: async (cookiePath) => {
        unlinked.push(cookiePath);
      },
    });

    expect(promise).rejects.toThrow("selector changed");
    await promise.catch(() => undefined);
    expect(unlinked).toEqual(["/tmp/spotify.txt"]);
  });

  it("unlinks the materialized cookie file after browser success", async () => {
    const unlinked: string[] = [];
    const expected = {
      filePath: "/tmp/master.flac",
      ext: "flac",
      filename: "master.flac",
      title: "master",
      size: 4,
    };
    const result = await downloadHypedditWithSpotifyFallback({
      gateUrl: "https://hypeddit.com/artist/track",
      email: "listener@example.com",
      name: "Listener",
      workDir: "/tmp/unused",
      signal: new AbortController().signal,
      userId: "user-1",
      browserlessDownload: async () => {
        throw new BrowserRequiredError(["sp"]);
      },
      materializeSpotifyCookies: async () => "/tmp/spotify.txt",
      readCookieFile: async () =>
        ".spotify.com\tTRUE\t/\tTRUE\t2147483647\tsp_dc\tsecret",
      browserDownload: async () => expected,
      unlinkCookieFile: async (cookiePath) => {
        unlinked.push(cookiePath);
      },
    });

    expect(result).toBe(expected);
    expect(unlinked).toEqual(["/tmp/spotify.txt"]);
  });

  it("launches Chromium for Instagram without cookies because opening the tab is enough", async () => {
    let launched = false;
    const expected = {
      filePath: "/tmp/master.mp3",
      ext: "mp3",
      filename: "master.mp3",
      title: "master",
      size: 4,
    };
    const result = await downloadHypedditWithSpotifyFallback({
      gateUrl: "https://hypeddit.com/artist/track",
      email: "listener@example.com",
      name: "Listener",
      workDir: "/tmp/unused",
      signal: new AbortController().signal,
      userId: "user-1",
      browserlessDownload: async () => {
        throw new BrowserRequiredError(["ig"]);
      },
      materializeInstagramCookies: async () => null,
      browserDownload: async ({ cookies }) => {
        launched = true;
        expect(cookies).toEqual([]);
        return expected;
      },
      readCookieFile: async () => "",
      unlinkCookieFile: async () => undefined,
    });

    expect(launched).toBe(true);
    expect(result).toBe(expected);
  });

  it("imports Instagram cookies and unlinks them after browser success", async () => {
    const unlinked: string[] = [];
    const names: string[] = [];
    const expected = {
      filePath: "/tmp/master.mp3",
      ext: "mp3",
      filename: "master.mp3",
      title: "master",
      size: 4,
    };
    const result = await downloadHypedditWithSpotifyFallback({
      gateUrl: "https://hypeddit.com/artist/track",
      email: "listener@example.com",
      name: "Listener",
      workDir: "/tmp/unused",
      signal: new AbortController().signal,
      userId: "user-1",
      browserlessDownload: async () => {
        throw new BrowserRequiredError(["ig"]);
      },
      materializeInstagramCookies: async () => "/tmp/instagram.txt",
      readCookieFile: async () =>
        ".instagram.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\tsecret",
      browserDownload: async ({ cookies }) => {
        names.push(...cookies.map((cookie) => cookie.name));
        return expected;
      },
      unlinkCookieFile: async (cookiePath) => {
        unlinked.push(cookiePath);
      },
    });

    expect(result).toBe(expected);
    expect(names).toEqual(["sessionid"]);
    expect(unlinked).toEqual(["/tmp/instagram.txt"]);
  });

  it("sends Spotify and Instagram cookies together when the gate needs both", async () => {
    const unlinked: string[] = [];
    const names: string[] = [];
    await downloadHypedditWithSpotifyFallback({
      gateUrl: "https://hypeddit.com/artist/track",
      email: "listener@example.com",
      name: "Listener",
      workDir: "/tmp/unused",
      signal: new AbortController().signal,
      userId: "user-1",
      browserlessDownload: async () => {
        throw new BrowserRequiredError(["sp", "ig"]);
      },
      materializeSpotifyCookies: async () => "/tmp/spotify.txt",
      materializeInstagramCookies: async () => "/tmp/instagram.txt",
      readCookieFile: async (cookiePath) =>
        cookiePath.includes("instagram")
          ? ".instagram.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\tsecret"
          : ".spotify.com\tTRUE\t/\tTRUE\t2147483647\tsp_dc\tsecret",
      browserDownload: async ({ cookies }) => {
        names.push(...cookies.map((cookie) => cookie.name));
        return {
          filePath: "/tmp/master.mp3",
          ext: "mp3",
          filename: "master.mp3",
          title: "master",
          size: 4,
        };
      },
      unlinkCookieFile: async (cookiePath) => {
        unlinked.push(cookiePath);
      },
    });

    expect(names).toEqual(["sp_dc", "sessionid"]);
    expect(unlinked).toEqual(["/tmp/spotify.txt", "/tmp/instagram.txt"]);
  });
});

describe("headless Hypeddit download lifecycle", () => {
  type GateStep = "email" | "sc" | "ig" | "tk" | "yt" | "fb" | "sp" | string;

  class FakeInput {
    name = "";
    id = "";
    checked = false;
    private currentValue = "";
    onClick?: () => void;

    get value() {
      return this.currentValue;
    }

    set value(value: string) {
      this.currentValue = value;
    }

    click() {
      this.checked = !this.checked;
      this.onClick?.();
    }

    dispatchEvent() {
      return true;
    }

    getAttribute(name: string) {
      return name === "aria-label" ? "" : null;
    }
  }

  class FakeButton {
    readonly id: string;
    readonly className: string;
    readonly alt: string;
    private readonly dataType: string | null;

    constructor(
      readonly textContent: string,
      private readonly onClick: () => void,
      public hidden = false,
      readonly disabled = false,
      extras: {
        id?: string;
        className?: string;
        alt?: string;
        dataType?: string;
      } = {},
    ) {
      this.id = extras.id ?? "";
      this.className = extras.className ?? "";
      this.alt = extras.alt ?? "";
      this.dataType = extras.dataType ?? null;
    }

    click() {
      this.onClick();
    }

    getAttribute(name: string) {
      if (name === "aria-disabled" && this.disabled) return "true";
      if (name === "data-type") return this.dataType;
      if (name === "id") return this.id || null;
      if (name === "class") return this.className || null;
      if (name === "alt") return this.alt;
      return null;
    }

    getClientRects() {
      return this.hidden ? [] : [{}];
    }
  }

  class FakeAnchor extends FakeButton {
    constructor(
      text: string,
      readonly href: string,
      onClick: () => void,
      hidden: boolean | { id?: string; className?: string; alt?: string } = false,
      disabled = false,
      extras: { id?: string; className?: string; alt?: string } = {},
    ) {
      if (hidden && typeof hidden === "object") {
        extras = hidden;
        hidden = false;
      }
      super(text, onClick, hidden, disabled, extras);
    }
  }

  type GateState = {
    steps: GateStep[];
    calls: string[];
    started: boolean;
    popup: "spotify" | "instagram" | "unsafe" | "unsafe-instagram" | "none";
    confirmSpotifyAction: boolean;
    confirmInstagramAction?: boolean;
    landingLabel?: string;
    landingHref?: string;
    landingId?: string;
    emailField?: "validateEmailAddress" | "email_address";
    emailNextLabel?: string;
    spotifyConnectLabel?: string;
    spotifyConnectId?: string;
    instagramLabel?: string;
    instagramClass?: string;
    instagramId?: string;
    missing?: "get-track" | "client-next" | "connect" | "instagram-connect";
    abortOnConnect?: AbortController;
    openTabDone: string[];
    skipperReady: Partial<Record<string, boolean>>;
    oauthReturned?: boolean;
    pendingStateAfterOAuth?: "missing" | "unparseable";
    staleControl?: "visible" | "hidden" | "disabled";
    unusableGetTrack?: "hidden" | "disabled";
    sessionFailure?:
      | "same-tab-login"
      | "popup-login"
      | "callback-url"
      | "callback-alert"
      | "instagram-same-tab-login"
      | "instagram-popup-login";
  };

  function removeStep(state: GateState, step: string) {
    state.steps = state.steps.filter((candidate) => candidate !== step);
  }

  function pendingStep(state: GateState): GateStep | undefined {
    return state.steps.find((step) => {
      if (["sc", "ig", "tk", "yt", "fb", "sp"].includes(step)) {
        return !state.openTabDone.includes(step);
      }
      return true;
    });
  }

  function withPageDom<T>(page: FakePage, callback: () => T): T {
    const previous = {
      document: Reflect.get(globalThis, "document"),
      window: Reflect.get(globalThis, "window"),
      HTMLInputElement: Reflect.get(globalThis, "HTMLInputElement"),
      HTMLAnchorElement: Reflect.get(globalThis, "HTMLAnchorElement"),
      Event: Reflect.get(globalThis, "Event"),
    };
    Reflect.set(globalThis, "document", page.document());
    Reflect.set(globalThis, "window", {
      location: new URL(page.currentUrl),
    });
    Reflect.set(globalThis, "HTMLInputElement", FakeInput);
    Reflect.set(globalThis, "HTMLAnchorElement", FakeAnchor);
    Reflect.set(globalThis, "Event", class {});
    try {
      return callback();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(globalThis, key);
        else Reflect.set(globalThis, key, value);
      }
    }
  }

  class FakePage {
    currentUrl: string;
    readonly emailInput = new FakeInput();
    readonly nameInput = new FakeInput();
    readonly marketingInput = new FakeInput();

    constructor(
      readonly state: GateState,
      url = "https://hypeddit.com/artist/track",
      private readonly popupKind: "spotify" | "instagram" | false = false,
    ) {
      this.currentUrl = url;
      if (state.emailField === "email_address") {
        this.emailInput.name = "email_address";
        this.emailInput.id = "email_address";
      } else {
        this.emailInput.name = "validateEmailAddress";
        this.emailInput.id = "validateEmailAddress";
      }
      this.nameInput.name = "email_name";
      this.marketingInput.name = "spotify_marketing";
      this.marketingInput.checked = true;
      this.marketingInput.onClick = () =>
        this.state.calls.push("marketing-opt-out");
    }

    setDefaultTimeout() {}

    async goto(url: string) {
      this.currentUrl = url;
      this.state.calls.push("goto");
      return null;
    }

    target() {
      return "gate-target";
    }

    url() {
      return this.currentUrl;
    }

    controls(): Array<FakeButton | FakeAnchor> {
      if (this.popupKind === "spotify") {
        return [
          new FakeButton("Accept", () => {
            this.state.calls.push("spotify-accept");
            this.state.oauthReturned = true;
            if (this.state.confirmSpotifyAction) removeStep(this.state, "sp");
          }),
        ];
      }
      if (this.popupKind === "instagram") {
        return [
          new FakeButton("Follow", () => {
            this.state.calls.push("instagram-follow");
            this.state.oauthReturned = true;
            if (this.state.confirmInstagramAction !== false) {
              removeStep(this.state, "ig");
            }
          }),
        ];
      }
      if (!this.state.started) {
        return this.state.missing === "get-track"
          ? []
          : this.state.landingHref
            ? [
                new FakeAnchor(
                  this.state.landingLabel ?? "Download",
                  this.state.landingHref,
                  () => {
                    this.state.started = true;
                    this.state.calls.push("get-track");
                  },
                  { id: this.state.landingId ?? "downloadProcess" },
                ),
              ]
            : [
                new FakeButton(
                  this.state.landingLabel ?? "Get Track",
                  () => {
                    this.state.started = true;
                    this.state.calls.push("get-track");
                  },
                  this.state.unusableGetTrack === "hidden",
                  this.state.unusableGetTrack === "disabled",
                  { id: this.state.landingId },
                ),
              ];
      }
      const next = pendingStep(this.state);
      if (next === "email") {
        return [
          new FakeButton(
            this.state.emailNextLabel ?? "Next",
            () => {
              this.state.calls.push("email-next");
              removeStep(this.state, "email");
            },
            false,
            false,
            { id: "email_to_downloads_next" },
          ),
        ];
      }
      if (next === "sc") {
        return this.state.missing === "client-next"
          ? []
          : [
              new FakeButton(
                "Follow it's murph",
                () => {
                  this.state.calls.push("soundcloud-open");
                },
                false,
                false,
                {
                  className: this.state.calls.includes("soundcloud-open")
                    ? "hype-btn hype-btn-soundcloud"
                    : "hype-btn hype-btn-soundcloud undone",
                },
              ),
              new FakeButton(
                "Next",
                () => {
                  if (!this.state.calls.includes("soundcloud-open")) {
                    this.state.calls.push("skipper-blocked:sc");
                    return;
                  }
                  this.state.calls.push("skipper-sc");
                  this.state.skipperReady.sc = true;
                },
                false,
                false,
                { id: "skipper_sc_channel" },
              ),
              new FakeButton(
                "Next",
                () => {
                  this.state.calls.push("skipper-sc-next");
                  this.state.openTabDone.push("sc");
                },
                !this.state.skipperReady.sc,
                false,
                { id: "skipper_sc_next" },
              ),
            ];
      }
      if (next && ["tk", "yt", "fb"].includes(next)) {
        return this.state.missing === "client-next"
          ? []
          : [
              new FakeButton("Skip", () => {
                this.state.calls.push(`client-skip:${next}`);
                this.state.openTabDone.push(next);
              }),
            ];
      }
      if (next === "ig") {
        return this.state.missing === "instagram-connect"
          ? []
          : [
              new FakeButton(
                this.state.instagramLabel ?? "Follow sidepiece",
                () => {
                  this.state.calls.push("instagram-open");
                  this.state.abortOnConnect?.abort();
                },
                false,
                false,
                {
                  id: this.state.instagramId,
                  className: this.state.calls.includes("instagram-open")
                    ? (this.state.instagramClass ?? "hype-btn-instagram")
                    : `${this.state.instagramClass ?? "hype-btn-instagram"} undone`.trim(),
                  dataType: "instagram",
                },
              ),
              new FakeButton(
                "Next",
                () => {
                  if (!this.state.calls.includes("instagram-open")) {
                    this.state.calls.push("skipper-blocked:ig");
                    return;
                  }
                  this.state.calls.push("skipper-ig");
                  this.state.skipperReady.ig = true;
                },
                false,
                false,
                { id: "skipper_ig_channel" },
              ),
              new FakeButton(
                "Next",
                () => {
                  this.state.calls.push("skipper-ig-next");
                  this.state.openTabDone.push("ig");
                },
                !this.state.skipperReady.ig,
                false,
                { id: "skipper_ig_next" },
              ),
            ];
      }
      if (next === "sp") {
        return this.state.missing === "connect"
          ? []
          : [
              new FakeButton(
                this.state.spotifyConnectLabel ?? "Connect",
                () => {
                  this.state.calls.push("spotify-connect");
                  this.state.abortOnConnect?.abort();
                  this.state.openTabDone.push("sp");
                  if (this.state.sessionFailure === "same-tab-login") {
                    this.currentUrl = "https://accounts.spotify.com/login";
                  }
                  if (this.state.sessionFailure === "callback-url") {
                    this.currentUrl =
                      "https://hypeddit.com/spotify/callback?error=session_expired";
                  }
                  if (
                    this.state.popup === "none" &&
                    this.state.confirmSpotifyAction
                  ) {
                    this.state.oauthReturned = true;
                    removeStep(this.state, "sp");
                  }
                },
                false,
                false,
                {
                  id: this.state.spotifyConnectId ?? "login_to_sp",
                  className: "hype-btn hype-btn-spotify",
                  dataType: "spotify",
                },
              ),
              ...(this.state.staleControl
                ? [
                    new FakeButton(
                      this.state.staleControl === "disabled"
                        ? "Download Track"
                        : "Next",
                      () => this.state.calls.push("stale-control"),
                      this.state.staleControl === "hidden",
                      this.state.staleControl === "disabled",
                    ),
                  ]
                : []),
            ];
      }
      return [
        new FakeButton("Download Track", () =>
          this.state.calls.push("download"),
        ),
      ];
    }

    document() {
      return {
        querySelector: (selector: string) => {
          if (selector === "#nwSteps" || selector === '[name="nwSteps"]') {
            if (
              this.state.oauthReturned &&
              this.state.pendingStateAfterOAuth === "missing"
            ) {
              return null;
            }
            if (
              this.state.oauthReturned &&
              this.state.pendingStateAfterOAuth === "unparseable"
            ) {
              return { value: "{not-steps}" };
            }
            return { value: this.state.steps.join(",") };
          }
          if (
            this.state.steps.includes("email") &&
            this.state.emailField === "email_address" &&
            [
              "#email_address",
              'input[name="email_address"]',
            ].includes(selector)
          ) {
            return this.emailInput;
          }
          if (
            this.state.steps.includes("email") &&
            this.state.emailField !== "email_address" &&
            [
              "#validateEmailAddress",
              'input[name="validateEmailAddress"]',
              "#email_address",
              'input[name="email_address"]',
              'input[type="email"]',
            ].includes(selector)
          ) {
            return this.emailInput;
          }
          if (
            this.state.steps.includes("email") &&
            (selector === "#email_name" ||
              selector === 'input[name="email_name"]')
          ) {
            return this.nameInput;
          }
          if (
            this.popupKind === "spotify" &&
            selector === 'button[data-testid="auth-accept"]'
          ) {
            return this.controls()[0] ?? null;
          }
          if (
            selector === '[role="alert"], .alert, .error, .error-message' &&
            this.state.sessionFailure === "callback-alert"
          ) {
            return {
              textContent: "Spotify authorization failed: session expired",
            };
          }
          return null;
        },
        querySelectorAll: (selector: string) => {
          if (
            selector === "button, a" ||
            selector === "button" ||
            selector === "button, a, [role='button']"
          ) {
            return this.controls();
          }
          if (selector === 'input[type="checkbox"]') {
            return this.state.steps.includes("sp") ? [this.marketingInput] : [];
          }
          return [];
        },
      };
    }

    async evaluate<T>(
      callback: (...args: never[]) => T,
      argument?: unknown,
    ): Promise<T> {
      return withPageDom(this, () =>
        argument === undefined ? callback() : callback(argument as never),
      );
    }

    async waitForFunction<T>(
      callback: (argument?: T) => boolean,
      _options?: unknown,
      argument?: T,
    ) {
      const ready = withPageDom(this, () => callback(argument));
      if (!ready) {
        const error = new Error("Timeout waiting for Hypeddit progression");
        error.name = "TimeoutError";
        throw error;
      }
      return {};
    }

    async waitForResponse(predicate: (response: FakeResponse) => boolean) {
      const response = new FakeResponse();
      if (!predicate(response))
        throw new Error("download response not accepted");
      return response;
    }
  }

  class FakeResponse {
    url() {
      return "https://cdn.example.test/master";
    }

    headers() {
      return {
        "content-type": "audio/mpeg",
        "content-disposition": 'attachment; filename="Artist Master.mp3"',
      };
    }

    async buffer() {
      return Buffer.from([0x49, 0x44, 0x33, 0x04, 0xaa, 0xbb]);
    }
  }

  function fakeBrowser(state: GateState) {
    const calls: string[] = [];
    const importedCookies: unknown[] = [];
    const page = new FakePage(state);
    const spotifyPopup = new FakePage(
      state,
      state.popup === "unsafe"
        ? "https://accounts.spotify.com.evil.test/authorize"
        : state.sessionFailure === "popup-login"
          ? "https://accounts.spotify.com/login"
          : "https://accounts.spotify.com/authorize",
      "spotify",
    );
    const instagramPopup = new FakePage(
      state,
      state.popup === "unsafe-instagram"
        ? "https://www.instagram.com.evil.test/artist/"
        : state.sessionFailure === "instagram-popup-login"
          ? "https://www.instagram.com/accounts/login/"
          : "https://www.instagram.com/artist/",
      "instagram",
    );
    const context = {
      setCookie: async (...cookies: unknown[]) => {
        calls.push("cookies");
        importedCookies.push(...cookies);
      },
      newPage: async () => {
        calls.push("page");
        return page;
      },
      waitForTarget: async (predicate: (target: unknown) => boolean) => {
        if (state.popup === "none") {
          const error = new Error("no popup");
          error.name = "TimeoutError";
          throw error;
        }
        const popups = [instagramPopup, spotifyPopup];
        for (const popup of popups) {
          const target = {
            opener: () => "gate-target",
            url: () => popup.url(),
            page: async () => popup,
          };
          if (predicate(target)) return target;
        }
        const error = new Error("unsafe popup");
        error.name = "TimeoutError";
        throw error;
      },
      close: async () => {
        calls.push("context-close");
        state.calls.push("context-close");
      },
    };
    const browser = {
      createBrowserContext: async () => {
        calls.push("context");
        return context;
      },
      close: async () => {
        calls.push("browser-close");
        state.calls.push("browser-close");
      },
    };
    return { browser, calls, importedCookies, page };
  }

  function createState(overrides: Partial<GateState> = {}): GateState {
    return {
      steps: ["email", "sc", "ig", "tk", "yt", "fb", "sp"],
      calls: [],
      started: false,
      popup: "spotify",
      confirmSpotifyAction: true,
      confirmInstagramAction: true,
      openTabDone: [],
      skipperReady: {},
      ...overrides,
    };
  }

  async function runBrowserState(state: GateState) {
    const fake = fakeBrowser(state);
    let launchOptions: unknown;
    let profileMode: number | undefined;
    const workDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hypeddit-browser-"),
    );
    tempDirectories.push(workDir);
    const cookies = [
      ...parseSpotifyNetscapeCookies(
        ".spotify.com\tTRUE\t/\tTRUE\t2147483647\tsp_dc\tsecret",
      ),
      ...parseInstagramNetscapeCookies(
        ".instagram.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\tig-secret",
      ),
    ];

    const resultPromise = downloadHypedditGateWithBrowser({
      gateUrl: "https://hypeddit.com/artist/track",
      email: "listener@example.com",
      name: "Listener",
      workDir,
      cookies,
      signal: new AbortController().signal,
      launcher: {
        launch: async (options) => {
          launchOptions = options;
          profileMode = (await fs.stat(options.userDataDir)).mode & 0o777;
          return fake.browser;
        },
      },
      randomId: () => "fixed",
    });
    return {
      fake,
      launchOptions: () => launchOptions,
      profileMode: () => profileMode,
      resultPromise,
      workDir,
    };
  }

  it("starts the gate from a Download landing control", async () => {
    const state = createState({ landingLabel: "Download", steps: ["sp"] });
    const run = await runBrowserState(state);
    await run.resultPromise;
    expect(state.calls).toContain("get-track");
    expect(state.calls).toContain("download");
  });

  it("starts the gate from a javascript:void #downloadProcess landing control", async () => {
    const state = createState({
      steps: ["sp"],
      landingLabel: "Download",
      landingHref: "javascript:void(0);",
      landingId: "downloadProcess",
    });
    const run = await runBrowserState(state);
    await run.resultPromise;
    expect(state.calls).toContain("get-track");
    expect(state.calls).toContain("download");
  });

  it("fills #email_address and clicks Share email address", async () => {
    const state = createState({
      steps: ["email", "sp"],
      emailField: "email_address",
      emailNextLabel: "Share email address",
    });
    const run = await runBrowserState(state);
    await run.resultPromise;
    expect(state.calls).toContain("email-next");
    expect(run.fake.page.emailInput.value).toBe("listener@example.com");
    expect(run.fake.page.emailInput.id).toBe("email_address");
  });

  it("connects Spotify from #login_to_sp whose visible text is Connect", async () => {
    const state = createState({
      steps: ["sp"],
      spotifyConnectLabel: "Connect",
      spotifyConnectId: "login_to_sp",
    });
    const run = await runBrowserState(state);
    await run.resultPromise;
    expect(state.calls).toContain("spotify-connect");
    expect(state.calls).toContain("download");
  });

  it("follows Instagram from hype-btn-instagram text that starts with Follow", async () => {
    const state = createState({
      steps: ["ig"],
      popup: "instagram",
      instagramLabel: "Follow slickmusic_",
      instagramClass: "hype-btn-instagram",
      instagramId: "login_to_ig",
    });
    const run = await runBrowserState(state);
    await run.resultPromise;
    expect(state.calls).toContain("instagram-open");
    expect(state.calls).toContain("skipper-ig");
    expect(state.calls).toContain("download");
  });

  it("delegates the configured Spotify action to Hypeddit and confirms popup progression", async () => {
    const state = createState();
    const run = await runBrowserState(state);
    const result = await run.resultPromise;

    expect(state.calls).toEqual([
      "goto",
      "get-track",
      "email-next",
      "soundcloud-open",
      "skipper-sc",
      "skipper-sc-next",
      "instagram-open",
      "skipper-ig",
      "skipper-ig-next",
      "client-skip:tk",
      "client-skip:yt",
      "client-skip:fb",
      "marketing-opt-out",
      "spotify-connect",
      "download",
      "context-close",
      "browser-close",
    ]);
    expect(run.fake.page.emailInput.value).toBe("listener@example.com");
    expect(run.fake.page.nameInput.value).toBe("Listener");
    expect(run.fake.page.marketingInput.checked).toBe(false);
    expect(run.fake.importedCookies).toHaveLength(2);
    const launchOptions = run.launchOptions() as {
      executablePath: string;
      headless: true;
      args: string[];
      env: Record<string, string>;
      userDataDir: string;
    };
    expect(launchOptions.executablePath).toBe("/usr/local/bin/chromium-worker");
    expect(launchOptions.headless).toBe(true);
    expect(launchOptions.args).not.toContain("--no-sandbox");
    expect(launchOptions.args).not.toContain("--disable-setuid-sandbox");
    expect(launchOptions.env.PATH).toBe("/usr/bin:/bin");
    expect(launchOptions.env.HOME).toBe("/var/lib/chromium");
    expect(launchOptions.env.TMPDIR).toBe("/var/lib/chromium/tmp");
    expect(launchOptions.env.LANG).toBe("C.UTF-8");
    expect(launchOptions.env.XDG_RUNTIME_DIR).toBe("/var/lib/chromium/xdg");
    expect(launchOptions.userDataDir).toContain("thumper-chromium-");
    expect(run.profileMode()).toBe(0o700);
    expect(result.filename).toBe("Artist Master.mp3");
    expect(result.ext).toBe("mp3");
    expect(new Uint8Array(await fs.readFile(result.filePath))).toEqual(
      new Uint8Array([0x49, 0x44, 0x33, 0x04, 0xaa, 0xbb]),
    );
  });

  it("strips worker secrets from Chromium and removes its unique profile", async () => {
    const previousSecret = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://worker-secret";
    try {
      const first = await runBrowserState(createState({ steps: ["sp"] }));
      const second = await runBrowserState(createState({ steps: ["sp"] }));
      await Promise.all([first.resultPromise, second.resultPromise]);
      const firstOptions = first.launchOptions() as {
        env: Record<string, string>;
        userDataDir: string;
      };
      const secondOptions = second.launchOptions() as {
        env: Record<string, string>;
        userDataDir: string;
      };

      expect(firstOptions.env.DATABASE_URL).toBeUndefined();
      expect(firstOptions.env.BLOB_READ_WRITE_TOKEN).toBeUndefined();
      expect(firstOptions.env.GOOGLE_CLIENT_SECRET).toBeUndefined();
      expect(firstOptions.env.MODAL_WEBHOOK_SECRET).toBeUndefined();
      expect(firstOptions.userDataDir).not.toBe(secondOptions.userDataDir);
      expect(
        await fs.access(firstOptions.userDataDir).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        await fs.access(secondOptions.userDataDir).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      if (previousSecret === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousSecret;
    }
  });

  for (const unusableGetTrack of ["hidden", "disabled"] as const) {
    it(`does not click a ${unusableGetTrack} exact-text control`, async () => {
      const state = createState({ unusableGetTrack });
      const run = await runBrowserState(state);

      expect(run.resultPromise).rejects.toThrow("Hypeddit gate changed");
      await run.resultPromise.catch(() => undefined);
      expect(state.calls).not.toContain("get-track");
      expect(state.calls.slice(-2)).toEqual(["context-close", "browser-close"]);
    });
  }

  it("confirms the configured action after an already-authorized no-popup return", async () => {
    const state = createState({
      steps: ["sp"],
      popup: "none",
    });
    const run = await runBrowserState(state);
    await run.resultPromise;

    expect(state.calls).toContain("spotify-connect");
    expect(state.calls).not.toContain("spotify-accept");
    expect(state.calls).toContain("download");
  });

  it("opens the Spotify tab and downloads without waiting for nwSteps to drop sp", async () => {
    const state = createState({
      steps: ["sp"],
      confirmSpotifyAction: false,
    });
    const run = await runBrowserState(state);
    await run.resultPromise;

    expect(state.calls).toContain("spotify-connect");
    expect(state.calls).not.toContain("spotify-accept");
    expect(state.calls).toContain("download");
    expect(state.steps).toContain("sp");
  });

  for (const pendingStateAfterOAuth of ["missing", "unparseable"] as const) {
    it(`still downloads when nwSteps is ${pendingStateAfterOAuth} after opening Spotify`, async () => {
      const state = createState({
        steps: ["sp"],
        pendingStateAfterOAuth,
      });
      const run = await runBrowserState(state);
      await run.resultPromise;

      expect(state.calls).toContain("spotify-connect");
      expect(state.calls).toContain("download");
    });
  }

  for (const staleControl of ["visible", "hidden", "disabled"] as const) {
    it(`does not click a ${staleControl} stale Next/Download control on the Spotify step`, async () => {
      const state = createState({
        steps: ["sp"],
        confirmSpotifyAction: false,
        staleControl,
      });
      const run = await runBrowserState(state);
      await run.resultPromise;

      expect(state.calls).toContain("download");
      expect(state.calls).not.toContain("stale-control");
    });
  }

  it("accepts authoritative completion when nwSteps no longer contains sp", async () => {
    const state = createState({ steps: ["sp"], popup: "none" });
    const run = await runBrowserState(state);

    await run.resultPromise;

    expect(state.oauthReturned).toBe(true);
    expect(state.steps).not.toContain("sp");
    expect(state.calls).toContain("download");
  });

  for (const missing of ["get-track", "client-next", "connect"] as const) {
    it(`fails closed when the ${missing} selector is missing`, async () => {
      const state = createState({ missing });
      const run = await runBrowserState(state);

      expect(run.resultPromise).rejects.toThrow("Hypeddit gate changed");
      await run.resultPromise.catch(() => undefined);
      expect(state.calls.slice(-2)).toEqual(["context-close", "browser-close"]);
    });
  }

  it("rejects unknown gate steps before Spotify authorization", async () => {
    const state = createState({ steps: ["future-provider"] });
    const run = await runBrowserState(state);

    expect(run.resultPromise).rejects.toBeInstanceOf(BrowserRequiredError);
    await run.resultPromise.catch(() => undefined);
    expect(state.calls).not.toContain("spotify-connect");
    expect(state.calls).not.toContain("instagram-connect");
    expect(state.calls.slice(-2)).toEqual(["context-close", "browser-close"]);
  });

  it("opens SoundCloud and Instagram tabs then continues without nwSteps dropping", async () => {
    const state = createState({
      steps: ["sc", "ig"],
      popup: "none",
    });
    const run = await runBrowserState(state);
    await run.resultPromise;

    expect(state.calls).toEqual([
      "goto",
      "get-track",
      "soundcloud-open",
      "skipper-sc",
      "skipper-sc-next",
      "instagram-open",
      "skipper-ig",
      "skipper-ig-next",
      "download",
      "context-close",
      "browser-close",
    ]);
    expect(state.steps).toEqual(["sc", "ig"]);
    expect(state.calls).not.toContain("instagram-follow");
  });

  it("completes an Instagram open-tab step without following in the popup", async () => {
    const state = createState({ steps: ["ig"], popup: "instagram" });
    const run = await runBrowserState(state);
    await run.resultPromise;

    expect(state.calls).toEqual([
      "goto",
      "get-track",
      "instagram-open",
      "skipper-ig",
      "skipper-ig-next",
      "download",
      "context-close",
      "browser-close",
    ]);
    expect(state.steps).toContain("ig");
    expect(state.calls).not.toContain("instagram-follow");
  });

  it("still downloads Instagram when Hypeddit leaves ig in nwSteps", async () => {
    const state = createState({
      steps: ["ig"],
      popup: "instagram",
      confirmInstagramAction: false,
    });
    const run = await runBrowserState(state);
    await run.resultPromise;

    expect(state.calls).toContain("download");
    expect(state.steps).toContain("ig");
  });

  it("ignores unsafe Instagram popup hosts after opening the gate tab", async () => {
    const state = createState({
      steps: ["ig"],
      popup: "unsafe-instagram",
    });
    const run = await runBrowserState(state);
    await run.resultPromise;

    expect(state.calls).toContain("instagram-open");
    expect(state.calls).not.toContain("instagram-follow");
    expect(state.calls).toContain("download");
  });

  for (const sessionFailure of [
    "instagram-same-tab-login",
    "instagram-popup-login",
  ] as const) {
    it(`still downloads after ${sessionFailure} because opening the tab is enough`, async () => {
      const state = createState({
        steps: ["ig"],
        popup:
          sessionFailure === "instagram-popup-login" ? "instagram" : "none",
        sessionFailure,
      });
      const run = await runBrowserState(state);
      await run.resultPromise;

      expect(state.calls).toContain("instagram-open");
      expect(state.calls).toContain("download");
      expect(state.calls).not.toContain("instagram-follow");
    });
  }

  it("ignores an unsafe Spotify popup host after opening the gate tab", async () => {
    const state = createState({ steps: ["sp"], popup: "unsafe" });
    const run = await runBrowserState(state);
    await run.resultPromise;

    expect(state.calls).toContain("spotify-connect");
    expect(state.calls).not.toContain("spotify-accept");
    expect(state.calls).toContain("download");
  });

  for (const sessionFailure of [
    "same-tab-login",
    "callback-url",
    "callback-alert",
  ] as const) {
    it(`maps ${sessionFailure} Spotify expiry to the cookie refresh message`, async () => {
      const state = createState({
        steps: ["sp"],
        popup: "none",
        sessionFailure,
      });
      const run = await runBrowserState(state);

      expect(run.resultPromise).rejects.toThrow(
        "refresh Spotify cookies and retry",
      );
      await run.resultPromise.catch(() => undefined);
      expect(state.calls).not.toContain("download");
      expect(state.calls.slice(-2)).toEqual(["context-close", "browser-close"]);
    });
  }

  it("still downloads after a Spotify popup login because opening the tab is enough", async () => {
    const state = createState({
      steps: ["sp"],
      popup: "spotify",
      sessionFailure: "popup-login",
    });
    const run = await runBrowserState(state);
    await run.resultPromise;

    expect(state.calls).toContain("spotify-connect");
    expect(state.calls).toContain("download");
  });

  it("propagates cancellation and still closes the context and browser", async () => {
    const controller = new AbortController();
    const state = createState({
      steps: ["sp"],
      abortOnConnect: controller,
    });
    const fake = fakeBrowser(state);
    const workDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hypeddit-browser-"),
    );
    tempDirectories.push(workDir);
    const promise = downloadHypedditGateWithBrowser({
      gateUrl: "https://hypeddit.com/artist/track",
      email: "listener@example.com",
      name: "Listener",
      workDir,
      cookies: [],
      signal: controller.signal,
      launcher: { launch: async () => fake.browser },
    });

    expect(promise).rejects.toBeInstanceOf(ProcessCancelledError);
    await promise.catch(() => undefined);
    expect(state.calls.slice(-2)).toEqual(["context-close", "browser-close"]);
  });
});

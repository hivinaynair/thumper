import { Show, SignInButton } from "@clerk/nextjs";
import Link from "next/link";

export default function HomePage() {
  return (
    <section className="hero">
      <p className="muted">Private booth tool · friends & family</p>
      <h1>Thumper</h1>
      <p>
        Harvest from YouTube and SoundCloud, or paste a Spotify playlist — we
        mirror each track to YouTube/SoundCloud with a scored match, then
        convert to FLAC/WAV/ALAC.
      </p>
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <Show when="signed-in">
          <Link className="btn" href="/downloader">
            Open downloader
          </Link>
        </Show>
        <Show when="signed-out">
          <SignInButton mode="modal">
            <button type="button" className="btn">
              Sign in
            </button>
          </SignInButton>
        </Show>
      </div>
    </section>
  );
}

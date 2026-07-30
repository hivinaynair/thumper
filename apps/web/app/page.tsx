import { Show, SignInButton } from "@clerk/nextjs";
import Link from "next/link";

export default function HomePage() {
  return (
    <section className="hero">
      <p className="muted">Private booth tool · friends & family</p>
      <h1>Thumper</h1>
      <p>
        Harvest high-quality audio from YouTube, SoundCloud, Spotify mirrors,
        and Patreon — convert to FLAC/WAV/ALAC, deliver to browser or Drive.
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

import { Show, SignInButton } from "@clerk/nextjs";
import Link from "next/link";
import { SplineScene } from "./components/spline-scene";

export default function HomePage() {
	return (
		<main className="main-flush">
			<section className="hero">
				<div className="hero-stage" aria-hidden="true">
					<SplineScene />
				</div>
				<div className="hero-scrim" aria-hidden="true" />
				<div className="hero-copy">
					<p className="hero-kicker">Private audio harvest</p>
					<h1>Thumper</h1>
					<p className="hero-lede">
						Pull tracks from YouTube and SoundCloud — or paste Spotify and we
						mirror each song with a scored match — then encode to FLAC, WAV, or
						ALAC.
					</p>
					<div className="hero-actions">
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
				</div>
			</section>
		</main>
	);
}

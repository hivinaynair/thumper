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
						Paste a YouTube or SoundCloud link and get it back as FLAC, WAV, or
						ALAC. Spotify works too: we find each song elsewhere and skip
						anything we can&rsquo;t confidently match.
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

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Candidate = {
	url: string;
	title: string;
	artist: string;
	artworkUrl?: string;
	durationSec: number;
};

type Job = {
	id: string;
	status: string;
	stage: string;
	progress: number;
	sourceUrl: string;
	title?: string | null;
	artist?: string | null;
	error?: string | null;
	result?: {
		fileId?: string;
		qualityLabel?: string;
		retag?: boolean;
	} | null;
};

type Step = "upload" | "confirm" | "converting" | "done";

export default function RetagPage() {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [step, setStep] = useState<Step>("upload");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [filename, setFilename] = useState("");
	const [inputStorageKey, setInputStorageKey] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [candidates, setCandidates] = useState<Candidate[]>([]);
	const [selected, setSelected] = useState<Candidate | null>(null);
	const [overrideUrl, setOverrideUrl] = useState("");
	const [showOverride, setShowOverride] = useState(false);

	const [job, setJob] = useState<Job | null>(null);

	const reset = useCallback(() => {
		setStep("upload");
		setBusy(false);
		setError(null);
		setFilename("");
		setInputStorageKey(null);
		setSearchQuery("");
		setCandidates([]);
		setSelected(null);
		setOverrideUrl("");
		setShowOverride(false);
		setJob(null);
		if (fileInputRef.current) fileInputRef.current.value = "";
	}, []);

	const runSearch = useCallback(async (query: string) => {
		const res = await fetch("/api/retag/search", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query }),
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Search failed");
		return data as { query: string; candidates: Candidate[] };
	}, []);

	const onFile = useCallback(
		async (file: File | null) => {
			if (!file) return;
			setError(null);
			setBusy(true);
			try {
				const form = new FormData();
				form.set("file", file);
				const upRes = await fetch("/api/retag/upload", {
					method: "POST",
					body: form,
				});
				const up = await upRes.json();
				if (!upRes.ok) throw new Error(up.error || "Upload failed");

				setFilename(up.filename);
				setInputStorageKey(up.inputStorageKey);
				setSearchQuery(up.searchQuery);

				const found = await runSearch(up.searchQuery);
				setSearchQuery(found.query);
				setCandidates(found.candidates);
				setSelected(found.candidates[0] ?? null);
				setStep("confirm");
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[runSearch],
	);

	const confirmConvert = useCallback(async () => {
		if (!inputStorageKey) return;
		const metadataUrl = showOverride
			? overrideUrl.trim()
			: selected?.url?.trim();
		if (!metadataUrl) {
			setError("Pick a match or paste a SoundCloud URL");
			return;
		}

		setError(null);
		setBusy(true);
		try {
			const res = await fetch("/api/retag/convert", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					inputStorageKey,
					metadataUrl,
					titleHint: selected?.title,
					artistHint: selected?.artist,
				}),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || "Convert failed");
			setJob(data.job);
			setStep("converting");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [inputStorageKey, showOverride, overrideUrl, selected]);

	useEffect(() => {
		if (step !== "converting" || !job?.id) return;
		if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
			if (job.status === "completed") setStep("done");
			return;
		}

		const id = window.setInterval(async () => {
			try {
				const res = await fetch("/api/jobs");
				const data = await res.json();
				const rows = (data.jobs ?? []) as Job[];
				const current = rows.find((row) => row.id === job.id);
				if (!current) return;
				setJob(current);
				if (current.status === "completed") setStep("done");
				if (current.status === "failed" || current.status === "cancelled") {
					setError(current.error || "Conversion failed");
				}
			} catch {
				/* keep polling */
			}
		}, 1500);

		return () => window.clearInterval(id);
	}, [step, job]);

	const fileId = job?.result?.fileId;

	return (
		<main className="main">
			<div className="page-head">
				<div className="page-head-main">
					<h1>WAV → AIFF</h1>
					<p>
						Upload a SoundCloud free-download WAV, confirm the track match, get
						a lossless AIFF with artwork and tags.
					</p>
				</div>
			</div>

			<section className="panel">
				<div className="panel-head">
					<h2>
						{step === "upload" && "Upload WAV"}
						{step === "confirm" && "Confirm match"}
						{step === "converting" && "Converting"}
						{step === "done" && "Ready"}
					</h2>
					{step !== "upload" ? (
						<button type="button" className="btn ghost" onClick={reset}>
							Start over
						</button>
					) : null}
				</div>

				{error ? <p className="flash error">{error}</p> : null}

				{step === "upload" ? (
					<div className="retag-upload">
						<input
							ref={fileInputRef}
							type="file"
							accept=".wav,audio/wav,audio/x-wav"
							disabled={busy}
							onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
						/>
						<p className="panel-note">
							{busy
								? "Uploading and searching SoundCloud…"
								: "Lossless PCM only — sample rate and bit depth are preserved."}
						</p>
					</div>
				) : null}

				{step === "confirm" ? (
					<div className="retag-confirm">
						<p className="panel-note">
							File: <code>{filename}</code>
							{searchQuery ? (
								<>
									{" "}
									· searched <code>{searchQuery}</code>
								</>
							) : null}
						</p>

						{candidates.length === 0 && !showOverride ? (
							<p className="panel-note">
								No SoundCloud hits. Paste the track URL below.
							</p>
						) : null}

						<ul className="retag-candidates">
							{candidates.map((c) => {
								const active = !showOverride && selected?.url === c.url;
								return (
									<li key={c.url}>
										<button
											type="button"
											className={`retag-candidate${active ? " active" : ""}`}
											onClick={() => {
												setSelected(c);
												setShowOverride(false);
											}}
										>
											{c.artworkUrl ? (
												<img src={c.artworkUrl} alt="" width={72} height={72} />
											) : (
												<div className="retag-art-fallback" aria-hidden />
											)}
											<span>
												<strong>{c.title || "Untitled"}</strong>
												<em>{c.artist || "Unknown artist"}</em>
											</span>
										</button>
									</li>
								);
							})}
						</ul>

						{showOverride ? (
							<label>
								<span className="panel-note">SoundCloud or Spotify URL</span>
								<input
									type="url"
									value={overrideUrl}
									onChange={(e) => setOverrideUrl(e.target.value)}
									placeholder="https://soundcloud.com/…"
									autoFocus
								/>
							</label>
						) : (
							<button
								type="button"
								className="btn ghost"
								onClick={() => setShowOverride(true)}
							>
								Wrong match — paste URL
							</button>
						)}

						<div className="retag-actions">
							<button
								type="button"
								className="btn"
								disabled={busy}
								onClick={() => void confirmConvert()}
							>
								{busy ? "Queuing…" : "Convert to AIFF"}
							</button>
						</div>
					</div>
				) : null}

				{step === "converting" && job ? (
					<div>
						<p className="panel-note">
							{job.artist && job.title
								? `${job.artist} — ${job.title}`
								: "Working…"}
						</p>
						<p className="panel-note">
							{job.stage} · {job.progress}%
						</p>
					</div>
				) : null}

				{step === "done" && job ? (
					<div className="retag-done">
						<p>
							<strong>
								{job.artist && job.title
									? `${job.artist} — ${job.title}`
									: "AIFF ready"}
							</strong>
						</p>
						{job.result?.qualityLabel ? (
							<p className="panel-note">{job.result.qualityLabel}</p>
						) : null}
						{fileId ? (
							<a className="btn" href={`/api/files/${fileId}`}>
								Download AIFF
							</a>
						) : (
							<p className="panel-note">File id missing — check Downloader jobs.</p>
						)}
					</div>
				) : null}
			</section>
		</main>
	);
}

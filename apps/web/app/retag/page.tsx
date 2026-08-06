"use client";

import { upload } from "@vercel/blob/client";
import { useAuth } from "@clerk/nextjs";
import { trackDisplayName } from "@thumper/shared";
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
		driveUrl?: string;
		qualityLabel?: string;
		retag?: boolean;
	} | null;
};

type TrackItem = {
	id: string;
	filename: string;
	inputStorageKey: string;
	searchQuery: string;
	candidates: Candidate[];
	selected: Candidate | null;
	overrideUrl: string;
	showOverride: boolean;
	approved: boolean;
	status: "ready" | "searching" | "error";
	error?: string;
	jobId?: string;
	job?: Job;
};

type Step = "upload" | "confirm" | "converting" | "done";

function newId(): string {
	return crypto.randomUUID();
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
	const text = await res.text();
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		const snippet = text.slice(0, 120).trim() || res.statusText;
		if (/request entity too large/i.test(snippet) || res.status === 413) {
			throw new Error(
				"File too large for the server route — use Blob upload (production) or a smaller file.",
			);
		}
		throw new Error(snippet || `Request failed (${res.status})`);
	}
}

export default function RetagPage() {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const { userId } = useAuth();
	const [step, setStep] = useState<Step>("upload");
	const [busy, setBusy] = useState(false);
	const [progressNote, setProgressNote] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tracks, setTracks] = useState<TrackItem[]>([]);
	const [destination, setDestination] = useState("browser");

	const reset = useCallback(() => {
		setStep("upload");
		setBusy(false);
		setProgressNote(null);
		setError(null);
		setTracks([]);
		setDestination("browser");
		if (fileInputRef.current) fileInputRef.current.value = "";
	}, []);

	const runSearch = useCallback(async (opts: { query?: string; filename?: string }) => {
		const res = await fetch("/api/retag/search", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(opts),
		});
		const data = await readJson(res);
		if (!res.ok) throw new Error(String(data.error || "Search failed"));
		return data as unknown as { query: string; candidates: Candidate[] };
	}, []);

	const uploadOne = useCallback(
		async (file: File): Promise<{ key: string; filename: string; searchQuery: string }> => {
			const modeRes = await fetch("/api/retag/upload");
			const modeData = await readJson(modeRes);
			if (!modeRes.ok) throw new Error(String(modeData.error || "Upload config failed"));
			const mode = modeData.mode as string;

			if (mode === "blob") {
				if (!userId) throw new Error("Sign in required");
				const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
				const safeName = file.name.replace(/[^\w.\- ()]+/g, "_");
				const pathname = `users/${safeUser}/uploads/${crypto.randomUUID()}/${safeName}`;
				const blob = await upload(pathname, file, {
					access: "private",
					handleUploadUrl: "/api/retag/upload",
					multipart: true,
					contentType: file.type || "audio/wav",
				});
				return {
					key: blob.pathname,
					filename: file.name,
					searchQuery: file.name,
				};
			}

			const form = new FormData();
			form.set("file", file);
			const upRes = await fetch("/api/retag/upload", {
				method: "POST",
				body: form,
			});
			const up = await readJson(upRes);
			if (!upRes.ok) throw new Error(String(up.error || "Upload failed"));
			return {
				key: String(up.inputStorageKey),
				filename: String(up.filename),
				searchQuery: String(up.searchQuery || file.name),
			};
		},
		[userId],
	);

	const onFiles = useCallback(
		async (fileList: FileList | null) => {
			if (!fileList || fileList.length === 0) return;
			const files = [...fileList].filter(
				(f) => /\.wav$/i.test(f.name) || f.type.includes("wav"),
			);
			if (files.length === 0) {
				setError("Select one or more WAV files");
				return;
			}

			setError(null);
			setBusy(true);
			const next: TrackItem[] = [];

			try {
				for (let i = 0; i < files.length; i++) {
					const file = files[i]!;
					setProgressNote(
						`Uploading ${i + 1}/${files.length}: ${file.name}`,
					);
					const up = await uploadOne(file);

					const item: TrackItem = {
						id: newId(),
						filename: up.filename,
						inputStorageKey: up.key,
						searchQuery: up.searchQuery,
						candidates: [],
						selected: null,
						overrideUrl: "",
						showOverride: false,
						approved: false,
						status: "searching",
					};
					next.push(item);
					setTracks([...next]);

					setProgressNote(
						`Searching SoundCloud ${i + 1}/${files.length}: ${file.name}`,
					);
					try {
						const found = await runSearch({ filename: up.filename });
						item.searchQuery = found.query;
						item.candidates = found.candidates;
						item.selected = found.candidates[0] ?? null;
						item.approved = Boolean(found.candidates[0]);
						item.status = "ready";
					} catch (err) {
						item.status = "error";
						item.error =
							err instanceof Error ? err.message : String(err);
					}
					setTracks([...next]);
				}
				setStep("confirm");
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
				setProgressNote(null);
			}
		},
		[uploadOne, runSearch],
	);

	const updateTrack = useCallback(
		(id: string, patch: Partial<TrackItem>) => {
			setTracks((prev) =>
				prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
			);
		},
		[],
	);

	const approveAll = useCallback(() => {
		setTracks((prev) =>
			prev.map((t) => {
				if (t.status !== "ready") return t;
				const hasMatch = Boolean(t.selected?.url || t.overrideUrl.trim());
				return hasMatch ? { ...t, approved: true } : t;
			}),
		);
	}, []);

	const metadataUrlFor = (t: TrackItem): string | null => {
		if (t.showOverride || (!t.selected && t.overrideUrl.trim())) {
			return t.overrideUrl.trim() || null;
		}
		return t.selected?.url?.trim() || null;
	};

	const convertApproved = useCallback(async () => {
		const approved = tracks.filter((t) => {
			if (!t.approved || t.status !== "ready") return false;
			return Boolean(metadataUrlFor(t));
		});
		if (approved.length === 0) {
			setError("Approve at least one track with a SoundCloud match or URL");
			return;
		}

		setError(null);
		setBusy(true);
		setStep("converting");

		try {
			const queued: TrackItem[] = [];
			for (const t of approved) {
				const metadataUrl = metadataUrlFor(t)!;
				const res = await fetch("/api/retag/convert", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						inputStorageKey: t.inputStorageKey,
						metadataUrl,
						titleHint: t.selected?.title,
						artistHint: t.selected?.artist,
						destination,
					}),
				});
				const data = await readJson(res);
				if (!res.ok) throw new Error(String(data.error || "Convert failed"));
				const job = data.job as Job;
				queued.push({ ...t, jobId: job.id, job });
			}
			// Keep unapproved for context; replace approved with queued jobs
			setTracks((prev) => {
				const byId = new Map(queued.map((q) => [q.id, q]));
				return prev.map((t) => byId.get(t.id) ?? t);
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStep("confirm");
		} finally {
			setBusy(false);
		}
	}, [tracks, destination]);

	useEffect(() => {
		if (step !== "converting") return;
		const active = tracks.filter((t) => t.jobId);
		if (active.length === 0) return;

		const allDone = active.every(
			(t) =>
				t.job &&
				(t.job.status === "completed" ||
					t.job.status === "failed" ||
					t.job.status === "cancelled"),
		);
		if (allDone) {
			setStep("done");
			return;
		}

		const id = window.setInterval(async () => {
			try {
				const res = await fetch("/api/jobs");
				const data = await readJson(res);
				const rows = (data.jobs ?? []) as Job[];
				setTracks((prev) =>
					prev.map((t) => {
						if (!t.jobId) return t;
						const current = rows.find((row) => row.id === t.jobId);
						return current ? { ...t, job: current } : t;
					}),
				);
			} catch {
				/* keep polling */
			}
		}, 1500);

		return () => window.clearInterval(id);
	}, [step, tracks]);

	const convertingTracks = tracks.filter((t) => t.jobId);
	const approvedCount = tracks.filter(
		(t) => t.approved && t.status === "ready" && metadataUrlFor(t),
	).length;

	return (
		<main className="main">
			<div className="page-head">
				<div className="page-head-main">
					<h1>WAV → AIFF</h1>
					<p>
						Upload one or many SoundCloud free-download WAVs, confirm matches,
						convert losslessly with artwork — download or send to Drive.
					</p>
				</div>
			</div>

			<section className="panel">
				<div className="panel-head">
					<h2>
						{step === "upload" && "Upload WAVs"}
						{step === "confirm" && "Confirm matches"}
						{step === "converting" && "Converting"}
						{step === "done" && "Done"}
					</h2>
					{step !== "upload" ? (
						<button type="button" className="btn ghost" onClick={reset}>
							Start over
						</button>
					) : null}
				</div>

				{error ? <p className="flash error">{error}</p> : null}
				{progressNote ? <p className="panel-note">{progressNote}</p> : null}

				{step === "upload" ? (
					<div className="retag-upload">
						<input
							ref={fileInputRef}
							type="file"
							accept=".wav,audio/wav,audio/x-wav"
							multiple
							disabled={busy}
							onChange={(e) => void onFiles(e.target.files)}
						/>
						<p className="panel-note">
							{busy
								? "Working…"
								: "Select multiple WAVs — large files upload directly to storage (up to 500 MB each)."}
						</p>
					</div>
				) : null}

				{step === "confirm" ? (
					<div className="retag-confirm">
						<div className="retag-actions">
							<button type="button" className="btn secondary" onClick={approveAll}>
								Approve all with matches
							</button>
							<label className="retag-dest">
								<span>Destination</span>
								<select
									value={destination}
									onChange={(e) => setDestination(e.target.value)}
								>
									<option value="browser">Browser download</option>
									<option value="drive">Google Drive</option>
									<option value="both">Both</option>
								</select>
							</label>
						</div>

						<ul className="retag-track-list">
							{tracks.map((t) => (
								<li key={t.id} className="retag-track">
									<div className="retag-track-head">
										<label className="retag-approve">
											<input
												type="checkbox"
												checked={t.approved}
												disabled={
													t.status !== "ready" ||
													(!t.selected && !t.overrideUrl.trim())
												}
												onChange={(e) =>
													updateTrack(t.id, { approved: e.target.checked })
												}
											/>
											Approve
										</label>
										<code>{t.filename}</code>
										{t.status === "error" ? (
											<span className="job-error">{t.error}</span>
										) : null}
									</div>

									{t.selected || t.candidates.length > 0 ? (
										<div className="retag-track-match">
											{t.selected?.artworkUrl ? (
												<img
													src={t.selected.artworkUrl}
													alt=""
													width={64}
													height={64}
												/>
											) : (
												<div className="retag-art-fallback" aria-hidden />
											)}
											<div>
												<strong>
													{t.selected?.title || "No match selected"}
												</strong>
												<em>{t.selected?.artist || "—"}</em>
												<p className="panel-note">
													searched <code>{t.searchQuery}</code>
												</p>
											</div>
										</div>
									) : null}

									{t.candidates.length > 1 ? (
										<ul className="retag-candidates">
											{t.candidates.map((c) => {
												const active =
													!t.showOverride && t.selected?.url === c.url;
												return (
													<li key={c.url}>
														<button
															type="button"
															className={`retag-candidate${active ? " active" : ""}`}
															onClick={() =>
																updateTrack(t.id, {
																	selected: c,
																	showOverride: false,
																	approved: true,
																})
															}
														>
															{c.artworkUrl ? (
																<img
																	src={c.artworkUrl}
																	alt=""
																	width={48}
																	height={48}
																/>
															) : (
																<div
																	className="retag-art-fallback"
																	aria-hidden
																/>
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
									) : null}

									{t.showOverride ? (
										<label>
											<span className="panel-note">
												SoundCloud or Spotify URL
											</span>
											<input
												type="url"
												value={t.overrideUrl}
												onChange={(e) =>
													updateTrack(t.id, {
														overrideUrl: e.target.value,
														approved: Boolean(e.target.value.trim()),
													})
												}
												placeholder="https://soundcloud.com/…"
											/>
										</label>
									) : (
										<button
											type="button"
											className="btn ghost"
											onClick={() =>
												updateTrack(t.id, { showOverride: true })
											}
										>
											Wrong match — paste URL
										</button>
									)}
								</li>
							))}
						</ul>

						<div className="retag-actions">
							<button
								type="button"
								className="btn"
								disabled={busy || approvedCount === 0}
								onClick={() => void convertApproved()}
							>
								{busy
									? "Queuing…"
									: `Convert ${approvedCount} to AIFF`}
							</button>
						</div>
					</div>
				) : null}

				{(step === "converting" || step === "done") &&
				convertingTracks.length > 0 ? (
					<ul className="retag-track-list">
						{convertingTracks.map((t) => {
							const job = t.job;
							const fileId = job?.result?.fileId;
							const driveUrl = job?.result?.driveUrl;
							return (
								<li key={t.id} className="retag-track">
									<div className="retag-track-head">
										<strong>
											{job?.artist || job?.title
												? trackDisplayName(job.artist, job.title)
												: t.filename}
										</strong>
										{job ? (
											<span className={`badge status-${job.status}`}>
												{job.status}
											</span>
										) : null}
									</div>
									{job ? (
										<p className="panel-note">
											{job.stage} · {job.progress}%
											{job.error ? ` · ${job.error}` : ""}
										</p>
									) : null}
									{step === "done" && job?.status === "completed" ? (
										<div className="retag-actions">
											{fileId ? (
												<a className="btn" href={`/api/files/${fileId}`}>
													Download AIFF
												</a>
											) : null}
											{driveUrl ? (
												<a
													className="btn secondary"
													href={driveUrl}
													target="_blank"
													rel="noreferrer"
												>
													Open in Drive
												</a>
											) : null}
										</div>
									) : null}
								</li>
							);
						})}
					</ul>
				) : null}
			</section>
		</main>
	);
}

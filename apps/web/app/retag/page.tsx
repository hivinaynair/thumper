"use client";

import { upload } from "@vercel/blob/client";
import { useAuth } from "@clerk/nextjs";
import {
	isRetagInput,
	RETAG_INPUT_LABEL,
	trackDisplayName,
} from "@thumper/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { StatusDot } from "../components/status-dot";
import "../ui-theme.css";

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


const STEPS = [
	["upload", "Upload"],
	["confirm", "Confirm"],
	["converting", "Convert"],
	["done", "Done"],
] as const;

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
				(f) => isRetagInput(f.name, f.type),
			);
			if (files.length === 0) {
				setError(`Select one or more ${RETAG_INPUT_LABEL} files`);
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

	const stepIndex = STEPS.findIndex(([key]) => key === step);

	return (
		<div className="ui-scope min-h-screen">
			<div className="mx-auto max-w-2xl px-5 pt-10 pb-28">
				<h1 className="text-lg font-semibold tracking-tight">Audio → FLAC</h1>
				<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
					Upload one or many SoundCloud free-download files, confirm matches,
					convert losslessly with artwork — download or send to Drive.
				</p>

				<div className="mt-5 flex items-center gap-2">
					{STEPS.map(([key, label], i) => (
						<span key={key} className="flex items-center gap-2">
							<span
								className={`text-[11px] tracking-wide uppercase ${
									i === stepIndex
										? "font-semibold text-primary"
										: i < stepIndex
											? "text-muted-foreground"
											: "text-muted-foreground/40"
								}`}
							>
								{label}
							</span>
							{i < STEPS.length - 1 ? (
								<span className="h-px w-5 bg-border" />
							) : null}
						</span>
					))}
					{step !== "upload" ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="ml-auto h-7 text-xs"
							onClick={reset}
						>
							<RotateCcw /> Start over
						</Button>
					) : null}
				</div>

				{error ? (
					<p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
						{error}
					</p>
				) : null}
				{progressNote ? (
					<p className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
						{progressNote}
					</p>
				) : null}

				{step === "upload" ? (
					<div className="mt-4 rounded-xl border border-border bg-card p-5 shadow-lg shadow-black/30">
						<label
							className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-input px-6 py-10 text-center transition-colors hover:border-primary/60 hover:bg-muted/50 ${
								busy ? "pointer-events-none opacity-60" : ""
							}`}
						>
							{busy ? (
								<Loader2 className="size-5 animate-spin text-muted-foreground" />
							) : (
								<Upload className="size-5 text-muted-foreground" />
							)}
							<span className="text-sm font-medium">
								{busy ? "Working…" : "Choose audio files"}
							</span>
							<span className="text-xs text-muted-foreground">
								{RETAG_INPUT_LABEL} — up to 500 MB each, uploaded straight to
								storage
							</span>
							<input
								ref={fileInputRef}
								type="file"
								className="sr-only"
								accept=".wav,.mp3,.m4a,.flac,audio/wav,audio/x-wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/flac"
								multiple
								disabled={busy}
								onChange={(e) => void onFiles(e.target.files)}
							/>
						</label>
					</div>
				) : null}

				{step === "confirm" ? (
					<>
						<div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
							<Button type="button" variant="secondary" size="sm" onClick={approveAll}>
								Approve all with matches
							</Button>
							<Select value={destination} onValueChange={setDestination}>
								<SelectTrigger className="h-8 w-44 bg-background text-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="browser">Browser download</SelectItem>
									<SelectItem value="drive">Google Drive</SelectItem>
									<SelectItem value="both">Both</SelectItem>
								</SelectContent>
							</Select>
							<Button
								type="button"
								size="sm"
								className="ml-auto"
								disabled={busy || approvedCount === 0}
								onClick={() => void convertApproved()}
							>
								{busy ? (
									<>
										<Loader2 className="animate-spin" /> Queuing
									</>
								) : (
									`Convert ${approvedCount} to FLAC`
								)}
							</Button>
						</div>

						<Separator className="my-6" />

						<div className="space-y-6">
							{tracks.map((t) => {
								const matchable = t.status === "ready" && Boolean(t.selected || t.overrideUrl.trim());
								return (
									<article key={t.id} className="relative pl-5">
										<span className="absolute top-1.5 left-0">
											<StatusDot
												status={
													t.status === "error"
														? "failed"
														: t.status === "searching"
															? "running"
															: matchable
																? "completed"
																: "queued"
												}
											/>
										</span>

										<div className="flex items-center gap-2.5">
											<Checkbox
												checked={t.approved}
												disabled={!matchable}
												onCheckedChange={(v) =>
													updateTrack(t.id, { approved: v === true })
												}
												id={`approve-${t.id}`}
											/>
											<label
												htmlFor={`approve-${t.id}`}
												className="flex-1 cursor-pointer truncate font-mono text-xs text-muted-foreground"
											>
												{t.filename}
											</label>
											{t.status === "searching" ? (
												<Badge variant="outline" className="border-border font-normal text-muted-foreground">
													searching
												</Badge>
											) : null}
										</div>

										{t.status === "error" ? (
											<p className="mt-2 border-l-2 border-[var(--ui-tier-unsuitable)] bg-muted/50 py-2 pl-3 text-[13px] text-[var(--ui-tier-unsuitable)]">
												{t.error}
											</p>
										) : null}

										{t.selected || t.candidates.length > 0 ? (
											<div className="mt-3 flex items-center gap-3">
												{t.selected?.artworkUrl ? (
													// eslint-disable-next-line @next/next/no-img-element
													<img
														src={t.selected.artworkUrl}
														alt=""
														width={56}
														height={56}
														className="size-14 shrink-0 rounded-md object-cover"
													/>
												) : (
													<div className="size-14 shrink-0 rounded-md bg-muted" aria-hidden />
												)}
												<div className="min-w-0">
													<p className="truncate text-sm font-semibold">
														{t.selected?.title || "No match selected"}
													</p>
													<p className="truncate text-xs text-muted-foreground">
														{t.selected?.artist || "—"}
													</p>
													<p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
														searched {t.searchQuery}
													</p>
												</div>
											</div>
										) : null}

										{t.candidates.length > 1 ? (
											<div className="mt-3 grid grid-cols-2 gap-2">
												{t.candidates.map((c) => {
													const active = !t.showOverride && t.selected?.url === c.url;
													return (
														<button
															key={c.url}
															type="button"
															onClick={() =>
																updateTrack(t.id, {
																	selected: c,
																	showOverride: false,
																	approved: true,
																})
															}
															className={`flex items-center gap-2 rounded-md border p-2 text-left transition-colors ${
																active
																	? "border-primary bg-accent"
																	: "border-border hover:bg-muted"
															}`}
														>
															{c.artworkUrl ? (
																// eslint-disable-next-line @next/next/no-img-element
																<img
																	src={c.artworkUrl}
																	alt=""
																	width={36}
																	height={36}
																	className="size-9 shrink-0 rounded object-cover"
																/>
															) : (
																<div className="size-9 shrink-0 rounded bg-muted" aria-hidden />
															)}
															<span className="min-w-0">
																<span className="block truncate text-xs font-medium">
																	{c.title || "Untitled"}
																</span>
																<span className="block truncate text-[11px] text-muted-foreground">
																	{c.artist || "Unknown artist"}
																</span>
															</span>
														</button>
													);
												})}
											</div>
										) : null}

										{t.showOverride ? (
											<div className="mt-3">
												<p className="mb-1.5 text-[11px] text-muted-foreground">
													SoundCloud or Spotify URL
												</p>
												<Input
													type="url"
													value={t.overrideUrl}
													onChange={(e) =>
														updateTrack(t.id, {
															overrideUrl: e.target.value,
															approved: Boolean(e.target.value.trim()),
														})
													}
													placeholder="https://soundcloud.com/…"
													className="bg-background"
												/>
											</div>
										) : (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												className="mt-2 h-7 px-2 text-xs"
												onClick={() => updateTrack(t.id, { showOverride: true })}
											>
												Wrong match — paste URL
											</Button>
										)}
									</article>
								);
							})}
						</div>
					</>
				) : null}

				{(step === "converting" || step === "done") &&
				convertingTracks.length > 0 ? (
					<div className="mt-6 space-y-6">
						{convertingTracks.map((t) => {
							const job = t.job;
							const fileId = job?.result?.fileId;
							const driveUrl = job?.result?.driveUrl;
							return (
								<article key={t.id} className="relative pl-5">
									<span className="absolute top-1.5 left-0">
										<StatusDot status={job?.status ?? "queued"} />
									</span>
									<h2 className="text-[15px] leading-tight font-semibold">
										{job?.artist || job?.title
											? trackDisplayName(job.artist, job.title)
											: t.filename}
									</h2>
									{job ? (
										<p className="mt-1 text-xs text-muted-foreground">
											{job.stage} · {job.progress}%
										</p>
									) : null}
									{job && job.status !== "completed" ? (
										<div className="mt-2.5 h-0.5 w-full overflow-hidden rounded bg-muted">
											<span
												className="block h-full bg-primary transition-[width]"
												style={{ width: `${job.progress}%` }}
											/>
										</div>
									) : null}
									{job?.error ? (
										<p className="mt-3 border-l-2 border-[var(--ui-tier-unsuitable)] bg-muted/50 py-2 pl-3 text-[13px] text-[var(--ui-tier-unsuitable)]">
											{job.error}
										</p>
									) : null}
									{step === "done" && job?.status === "completed" ? (
										<div className="mt-3 flex flex-wrap gap-2">
											{fileId ? (
												<Button asChild size="sm">
													<a href={`/api/files/${fileId}`}>Download FLAC</a>
												</Button>
											) : null}
											{driveUrl ? (
												<Button asChild variant="secondary" size="sm">
													<a href={driveUrl} target="_blank" rel="noreferrer">
														Open in Drive
													</a>
												</Button>
											) : null}
										</div>
									) : null}
								</article>
							);
						})}
					</div>
				) : null}
			</div>
		</div>
	);
}

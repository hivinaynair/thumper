"use client";

/**
 * PROTOTYPE — Variant C: "Feed".
 *
 * Bet: this is a low-frequency, high-attention tool, so the URL box is the hero
 * and results read as prose verdicts rather than badge stacks. Deliberately the
 * opposite trade to Variant A.
 *
 * Built on shadcn primitives so the controls stop looking hand-rolled: a real
 * Select popover instead of the OS dropdown, real Checkboxes, real focus rings.
 */
import { trackDisplayName } from "@thumper/shared";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { jobsToRetry, retryButtonLabel } from "../../../lib/cookie-retry";
import type { Job } from "../page";
import {
  groupJobs,
  verdictOf,
  type DownloaderViewModel,
  type VerdictTier,
} from "./view-model";
import "./ui.css";

const COOKIE_KEYS = [
  ["youtube", "YouTube"],
  ["soundcloud", "SoundCloud"],
  ["spotify", "Spotify"],
  ["instagram", "Instagram"],
] as const;

const TIER_TEXT: Record<VerdictTier, string> = {
  original: "text-[var(--tier-original)]",
  master: "text-[var(--tier-master)]",
  club: "text-[var(--tier-club)]",
  marginal: "text-[var(--tier-marginal)]",
  unsuitable: "text-[var(--tier-unsuitable)]",
  pending: "text-muted-foreground",
};

const TIER_RULE: Record<VerdictTier, string> = {
  original: "border-[var(--tier-original)]",
  master: "border-[var(--tier-master)]",
  club: "border-[var(--tier-club)]",
  marginal: "border-[var(--tier-marginal)]",
  unsuitable: "border-[var(--tier-unsuitable)]",
  pending: "border-border",
};

function name(job: Job): string {
  if (job.title || job.artist) return trackDisplayName(job.artist, job.title);
  return job.sourceUrl;
}

function StatusDot({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "bg-[var(--tier-master)]"
      : status === "failed"
        ? "bg-[var(--tier-unsuitable)]"
        : status === "running"
          ? "bg-primary animate-pulse"
          : "bg-muted-foreground";
  return <span className={`size-2 shrink-0 rounded-full ${tone}`} />;
}

export function VariantCFeed(vm: DownloaderViewModel) {
  const { topLevel, childrenOf } = groupJobs(vm.jobs);
  // "Checking cookie sync…" is a load state, not a failure — the shipped page
  // paints it the same red as a real block, which reads as broken on arrival.
  const checking = !vm.cookies;
  const notice = vm.message ?? (checking ? null : vm.gate.reason);
  const noticeIsError = vm.message ? vm.messageTone === "error" : !vm.gate.ready;

  return (
    <div className="pv-ui min-h-screen">
      <div className="mx-auto max-w-2xl px-5 pt-10 pb-28">
        <form
          onSubmit={vm.createJob}
          className="rounded-xl border border-border bg-card p-5 shadow-lg shadow-black/30"
        >
          <Input
            value={vm.url}
            onChange={(e) => vm.setUrl(e.target.value)}
            placeholder="Paste a YouTube, SoundCloud, or Spotify link"
            required
            className="h-12 border-input bg-background text-base md:text-base"
          />

          <div className="mt-3 flex items-center gap-3">
            <Select value={vm.destination} onValueChange={vm.setDestination}>
              <SelectTrigger className="w-44 bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="browser">Browser</SelectItem>
                <SelectItem value="drive">Google Drive</SelectItem>
                <SelectItem value="both">Both</SelectItem>
              </SelectContent>
            </Select>

            <Button type="submit" disabled={!vm.canQueue} className="ml-auto">
              {vm.busy ? (
                <>
                  <Loader2 className="animate-spin" /> Queuing
                </>
              ) : (
                "Queue download"
              )}
            </Button>
          </div>

          <Collapsible className="mt-4">
            <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
              <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
              Filters
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <label className="flex cursor-pointer gap-2.5">
                <Checkbox
                  checked={vm.freeDownloadsOnly}
                  onCheckedChange={(v) => vm.setFreeDownloadsOnly(v === true)}
                  className="mt-0.5"
                />
                <span className="text-xs leading-relaxed text-muted-foreground">
                  <span className="text-foreground">Free downloads only</span> —
                  skip streams and YouTube mirrors, keeping playlist fills
                  masters-only.
                </span>
              </label>
              <label className="flex cursor-pointer gap-2.5">
                <Checkbox
                  checked={vm.clubReadyOnly}
                  onCheckedChange={(v) => vm.setClubReadyOnly(v === true)}
                  className="mt-0.5"
                />
                <span className="text-xs leading-relaxed text-muted-foreground">
                  <span className="text-foreground">Club-ready only</span> —
                  reject anything whose audio stops short of 19 kHz.
                </span>
              </label>
            </CollapsibleContent>
          </Collapsible>

          {notice ? (
            <p
              className={`mt-4 rounded-md border px-3 py-2 text-xs ${
                noticeIsError
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-border bg-muted text-muted-foreground"
              }`}
            >
              {notice}
            </p>
          ) : null}
        </form>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Sessions</span>
          {COOKIE_KEYS.map(([key, label]) => {
            const present = vm.cookies?.[key]?.present ?? false;
            return (
              <Badge
                key={key}
                variant="outline"
                className="gap-1.5 border-border font-normal text-muted-foreground"
              >
                <span
                  className={`size-1.5 rounded-full ${
                    checking
                      ? "bg-muted-foreground/40"
                      : present
                        ? "bg-[var(--tier-master)]"
                        : "bg-[var(--tier-unsuitable)]"
                  }`}
                />
                {label}
              </Badge>
            );
          })}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => vm.syncCookies()}
            disabled={vm.syncing || !vm.extensionReady}
          >
            <RefreshCw className={vm.syncing ? "animate-spin" : ""} />
            {vm.anyCookiesPresent ? "Refresh" : "Sync"}
          </Button>

          <span className="ml-auto flex gap-2">
            {vm.downloadableCount > 0 ? (
              <Button asChild variant="secondary" size="sm">
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a href="/api/files/zip">
                  Download all ({vm.downloadableCount})
                </a>
              </Button>
            ) : null}
            {vm.finishedCount > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={vm.clearing}
                onClick={() => vm.clearFinishedJobs()}
              >
                {vm.clearing ? "Clearing…" : "Clear finished"}
              </Button>
            ) : null}
          </span>
        </div>

        <Separator className="my-6" />

        {topLevel.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            Nothing queued yet.
          </p>
        ) : (
          <div className="space-y-7">
            {topLevel.map((job) => {
              const v = verdictOf(job);
              const kids = childrenOf(job.id);
              const rollup = vm.rollups.get(job.id);
              const retryTargets = jobsToRetry(job, vm.jobs);
              return (
                <article key={job.id} className="relative pl-5">
                  <span className="absolute top-1.5 left-0">
                    <StatusDot status={job.status} />
                  </span>

                  <h3 className="text-[15px] leading-tight font-semibold">
                    {name(job)}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {job.stage} · {job.audioFormat} · {job.destination}
                    {rollup ? ` · ${rollup.done}/${rollup.total} tracks` : ""}
                    {job.result?.matchScore
                      ? ` · match ${job.result.matchScore}`
                      : ""}
                  </p>

                  {job.status === "running" || job.status === "queued" ? (
                    <div className="mt-2.5 h-0.5 w-full overflow-hidden rounded bg-muted">
                      <span
                        className="block h-full bg-primary transition-[width]"
                        style={{ width: `${job.progress}%` }}
                      />
                    </div>
                  ) : null}

                  {v.tier !== "pending" ? (
                    <p
                      className={`mt-3 border-l-2 bg-muted/50 py-2 pl-3 text-[13px] leading-relaxed ${TIER_RULE[v.tier]}`}
                    >
                      <span
                        className={`font-semibold tracking-wide uppercase ${TIER_TEXT[v.tier]}`}
                      >
                        {v.lead}
                      </span>
                      {v.detail ? (
                        <span className="text-muted-foreground">
                          {" "}
                          — {v.detail}
                        </span>
                      ) : null}
                    </p>
                  ) : null}

                  {kids.length > 0 ? (
                    <ul className="mt-3 space-y-1.5 border-l border-border pl-3">
                      {kids.map((kid) => {
                        const kv = verdictOf(kid);
                        return (
                          <li
                            key={kid.id}
                            className="flex items-center gap-2.5 text-xs"
                          >
                            <StatusDot status={kid.status} />
                            <span className="flex-1 truncate text-muted-foreground">
                              {name(kid)}
                            </span>
                            <span
                              title={kv.detail ?? undefined}
                              className={`text-[10px] font-medium tracking-wider uppercase ${TIER_TEXT[kv.tier]}`}
                            >
                              {kv.lead}
                            </span>
                            {kid.result?.fileId ? (
                              <Button
                                asChild
                                variant="secondary"
                                size="sm"
                                className="h-6 px-2 text-[11px]"
                              >
                                <a href={`/api/files/${kid.result.fileId}`}>Get</a>
                              </Button>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {job.status === "queued" || job.status === "running" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => vm.cancelJob(job.id)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                    {retryTargets.length > 0 ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={vm.retryingId !== null}
                        onClick={() => vm.retryWithNewCookies(job.id)}
                      >
                        {vm.retryingId === job.id
                          ? "Retrying…"
                          : retryButtonLabel(retryTargets.length)}
                      </Button>
                    ) : null}
                    {job.result?.fileId ? (
                      <Button asChild size="sm">
                        <a href={`/api/files/${job.result.fileId}`}>Download</a>
                      </Button>
                    ) : null}
                    {job.result?.driveUrl ? (
                      <Button asChild variant="secondary" size="sm">
                        <a
                          href={job.result.driveUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open in Drive
                        </a>
                      </Button>
                    ) : null}
                    {job.result?.manualDownloadUrl ? (
                      <Button asChild variant="secondary" size="sm">
                        <a
                          href={job.result.manualDownloadUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open gate
                        </a>
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { Download, Headphones, LoaderCircle, Mic2, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { waveformPeaks } from "./progress";

const time = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function StemPlayer({
  fileId,
  role,
  size,
  driveUrl,
}: {
  fileId: string;
  role: string;
  size: string;
  driveUrl?: string;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState<string>();
  const [peaks, setPeaks] = useState<number[]>([]);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const label = role === "vocals" ? "Vocals" : "Instrumental";

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!fileId || !visible) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setLoading(true);
    setError(undefined);
    setPeaks([]);
    setSource(undefined);
    void (async () => {
      try {
        const response = await fetch(`/api/files/${fileId}`, { signal: controller.signal });
        if (!response.ok)
          throw new Error("Preview unavailable. You can still try downloading the file.");
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
        try {
          // A low-rate offline decode keeps memory bounded; playback uses the original file.
          const context = new OfflineAudioContext(1, 1, 8000);
          const decoded = await context.decodeAudioData(await blob.arrayBuffer());
          if (controller.signal.aborted) return;
          setPeaks(
            waveformPeaks(
              Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i)),
            ),
          );
          setDuration(decoded.duration);
        } catch {
          if (!controller.signal.aborted)
            setError(
              "Waveform unavailable in this browser. You can still try playback or download.",
            );
        }
      } catch (err) {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : "Couldn’t load preview.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId, visible]);

  const seek = (value: number) => {
    if (audio.current && duration > 0) {
      audio.current.currentTime = value;
      setPosition(value);
    }
  };
  return (
    <div ref={container} className="stem-player" data-role={role}>
      <div className="stem-player-heading">
        <div className="stem-player-label">
          {role === "vocals" ? <Mic2 size={17} /> : <Headphones size={17} />}
          <strong>{label}</strong>
          <span>{size} · FLAC</span>
        </div>
        <div className="flex gap-2">
          {fileId ? (
            <Button asChild size="sm" variant="ghost">
              <a href={`/api/files/${fileId}`} aria-label={`Download ${label.toLowerCase()} FLAC`}>
                <Download /> Download
              </a>
            </Button>
          ) : null}
          {driveUrl ? (
            <Button asChild size="sm" variant="outline">
              <a href={driveUrl} target="_blank" rel="noreferrer">
                Open in Drive
              </a>
            </Button>
          ) : null}
        </div>
      </div>
      {fileId ? (
        <>
          <div className="stem-player-body">
            <Button
              size="icon"
              variant="outline"
              disabled={!source || loading}
              aria-label={`${playing ? "Pause" : "Play"} ${label.toLowerCase()}`}
              onClick={() => {
                if (!audio.current) return;
                if (playing) audio.current.pause();
                else
                  void audio.current
                    .play()
                    .catch(() =>
                      setError("Couldn’t play this audio. Try downloading the FLAC file."),
                    );
              }}
            >
              {loading ? <LoaderCircle className="animate-spin" /> : playing ? <Pause /> : <Play />}
            </Button>
            <div className="stem-waveform">
              {peaks.length > 0 ? (
                <svg viewBox="0 0 960 80" preserveAspectRatio="none" aria-hidden="true">
                  {peaks.map((peak, index) => (
                    <rect
                      // biome-ignore lint/suspicious/noArrayIndexKey: fixed waveform bins never reorder.
                      key={index}
                      x={index * 4}
                      y={40 - Math.max(1, peak * 36)}
                      width={2.5}
                      height={Math.max(2, peak * 72)}
                      rx={1}
                      fill="currentColor"
                      opacity={index / peaks.length <= position / duration ? 1 : 0.35}
                    />
                  ))}
                  <line
                    x1={(position / duration) * 960 || 0}
                    x2={(position / duration) * 960 || 0}
                    y1="0"
                    y2="80"
                    stroke="currentColor"
                  />
                </svg>
              ) : (
                <span className="stem-waveform-message">
                  {loading ? "Loading waveform…" : "Audio preview"}
                </span>
              )}
              <Slider
                className="stem-waveform-seek"
                aria-label={`Seek ${label.toLowerCase()}`}
                min={0}
                max={duration || 1}
                step={0.1}
                value={[position]}
                disabled={!source || duration === 0}
                onValueChange={([value]) => seek(value ?? 0)}
              />
            </div>
            <span className="stem-player-time">
              {time(position)}
              <span> / {time(duration)}</span>
            </span>
          </div>
          {/* biome-ignore lint/a11y/useMediaCaption: separated music has no caption track. */}
          <audio
            ref={audio}
            src={source}
            preload="metadata"
            onLoadedMetadata={() => {
              if (audio.current && Number.isFinite(audio.current.duration))
                setDuration(audio.current.duration);
            }}
            onTimeUpdate={() => setPosition(audio.current?.currentTime ?? 0)}
            onPlay={() => {
              setPlaying(true);
              window.dispatchEvent(new CustomEvent("thumper-stem-play", { detail: audio.current }));
            }}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() =>
              setError("Playback unavailable in this browser. Download the FLAC to listen.")
            }
          />
          <PauseOtherPlayers audio={audio} />
          {error ? (
            <p className="stem-player-error" role="status">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <p className="stem-player-error">Saved to Google Drive. Open the file there to listen.</p>
      )}
    </div>
  );
}

function PauseOtherPlayers({ audio }: { audio: React.RefObject<HTMLAudioElement | null> }) {
  useEffect(() => {
    const pause = (event: Event) => {
      if ((event as CustomEvent).detail !== audio.current) audio.current?.pause();
    };
    window.addEventListener("thumper-stem-play", pause);
    return () => window.removeEventListener("thumper-stem-play", pause);
  }, [audio]);
  return null;
}

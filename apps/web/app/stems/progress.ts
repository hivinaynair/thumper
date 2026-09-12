export function stageInfo(
  upload: string | undefined,
  stage: string | undefined,
  status: string | undefined,
  failed: boolean,
) {
  if (failed) return { step: 0, title: "Couldn’t separate this track", description: "" };
  if (status === "cancelled") return { step: 0, title: "Cancelled", description: "" };
  if (status === "completed") return { step: 3, title: "Ready to listen", description: "" };
  if (upload === "waiting")
    return {
      step: 0,
      title: "Waiting to upload",
      description: "This file will upload after the files ahead of it.",
    };
  if (upload === "uploading")
    return {
      step: 0,
      title: "Uploading your audio",
      description:
        "Sending your original track securely. Keep this page open until the upload finishes.",
    };
  if (upload === "starting" || status === "queued" || !stage)
    return {
      step: 1,
      title: "Waiting for the AI",
      description:
        "Your file is uploaded. Separation will start when a worker is available; queue times can vary.",
    };
  if (stage === "separating")
    return {
      step: 1,
      title: "Separating vocals and music",
      description:
        "The AI is isolating the voice from the backing track. Longer tracks take more time.",
    };
  if (stage === "delivering")
    return {
      step: 2,
      title: "Saving your stems",
      description:
        "Preparing your vocal and instrumental FLAC files and saving them to your chosen destination.",
    };
  return {
    step: 1,
    title: "Preparing your track",
    description:
      "Loading your audio into the AI. This can take a little longer when the worker first starts.",
  };
}

/** Estimate only the measured AI stage (pipeline progress 10–70), not queue or delivery time. */
export function processingEstimate(
  sample: { progress: number; at: number } | undefined,
  progress: number,
  now: number,
): string | null {
  if (!sample || !Number.isFinite(progress) || progress >= 70) return null;
  const seconds = (now - sample.at) / 1000;
  const delta = progress - sample.progress;
  if (seconds < 10 || delta < 5) return null;
  const remaining = Math.ceil((((70 - progress) / delta) * seconds) / 30) * 30;
  if (remaining <= 60) return "About a minute of AI processing left · saving follows";
  return `About ${Math.ceil(remaining / 60)} min of AI processing left · saving follows`;
}

export function waveformPeaks(channels: Float32Array[], count = 240): number[] {
  const length = channels[0]?.length ?? 0;
  if (!length) return [];
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * length) / count);
    const end = Math.max(start + 1, Math.floor(((index + 1) * length) / count));
    let peak = 0;
    for (const channel of channels) {
      for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(channel[i] ?? 0));
    }
    return Math.min(1, peak);
  });
}

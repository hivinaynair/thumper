"use client";

import { RETAG_INPUT_LABEL } from "@thumper/shared";
import { Loader2, Upload } from "lucide-react";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button";

export function AudioUpload({
  busy,
  inputRef,
  onFiles,
}: {
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | null) => void;
}) {
  return (
    <div className="audio-upload">
      <div className="downloader-empty-icon">
        <Upload size={24} />
      </div>
      <h3>Choose your audio files</h3>
      <p>{RETAG_INPUT_LABEL} · up to 500 MB per file</p>
      <Button type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? (
          <>
            <Loader2 className="animate-spin" /> Uploading…
          </>
        ) : (
          <>
            <Upload /> Choose files
          </>
        )}
      </Button>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose audio files"
        accept=".wav,.mp3,.m4a,.flac,audio/wav,audio/x-wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/flac"
        multiple
        disabled={busy}
        onChange={(e) => onFiles(e.target.files)}
      />
    </div>
  );
}

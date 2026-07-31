import { spawn, type ChildProcess } from "node:child_process";

export class ProcessCancelledError extends Error {
  constructor(message = "Process cancelled") {
    super(message);
    this.name = "ProcessCancelledError";
  }
}

export type SpawnOptions = {
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

const active = new Set<ChildProcess>();

function killTree(child: ChildProcess) {
  try {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  } catch {
    /* ignore */
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (options.signal?.aborted) {
    throw new ProcessCancelledError();
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    active.add(child);

    let stdout = "";
    let stderr = "";

    const onAbort = () => {
      killTree(child);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (buf: Buffer) => {
      const text = buf.toString();
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      const text = buf.toString();
      stderr += text;
      options.onStderr?.(text);
    });

    child.on("error", (err) => {
      active.delete(child);
      options.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      active.delete(child);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) {
        reject(new ProcessCancelledError());
        return;
      }
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

/**
 * Like `runCommand`, but keeps stdout as bytes. Needed for ffmpeg PCM output —
 * decoding raw samples through a JS string mangles them.
 */
export async function runCommandBuffer(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  if (options.signal?.aborted) {
    throw new ProcessCancelledError();
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    active.add(child);

    const chunks: Buffer[] = [];
    let stderr = "";

    const onAbort = () => {
      killTree(child);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (buf: Buffer) => {
      chunks.push(buf);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString();
    });

    child.on("error", (err) => {
      active.delete(child);
      options.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      active.delete(child);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) {
        reject(new ProcessCancelledError());
        return;
      }
      resolve({ stdout: Buffer.concat(chunks), stderr, code: code ?? 1 });
    });
  });
}

export async function runCommandOk(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} failed (${result.code}): ${result.stderr.slice(-2000)}`,
    );
  }
  return result;
}

import fs from "node:fs";
import path from "node:path";

function getVenvExePath(exeName: string, envVar?: string): string {
  if (envVar && process.env[envVar]) return process.env[envVar]!;

  const local = path.join(process.cwd(), ".venv", "bin", exeName);
  if (fs.existsSync(local)) return local;

  const docker = path.join("/opt/venv/bin", exeName);
  if (fs.existsSync(docker)) return docker;

  return exeName;
}

export function getYtDlpPath(): string {
  return getVenvExePath("yt-dlp", "YT_DLP_PATH");
}

export function dataRoot(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "data");
}

export function userRoot(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(dataRoot(), "users", safe);
}

export function assertPathInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error("Path escapes user root");
  }
  return resolved;
}

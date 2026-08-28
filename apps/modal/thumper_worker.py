"""Modal app: run one Thumper download job (Bun + yt-dlp + ffmpeg), then exit.

Deploy from anywhere:
  modal deploy apps/modal/thumper_worker.py

Secret (create once):
  modal secret create thumper-secrets \\
    DATABASE_URL=... \\
    COOKIE_ENCRYPTION_KEY=... \\
    CLERK_SECRET_KEY=... \\
    BLOB_READ_WRITE_TOKEN=... \\
    MODAL_WEBHOOK_SECRET=...
"""

from __future__ import annotations

import os
import secrets as stdlib_secrets
import subprocess
from pathlib import Path

import modal

try:
    from .subprocess_retry import run_process_job_command, run_sweep_command
except ImportError:
    from subprocess_retry import run_process_job_command, run_sweep_command

APP_NAME = "thumper-worker"

# Same Deno pin as the root Dockerfile — yt-dlp needs an external JS runtime
# (plus yt-dlp-ejs from the [default] extra) to solve YouTube challenges.
DENO_VERSION = "2.6.10"

# Local checkout for image build; Modal runtime mounts the module under /root/.
_here = Path(__file__).resolve()
try:
    _candidate = _here.parents[2]
    REPO_ROOT = _candidate if (_candidate / "package.json").exists() else Path("/app")
except IndexError:
    REPO_ROOT = Path("/app")


worker_image = (
    modal.Image.from_registry("oven/bun:1.3-debian", add_python="3.12")
    .apt_install(
        "ffmpeg",
        "ca-certificates",
        "chromium",
        "python3",
        "python3-venv",
        "curl",
        "unzip",
    )
    .add_local_file(
        str(REPO_ROOT / "scripts/chromium-worker"),
        remote_path="/tmp/chromium-worker",
        copy=True,
    )
    .run_commands(
        "groupadd --system --gid 922 chromium-worker",
        "useradd --system --uid 922 --gid chromium-worker "
        "--home-dir /var/lib/chromium --create-home "
        "--shell /usr/sbin/nologin chromium-worker",
        "install -m 0755 /tmp/chromium-worker /usr/local/bin/chromium-worker",
        "install -d -o 922 -g 922 -m 0700 /var/lib/chromium/xdg /var/lib/chromium/tmp",
        "grep -q XDG_RUNTIME_DIR /usr/local/bin/chromium-worker",
        # Deno must be on PATH so yt-dlp can run YouTube EJS challenge solvers.
        f'curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s "v{DENO_VERSION}"',
        "deno --version",
        "python3 -m venv /opt/venv",
        # [default] pulls yt-dlp-ejs; plain yt-dlp alone cannot solve YT challenges.
        '/opt/venv/bin/pip install --no-cache-dir -U pip "yt-dlp[default]" mutagen \'fastapi[standard]\'',
    )
    .pip_install("fastapi[standard]")
    .env(
        {
            "DENO_INSTALL": "/usr/local",
            "PATH": "/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "YT_DLP_PATH": "/opt/venv/bin/yt-dlp",
            "PUPPETEER_EXECUTABLE_PATH": "/usr/local/bin/chromium-worker",
            "PUPPETEER_RUN_UID": "922",
            "PUPPETEER_RUN_GID": "922",
            "DATA_DIR": "/tmp/thumper-data",
        }
    )
    .add_local_dir(
        str(REPO_ROOT),
        remote_path="/app",
        copy=True,
        ignore=[
            "**/node_modules/**",
            "**/.next/**",
            "**/data/**",
            "**/.git/**",
            "**/dist/**",
            "**/.turbo/**",
            "**/agent-transcripts/**",
            "**/.cursor/**",
            "**/.env",
            "**/.env.*",
            "**/.modal.toml",
        ],
    )
    .run_commands("cd /app && bun install --frozen-lockfile")
    .add_local_python_source("subprocess_retry")
    .add_local_python_source("playlist_fanout")
    .add_local_python_source("chromium_isolation")
)

endpoint_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi[standard]")
    .add_local_python_source("subprocess_retry")
)

app = modal.App(APP_NAME)

secrets = modal.Secret.from_name("thumper-secrets")


def _run_process_job(job_id: str) -> str:
    # Bun and every child inherit root-private creation permissions. Chromium
    # then drops to uid 922 and cannot read worker temp files or job secrets.
    os.umask(0o077)
    env = os.environ.copy()
    env.setdefault("DATA_DIR", "/tmp/thumper-data")
    env.setdefault("YT_DLP_PATH", "/opt/venv/bin/yt-dlp")

    # Neon pooler can ETIMEDOUT on a cold Modal container; one quick retry
    # avoids leaving the job stuck in "queued" after a successful wake.
    return run_process_job_command(job_id, env)


@app.function(
    image=worker_image,
    secrets=[secrets],
    timeout=60 * 60,
    cpu=2.0,
    memory=4096,
    max_containers=4,
)
def process_job(job_id: str) -> str:
    output = _run_process_job(job_id)
    try:
        from .playlist_fanout import spawn_fanout_children
    except ImportError:
        from playlist_fanout import spawn_fanout_children

    spawn_fanout_children(job_id, process_job.spawn)
    return output


@app.function(
    image=worker_image,
    secrets=[secrets],
    schedule=modal.Period(minutes=20),
    timeout=300,
)
def sweep_expired() -> str:
    """Delete Blob objects past their expiry (see FILE_TTL_MS in the pipeline)."""
    env = os.environ.copy()
    env.setdefault("DATA_DIR", "/tmp/thumper-data")

    return run_sweep_command(env)


@app.function(image=endpoint_image, secrets=[secrets], timeout=30)
@modal.fastapi_endpoint(method="POST")
def wake(item: dict):
    """HTTP entry used by Vercel when PROCESS_BACKEND=modal."""
    from fastapi import HTTPException

    expected = os.environ.get("MODAL_WEBHOOK_SECRET", "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="webhook secret is not configured")
    provided = str(item.get("secret") or "").strip()
    if not stdlib_secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="unauthorized")

    job_id = str(item.get("jobId") or "").strip()
    if not job_id:
        raise HTTPException(status_code=422, detail="jobId required")

    call = process_job.spawn(job_id)
    return {"ok": True, "jobId": job_id, "callId": call.object_id}


def _run_soundcloud_search(query: str) -> dict:
    env = os.environ.copy()
    env.setdefault("DATA_DIR", "/tmp/thumper-data")
    env.setdefault("YT_DLP_PATH", "/opt/venv/bin/yt-dlp")

    result = subprocess.run(
        ["bun", "src/search-sc.ts", f"--query={query}"],
        cwd="/app/apps/worker",
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "search failed")[-2000:]
        raise RuntimeError(err)
    import json

    return json.loads(result.stdout)


@app.function(
    image=worker_image,
    secrets=[secrets],
    timeout=90,
    cpu=1.0,
    memory=2048,
)
@modal.fastapi_endpoint(method="POST")
def search(item: dict):
    """Sync SoundCloud search for the retag page (yt-dlp lives on Modal)."""
    from fastapi import HTTPException

    expected = os.environ.get("MODAL_WEBHOOK_SECRET", "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="webhook secret is not configured")
    provided = str(item.get("secret") or "").strip()
    if not stdlib_secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="unauthorized")

    query = str(item.get("query") or "").strip()
    if not query:
        raise HTTPException(status_code=422, detail="query required")

    try:
        payload = _run_soundcloud_search(query)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(err)[:500]) from err

    if not payload.get("ok"):
        raise HTTPException(
            status_code=502,
            detail=str(payload.get("error") or "search failed")[:500],
        )
    return {"ok": True, "candidates": payload.get("candidates") or []}


@app.function(
    image=worker_image,
    timeout=120,
    cpu=1.0,
    memory=2048,
)
def smoke_chromium() -> str:
    """Launch system Chromium through the uid-922 wrapper on Modal."""
    try:
        from .chromium_isolation import run_chromium_isolation_smoke
    except ImportError:
        from chromium_isolation import run_chromium_isolation_smoke

    return run_chromium_isolation_smoke()


@app.local_entrypoint()
def main(job_id: str = "", chromium_smoke: bool = False):
    # modal run apps/modal/thumper_worker.py --chromium-smoke
    if chromium_smoke:
        print(smoke_chromium.remote())
        return
    if not job_id:
        raise SystemExit("job_id required unless --chromium-smoke")
    print(process_job.remote(job_id))

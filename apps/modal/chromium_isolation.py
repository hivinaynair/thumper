"""Prove Chromium launches isolated on the Modal worker image."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

CHROMIUM_UID = 922
CHROMIUM_GID = 922
WRAPPER = "/usr/local/bin/chromium-worker"
DEBUG_PORT = 9223
SECRET = "must-not-reach-chromium"
SMOKE_PAGE = "data:text/html,<title>thumper-smoke</title><body>isolated</body>"


class IsolationFailure(RuntimeError):
    pass


def parse_proc_uid(status: str) -> int:
    for line in status.splitlines():
        if line.startswith("Uid:"):
            return int(line.split()[1])
    raise IsolationFailure("Uid missing from /proc status")


def chromium_launch_command(profile: str) -> list[str]:
    return [
        WRAPPER,
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--remote-debugging-address=127.0.0.1",
        f"--remote-debugging-port={DEBUG_PORT}",
        "--remote-allow-origins=*",
        f"--user-data-dir={profile}",
        SMOKE_PAGE,
    ]


def assert_chromium_isolated(
    *,
    uid: int,
    environ: str,
    parent_environ_readable: bool,
    secret_file_readable: bool,
    secret: str,
) -> None:
    if uid != CHROMIUM_UID:
        raise IsolationFailure(f"expected uid {CHROMIUM_UID}, got {uid}")
    if secret in environ.replace("\x00", "\n"):
        raise IsolationFailure("worker secret leaked into Chromium environment")
    if parent_environ_readable:
        raise IsolationFailure("chromium uid can read parent environ")
    if secret_file_readable:
        raise IsolationFailure("chromium uid can read worker secret file")


def _read_as_chromium(path: str) -> bytes:
    result = subprocess.run(
        [
            "python3",
            "-c",
            "import sys; sys.stdout.buffer.write(open(sys.argv[1], 'rb').read())",
            path,
        ],
        user=CHROMIUM_UID,
        group=CHROMIUM_GID,
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        raise IsolationFailure(
            f"uid {CHROMIUM_UID} could not read {path}: "
            f"{(result.stderr or b'').decode('utf-8', 'replace')[-500:]}"
        )
    return result.stdout


def _readable_as_chromium(path: str) -> bool:
    result = subprocess.run(
        ["python3", "-c", "import sys; open(sys.argv[1], 'rb').read()", path],
        user=CHROMIUM_UID,
        group=CHROMIUM_GID,
        check=False,
        capture_output=True,
    )
    return result.returncode == 0


def wait_for_devtools(proc: subprocess.Popen[bytes], log_path: Path, timeout_s: float = 30) -> str:
    url = f"http://127.0.0.1:{DEBUG_PORT}/json/list"
    deadline = time.time() + timeout_s
    last_error = ""
    while time.time() < deadline:
        exited = proc.poll()
        if exited is not None:
            extra = log_path.read_text(errors="replace")[-2000:] if log_path.exists() else ""
            raise IsolationFailure(
                f"Chromium exited {exited} before DevTools started\n{extra}".strip()
            )
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                return response.read().decode()
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            last_error = str(err)
            time.sleep(0.5)
    extra = log_path.read_text(errors="replace")[-2000:] if log_path.exists() else ""
    raise IsolationFailure(
        f"Chromium DevTools did not start: {last_error}\n{extra}".strip()
    )


def run_chromium_isolation_smoke() -> str:
    os.umask(0o077)
    os.environ["WORKER_SMOKE_SECRET"] = SECRET
    secret_path = Path("/tmp/worker-secret")
    secret_path.write_text(SECRET)
    secret_path.chmod(0o600)

    profile = tempfile.mkdtemp(
        prefix="thumper-chromium-",
        dir="/var/lib/chromium/tmp",
    )
    os.chmod(profile, 0o700)
    os.chown(profile, CHROMIUM_UID, CHROMIUM_GID)

    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/var/lib/chromium",
        "TMPDIR": "/var/lib/chromium/tmp",
        "LANG": "C.UTF-8",
        "XDG_RUNTIME_DIR": "/var/lib/chromium/xdg",
    }
    log_path = Path("/tmp/chromium-smoke.log")
    with log_path.open("wb") as log_file:
        proc = subprocess.Popen(
            chromium_launch_command(profile),
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )
    try:
        page_json = wait_for_devtools(proc, log_path)
        if "thumper-smoke" not in page_json:
            raise IsolationFailure(
                f"Chromium did not load the smoke data page: {page_json[:500]}"
            )
        uid = parse_proc_uid(Path(f"/proc/{proc.pid}/status").read_text())
        environ = _read_as_chromium(f"/proc/{proc.pid}/environ").decode(
            "utf-8",
            "replace",
        )
        assert_chromium_isolated(
            uid=uid,
            environ=environ,
            parent_environ_readable=_readable_as_chromium(
                f"/proc/{os.getpid()}/environ"
            ),
            secret_file_readable=_readable_as_chromium(str(secret_path)),
            secret=SECRET,
        )
        return f"SMOKE page=thumper-smoke browser_uid={uid}"
    except IsolationFailure:
        raise
    except Exception as err:
        extra = log_path.read_text(errors="replace")[-2000:] if log_path.exists() else ""
        raise IsolationFailure(f"{err}\n{extra}".strip()) from err
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        shutil.rmtree(profile, ignore_errors=True)

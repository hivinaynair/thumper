from __future__ import annotations

import subprocess
from collections.abc import Mapping, Sequence
from typing import Literal, Protocol


class Runner(Protocol):
    def __call__(
        self,
        command: Sequence[str],
        /,
        *,
        cwd: str,
        env: Mapping[str, str],
        check: Literal[False],
        capture_output: Literal[True],
        text: Literal[True],
    ) -> subprocess.CompletedProcess[str]: ...

TRANSIENT_ERRORS = ("ETIMEDOUT", "CONNECT_TIMEOUT")
WORKER_CWD = "/app/apps/worker"


def run_bounded_subprocess(
    command: Sequence[str],
    *,
    cwd: str,
    env: Mapping[str, str],
    label: str,
    success_tail: int,
    failure_tail: int,
    runner: Runner = subprocess.run,
) -> str:
    """Run a command, retrying one transient connection timeout."""
    last: subprocess.CompletedProcess[str] | None = None
    for attempt in range(2):
        last = runner(
            list(command),
            cwd=cwd,
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )
        if last.returncode == 0:
            return last.stdout[-success_tail:]

        combined_output = f"{last.stdout}\n{last.stderr}"
        is_transient = any(error in combined_output for error in TRANSIENT_ERRORS)
        if not is_transient or attempt == 1:
            break

    assert last is not None
    raise RuntimeError(
        f"{label} failed ({last.returncode})\n"
        f"stdout:\n{last.stdout[-failure_tail:]}\n"
        f"stderr:\n{last.stderr[-failure_tail:]}"
    )


def run_process_job_command(
    job_id: str,
    env: Mapping[str, str],
    *,
    runner: Runner = subprocess.run,
) -> str:
    return run_bounded_subprocess(
        ["bun", "src/process-job.ts", f"--jobId={job_id}"],
        cwd=WORKER_CWD,
        env=env,
        label="process-job",
        success_tail=2000,
        failure_tail=4000,
        runner=runner,
    )


def run_sweep_command(
    env: Mapping[str, str],
    *,
    runner: Runner = subprocess.run,
) -> str:
    return run_bounded_subprocess(
        ["bun", "src/sweep.ts"],
        cwd=WORKER_CWD,
        env=env,
        label="sweep",
        success_tail=1000,
        failure_tail=2000,
        runner=runner,
    )

from __future__ import annotations

import ast
import subprocess
import unittest
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Literal

try:
    from .subprocess_retry import (
        run_bounded_subprocess,
        run_process_job_command,
        run_sweep_command,
    )
except ImportError:
    from subprocess_retry import (
        run_bounded_subprocess,
        run_process_job_command,
        run_sweep_command,
    )


def completed(
    returncode: int, stdout: str = "", stderr: str = ""
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=["bun", "script.ts"],
        returncode=returncode,
        stdout=stdout,
        stderr=stderr,
    )


class FakeRunner:
    def __init__(self, results: list[subprocess.CompletedProcess[str]]):
        self.results = iter(results)
        self.calls: list[tuple[Sequence[str], dict[str, object]]] = []

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
    ) -> subprocess.CompletedProcess[str]:
        self.calls.append(
            (
                command,
                {
                    "cwd": cwd,
                    "env": env,
                    "check": check,
                    "capture_output": capture_output,
                    "text": text,
                },
            )
        )
        return next(self.results)


class RunBoundedSubprocessTests(unittest.TestCase):
    def test_retries_transient_failure_once_and_returns_stdout_tail(self):
        runner = FakeRunner(
            [
                completed(1, stderr="database ETIMEDOUT"),
                completed(0, stdout="prefix-success"),
            ]
        )

        output = run_bounded_subprocess(
            ["bun", "script.ts"],
            cwd="/app/apps/worker",
            env={"DATA_DIR": "/tmp/data"},
            label="sweep",
            success_tail=7,
            failure_tail=20,
            runner=runner,
        )

        self.assertEqual(output, "success")
        self.assertEqual(len(runner.calls), 2)
        for command, kwargs in runner.calls:
            self.assertEqual(command, ["bun", "script.ts"])
            self.assertEqual(kwargs["cwd"], "/app/apps/worker")
            self.assertEqual(kwargs["env"], {"DATA_DIR": "/tmp/data"})
            self.assertFalse(kwargs["check"])
            self.assertTrue(kwargs["capture_output"])
            self.assertTrue(kwargs["text"])

    def test_detects_connect_timeout_across_combined_output(self):
        runner = FakeRunner(
            [
                completed(1, stdout="request failed", stderr="CONNECT_TIMEOUT"),
                completed(0, stdout="recovered"),
            ]
        )

        output = run_bounded_subprocess(
            ["bun", "script.ts"],
            cwd="/work",
            env={},
            label="process-job",
            success_tail=20,
            failure_tail=20,
            runner=runner,
        )

        self.assertEqual(output, "recovered")
        self.assertEqual(len(runner.calls), 2)

    def test_non_transient_failure_raises_without_retry(self):
        runner = FakeRunner([completed(2, stdout="bad output", stderr="fatal error")])

        with self.assertRaisesRegex(RuntimeError, r"^sweep failed \(2\)") as raised:
            run_bounded_subprocess(
                ["bun", "script.ts"],
                cwd="/work",
                env={},
                label="sweep",
                success_tail=20,
                failure_tail=5,
                runner=runner,
            )

        self.assertEqual(len(runner.calls), 1)
        self.assertIn("stdout:\nutput", str(raised.exception))
        self.assertIn("stderr:\nerror", str(raised.exception))

    def test_second_transient_failure_raises_after_exactly_two_attempts(self):
        runner = FakeRunner(
            [
                completed(1, stderr="ETIMEDOUT"),
                completed(3, stdout="old CONNECT_TIMEOUT", stderr="latest ETIMEDOUT"),
            ]
        )

        with self.assertRaisesRegex(RuntimeError, r"^process-job failed \(3\)") as raised:
            run_bounded_subprocess(
                ["bun", "script.ts"],
                cwd="/work",
                env={},
                label="process-job",
                success_tail=20,
                failure_tail=8,
                runner=runner,
            )

        self.assertEqual(len(runner.calls), 2)
        self.assertIn("stdout:\n_TIMEOUT", str(raised.exception))
        self.assertIn("stderr:\nTIMEDOUT", str(raised.exception))


class CommandRetryTests(unittest.TestCase):
    def test_process_job_retries_transient_failure_and_keeps_output_limit(self):
        runner = FakeRunner(
            [
                completed(1, stderr="ETIMEDOUT"),
                completed(0, stdout="x" * 2001),
            ]
        )

        output = run_process_job_command("job-123", {"KEY": "value"}, runner=runner)

        self.assertEqual(output, "x" * 2000)
        self.assertEqual(len(runner.calls), 2)
        self.assertEqual(
            runner.calls[0][0],
            ["bun", "src/process-job.ts", "--jobId=job-123"],
        )

    def test_sweep_retries_transient_failure_and_keeps_output_limit(self):
        runner = FakeRunner(
            [
                completed(1, stderr="CONNECT_TIMEOUT"),
                completed(0, stdout="y" * 1001),
            ]
        )

        output = run_sweep_command({"KEY": "value"}, runner=runner)

        self.assertEqual(output, "y" * 1000)
        self.assertEqual(len(runner.calls), 2)
        self.assertEqual(runner.calls[0][0], ["bun", "src/sweep.ts"])


class ModalImageSourceTests(unittest.TestCase):
    def test_each_modal_image_explicitly_includes_retry_helper(self):
        source = Path(__file__).with_name("thumper_worker.py").read_text()
        module = ast.parse(source)
        image_assignments = {
            target.id: ast.unparse(statement.value)
            for statement in module.body
            if isinstance(statement, ast.Assign)
            for target in statement.targets
            if isinstance(target, ast.Name)
            and target.id in {"worker_image", "endpoint_image"}
        }

        self.assertEqual(set(image_assignments), {"worker_image", "endpoint_image"})
        for name, definition in image_assignments.items():
            with self.subTest(image=name):
                self.assertIn(
                    ".add_local_python_source('subprocess_retry')",
                    definition,
                )


if __name__ == "__main__":
    unittest.main()

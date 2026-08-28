from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

try:
    from .chromium_isolation import (
        IsolationFailure,
        assert_chromium_isolated,
        chromium_launch_command,
        parse_proc_uid,
        wait_for_devtools,
    )
except ImportError:
    from chromium_isolation import (
        IsolationFailure,
        assert_chromium_isolated,
        chromium_launch_command,
        parse_proc_uid,
        wait_for_devtools,
    )


class ChromiumIsolationTests(unittest.TestCase):
    def test_parses_real_uid_from_proc_status(self) -> None:
        status = "Name:\tchromium\nUid:\t922\t922\t922\t922\nGid:\t922\t922\t922\t922\n"
        self.assertEqual(parse_proc_uid(status), 922)

    def test_rejects_root_chromium_or_leaked_secret(self) -> None:
        with self.assertRaisesRegex(IsolationFailure, "expected uid 922"):
            assert_chromium_isolated(
                uid=0,
                environ="PATH=/usr/bin",
                parent_environ_readable=False,
                secret_file_readable=False,
                secret="must-not-reach-chromium",
            )
        with self.assertRaisesRegex(IsolationFailure, "leaked"):
            assert_chromium_isolated(
                uid=922,
                environ="PATH=/usr/bin\nWORKER_SMOKE_SECRET=must-not-reach-chromium",
                parent_environ_readable=False,
                secret_file_readable=False,
                secret="must-not-reach-chromium",
            )
        with self.assertRaisesRegex(IsolationFailure, "parent environ"):
            assert_chromium_isolated(
                uid=922,
                environ="PATH=/usr/bin",
                parent_environ_readable=True,
                secret_file_readable=False,
                secret="must-not-reach-chromium",
            )

    def test_launch_command_uses_wrapper_not_docker(self) -> None:
        command = chromium_launch_command("/tmp/profile")
        self.assertEqual(command[0], "/usr/local/bin/chromium-worker")
        self.assertIn("--headless=new", command)
        self.assertIn("--remote-debugging-address=127.0.0.1", command)
        self.assertNotIn("docker", " ".join(command))

    def test_wait_reports_exit_code_and_log_when_chromium_dies(self) -> None:
        class DeadProc:
            def poll(self) -> int:
                return 1

        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as log:
            log.write("Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted")
            log_path = Path(log.name)

        with self.assertRaisesRegex(IsolationFailure, "exited 1"):
            wait_for_devtools(DeadProc(), log_path, timeout_s=1)


class ModalChromiumPackagingTests(unittest.TestCase):
    def test_worker_image_packages_isolation_helper_and_exposes_smoke(self) -> None:
        source = Path(__file__).with_name("thumper_worker.py").read_text()
        self.assertIn('.add_local_python_source("chromium_isolation")', source)
        self.assertIn("def smoke_chromium", source)
        self.assertIn("--chromium-smoke", source)
        self.assertNotIn("thumper-secrets", source.split("def smoke_chromium", 1)[1][:400])

    def test_wake_module_preamble_does_not_import_worker_only_helpers(self) -> None:
        # wake() runs on endpoint_image, which does not package chromium_isolation
        # or playlist_fanout. A module-level import crash-loops the HTTP endpoint
        # and leaves jobs queued.
        source = Path(__file__).with_name("thumper_worker.py").read_text()
        preamble = source.split("APP_NAME", 1)[0]
        self.assertNotIn("chromium_isolation", preamble)
        self.assertNotIn("playlist_fanout", preamble)
        self.assertIn("subprocess_retry", preamble)

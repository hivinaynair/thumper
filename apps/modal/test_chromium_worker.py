from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import unittest
from pathlib import Path

WRAPPER = Path(__file__).resolve().parents[2] / "scripts" / "chromium-worker"


def load_wrapper():
    loader = importlib.machinery.SourceFileLoader("chromium_worker", str(WRAPPER))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class FakeOS:
    def __init__(self, euid: int = 0) -> None:
        self._euid = euid
        self.calls: list[tuple[object, ...]] = []
        self.environ: dict[str, str] = {}

    def geteuid(self) -> int:
        return self._euid

    def umask(self, mode: int) -> int:
        self.calls.append(("umask", mode))
        return 0o022

    def chdir(self, path: str) -> None:
        self.calls.append(("chdir", path))

    def setgid(self, gid: int) -> None:
        self.calls.append(("setgid", gid))

    def setgroups(self, groups: list[int]) -> None:
        self.calls.append(("setgroups", tuple(groups)))

    def setuid(self, uid: int) -> None:
        self.calls.append(("setuid", uid))

    def execv(self, path: str, args: list[str]) -> None:
        self.calls.append(("execv", path, list(args)))


class ChromiumWorkerTests(unittest.TestCase):
    def test_non_root_exits_before_dropping_privileges(self) -> None:
        module = load_wrapper()
        fake = FakeOS(euid=1000)
        stderr = io.StringIO()

        with self.assertRaises(SystemExit) as raised:
            module.run(
                ["chromium-worker", "--headless"],
                os_module=fake,
                stderr=stderr,
            )

        self.assertEqual(raised.exception.code, 126)
        self.assertIn("worker root process", stderr.getvalue())
        self.assertEqual(fake.calls, [("umask", 0o077)])

    def test_root_drops_to_uid_922_then_execs_chromium_without_setpriv(self) -> None:
        module = load_wrapper()
        fake = FakeOS(euid=0)
        fake.environ.update(
            {
                "DATABASE_URL": "postgres://worker-secret",
                "PATH": "/usr/bin:/bin",
                "HOME": "/var/lib/chromium",
                "LANG": "C.UTF-8",
            }
        )

        module.run(
            ["chromium-worker", "--headless", "--user-data-dir=/tmp/profile"],
            os_module=fake,
            stderr=io.StringIO(),
        )

        self.assertEqual(
            fake.calls,
            [
                ("umask", 0o077),
                ("chdir", "/var/lib/chromium"),
                ("setgid", 922),
                ("setgroups", ()),
                ("setuid", 922),
                (
                    "execv",
                    "/usr/bin/chromium",
                    [
                        "/usr/bin/chromium",
                        "--no-sandbox",
                        "--headless",
                        "--user-data-dir=/tmp/profile",
                    ],
                ),
            ],
        )
        self.assertEqual(
            fake.environ,
            {
                "PATH": "/usr/bin:/bin",
                "HOME": "/var/lib/chromium",
                "TMPDIR": "/var/lib/chromium/tmp",
                "LANG": "C.UTF-8",
                "XDG_RUNTIME_DIR": "/var/lib/chromium/xdg",
            },
        )
        self.assertFalse(hasattr(fake, "setpriv"))
        self.assertNotIn("setpriv", Path(module.__file__).read_text())
        self.assertNotIn("bounding-set", Path(module.__file__).read_text())


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

try:
    from .playlist_fanout import (
        read_fanout_child_ids,
        spawn_fanout_children,
    )
except ImportError:
    from playlist_fanout import (
        read_fanout_child_ids,
        spawn_fanout_children,
    )


class ReadFanoutChildIdsTests(unittest.TestCase):
    def test_returns_child_ids_from_parent_file(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            (directory / "parent-1.json").write_text(
                json.dumps({"childJobIds": ["child-a", "child-b"]})
            )
            self.assertEqual(
                read_fanout_child_ids("parent-1", directory=directory),
                ["child-a", "child-b"],
            )

    def test_missing_file_means_no_children_to_spawn(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            self.assertEqual(
                read_fanout_child_ids("missing", directory=Path(raw)),
                [],
            )


class SpawnFanoutChildrenTests(unittest.TestCase):
    def test_spawns_each_child_except_the_parent(self) -> None:
        spawned: list[str] = []
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            (directory / "parent-1.json").write_text(
                json.dumps({"childJobIds": ["parent-1", "child-a", "child-b"]})
            )
            ids = spawn_fanout_children(
                "parent-1",
                spawned.append,
                directory=directory,
            )

        self.assertEqual(ids, ["child-a", "child-b"])
        self.assertEqual(spawned, ["child-a", "child-b"])

    def test_does_nothing_when_the_parent_did_not_fan_out(self) -> None:
        spawned: list[str] = []
        with tempfile.TemporaryDirectory() as raw:
            spawn_fanout_children("parent-1", spawned.append, directory=Path(raw))
        self.assertEqual(spawned, [])


if __name__ == "__main__":
    unittest.main()

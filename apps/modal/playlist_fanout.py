"""Spawn playlist child jobs after the parent Modal container finishes expanding."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

FANOUT_DIR = Path("/tmp/thumper-fanout")


def read_fanout_child_ids(
    job_id: str,
    *,
    directory: Path | None = None,
) -> list[str]:
    path = (directory or FANOUT_DIR) / f"{job_id}.json"
    if not path.is_file():
        return []
    try:
        payload: Any = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    raw = payload.get("childJobIds") if isinstance(payload, dict) else payload
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, str) and item]


def spawn_fanout_children(
    job_id: str,
    spawn: Callable[[str], object],
    *,
    directory: Path | None = None,
) -> list[str]:
    ids = [child_id for child_id in read_fanout_child_ids(job_id, directory=directory) if child_id != job_id]
    for child_id in ids:
        spawn(child_id)
    return ids

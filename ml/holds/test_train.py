"""Tests for train.py's dataset preparation (SW-01 follow-up, issue #5434).

Only `prepare_dataset` is exercised: the tiling subprocess is stubbed, so these
run in milliseconds and never import torch or rfdetr, let alone train anything.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

import train
from common import load_config


def _coco_set(root: Path) -> Path:
    """The smallest thing prepare_dataset recognises as a tiled/untiled COCO set."""
    (root / "train").mkdir(parents=True, exist_ok=True)
    (root / "train" / "_annotations.coco.json").write_text(json.dumps({"images": [], "annotations": []}))
    return root


@pytest.fixture
def fake_tiler(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, str]]:
    """Replace the tile_coco.py subprocess with a recorder that writes a COCO set."""
    calls: list[dict[str, str]] = []

    def fake_run(argv: list[str], **kwargs: Any) -> None:
        flags = {argv[index]: argv[index + 1] for index in range(2, len(argv) - 1, 2)}
        calls.append(flags)
        _coco_set(Path(flags["--target"]))

    monkeypatch.setattr(train.subprocess, "run", fake_run)
    return calls


@pytest.fixture
def holds_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Point train.py's .data/ at tmp_path so nothing touches the real cache."""
    monkeypatch.setattr(train, "HOLDS_DIR", tmp_path / "holds")
    return tmp_path / "holds"


def test_two_datasets_tile_into_two_distinct_dirs(
    holds_dir: Path, tmp_path: Path, fake_tiler: list[dict[str, str]]
) -> None:
    config = load_config("nano-tiled-1024")
    wayup = _coco_set(tmp_path / "coco")
    roboflow = _coco_set(tmp_path / "roboflow-1class")

    first = train.prepare_dataset(config, wayup)
    second = train.prepare_dataset(config, roboflow)

    assert first != second
    assert "coco-tiles-2x2-0.15-1024" == first.name
    assert "roboflow-1class-tiles-2x2-0.15-1024" == second.name
    # Each one was actually tiled from its own source, not reused.
    assert [call["--source"] for call in fake_tiler] == [str(wayup), str(roboflow)]


def test_reuse_is_a_cache_hit_for_the_same_source(
    holds_dir: Path, tmp_path: Path, fake_tiler: list[dict[str, str]]
) -> None:
    config = load_config("nano-tiled-1024")
    dataset = _coco_set(tmp_path / "coco")

    first = train.prepare_dataset(config, dataset)
    second = train.prepare_dataset(config, dataset)

    assert first == second
    assert len(fake_tiler) == 1  # the second call reused the tiles
    recorded = json.loads((first / train.TILE_SOURCE_FILENAME).read_text())
    assert recorded == {
        "source": str(dataset.resolve()),
        "rows": 2,
        "cols": 2,
        "overlap": 0.15,
        "long_side": 1024,
    }


def test_a_tiled_dir_from_another_source_is_refused(
    holds_dir: Path, tmp_path: Path, fake_tiler: list[dict[str, str]]
) -> None:
    """Same basename, different corpus: refuse rather than train the wrong one."""
    config = load_config("nano-tiled-1024")
    first_run = _coco_set(tmp_path / "a" / "coco")
    tiled = train.prepare_dataset(config, first_run)
    assert tiled.exists()

    second_run = _coco_set(tmp_path / "b" / "coco")
    with pytest.raises(SystemExit, match="different source"):
        train.prepare_dataset(config, second_run)
    assert len(fake_tiler) == 1


def test_a_tiled_dir_with_no_stamp_is_refused(
    holds_dir: Path, tmp_path: Path, fake_tiler: list[dict[str, str]]
) -> None:
    """A cache dir from before the stamp existed has unknown provenance."""
    config = load_config("nano-tiled-1024")
    dataset = _coco_set(tmp_path / "coco")
    _coco_set(train.tiled_dataset_dir(config, dataset))

    with pytest.raises(SystemExit, match="different source"):
        train.prepare_dataset(config, dataset)
    assert fake_tiler == []


def test_untiled_config_uses_the_dataset_as_given(holds_dir: Path, tmp_path: Path) -> None:
    config = load_config("medium-untiled-1280")
    dataset = _coco_set(tmp_path / "roboflow-1class")
    assert train.prepare_dataset(config, dataset) == dataset

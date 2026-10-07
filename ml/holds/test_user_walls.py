"""Tests for data/user_walls.py and the user-walls guards in train.py (SW-20, issue #5471).

Every export here is synthetic: the photos are flat grey rectangles with coloured
discs drawn on them by Pillow, so no climber's wall photo is ever involved. The
layout is the one the backend writes under `spray-training/exports/<exportId>/`.
Nothing imports torch or rfdetr, trains a model or touches a bucket.
"""

from __future__ import annotations

import hashlib
import json
import math
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image, ImageDraw

import eval as holds_eval
import train
from common import load_config
from data import user_walls

EXPORT_ID = "2026-10-07T08:00:00.000Z"
OLDER_EXPORT_ID = "2026-10-06T08:00:00.000Z"
NOW = datetime(2026, 10, 7, 9, 0, tzinfo=timezone.utc)

PHOTO_SIZE = (160, 120)


def _ref(label: str) -> str:
    """A 16-hex ref, the shape the backend's sha256-derived refs take."""
    return hashlib.sha256(label.encode()).hexdigest()[:16]


def _circle_polygon(cx: float, cy: float, r: float, points: int = 24) -> list[float]:
    """The 24-point polygon the backend writes for a circle-only hold."""
    flat: list[float] = []
    for index in range(points):
        angle = 2 * math.pi * index / points
        flat += [round(cx + r * math.cos(angle), 2), round(cy + r * math.sin(angle), 2)]
    return flat


# (version id, root wall label, split) and each photo's holds: (cx, cy, r, attributes)
WALLS: list[tuple[int, str, str]] = [
    (101, "wall-a", "train"),
    (102, "wall-b", "train"),
    (201, "wall-c", "valid"),
    (301, "wall-d", "eval"),
]
HOLDS: list[tuple[float, float, float, dict[str, Any]]] = [
    (30, 30, 10, {"source": "manual", "auto_review": None}),
    (80, 40, 12, {"source": "auto", "auto_review": "accepted"}),
    (120, 80, 9, {"source": "auto", "auto_review": "edited"}),
    (50, 90, 11, {"source": "auto", "auto_review": "confirmed", "mask_from_circle": True}),
]


def _write_split(export_dir: Path, split: str, walls: list[tuple[int, str]]) -> None:
    split_dir = export_dir / split
    split_dir.mkdir(parents=True, exist_ok=True)
    images: list[dict[str, Any]] = []
    annotations: list[dict[str, Any]] = []
    for image_id, (version_id, root_label) in enumerate(walls, start=1):
        file_name = f"v{version_id}.jpg"
        photo = Image.new("RGB", PHOTO_SIZE, (128, 128, 128))
        draw = ImageDraw.Draw(photo)
        for cx, cy, r, _ in HOLDS:
            draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(220, 60, 40))
        photo.save(split_dir / file_name, quality=90)
        images.append(
            {
                "id": image_id,
                "file_name": file_name,
                "width": PHOTO_SIZE[0],
                "height": PHOTO_SIZE[1],
                "boardsesh": {"version_ref": _ref(f"v{version_id}"), "root_ref": _ref(root_label)},
            }
        )
        for cx, cy, r, attributes in HOLDS:
            annotations.append(
                {
                    "id": len(annotations) + 1,
                    "image_id": image_id,
                    "category_id": 1,
                    "bbox": [cx - r, cy - r, 2 * r, 2 * r],
                    "area": math.pi * r * r,
                    "iscrowd": 0,
                    "segmentation": [_circle_polygon(cx, cy, r)],
                    "attributes": attributes,
                }
            )
    payload = {
        "info": {"description": "synthetic user-walls export for tests"},
        "categories": [{"id": 1, "name": "hold", "supercategory": "hold"}],
        "images": images,
        "annotations": annotations,
    }
    (split_dir / user_walls.ANNOTATIONS_FILENAME).write_text(json.dumps(payload))


def write_export(
    exports_dir: Path,
    export_id: str = EXPORT_ID,
    walls: list[tuple[int, str, str]] | None = None,
) -> Path:
    """Write one export the way the backend does, manifest last."""
    export_dir = exports_dir / export_id
    walls = WALLS if walls is None else walls
    for split in user_walls.SPLITS:
        _write_split(export_dir, split, [(version, root) for version, root, wall_split in walls if wall_split == split])
    (export_dir / "candidates.json").write_text(
        json.dumps(
            {
                "images": [
                    {
                        "version_ref": _ref(f"v{version}"),
                        "model_version": "2026-09-18-seg",
                        "candidates": [{"bbox": [70, 30, 20, 20], "confidence": 0.81, "fate": "kept"}],
                    }
                    for version, _, _ in walls
                ]
            }
        )
    )
    files = {
        path.relative_to(export_dir).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(export_dir.rglob("*"))
        if path.is_file()
    }
    manifest = {
        "exportId": export_id,
        "schemaVersion": 1,
        "counts": {"walls": len(walls), "holds": len(walls) * len(HOLDS)},
        "consentSnapshot": {"takenAt": export_id, "walls": len(walls)},
        "splits": {split: [_ref(f"v{v}") for v, _, s in walls if s == split] for split in user_walls.SPLITS},
        "files": files,
    }
    (export_dir / user_walls.MANIFEST_FILENAME).write_text(json.dumps(manifest, indent=2))
    return export_dir


@pytest.fixture
def exports_dir(tmp_path: Path) -> Path:
    """Stands in for spray-training/exports/ in the private bucket."""
    path = tmp_path / "bucket" / "spray-training" / "exports"
    path.mkdir(parents=True)
    return path


@pytest.fixture
def root(tmp_path: Path) -> Path:
    """Stands in for .data/user-walls/ on the training machine."""
    return tmp_path / "user-walls"


def _fetch(exports_dir: Path, root: Path, now: datetime = NOW) -> Path | None:
    return user_walls.fetch(user_walls.DirStore(exports_dir), root, now=now)


# --------------------------------------------------------------------------- #
# fetch
# --------------------------------------------------------------------------- #


def test_fetch_from_dir_materialises_the_harness_layout(
    exports_dir: Path, root: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_export(exports_dir)

    assert user_walls.main(["fetch", "--from-dir", str(exports_dir), "--root", str(root)]) == 0

    local = root / EXPORT_ID
    assert sorted(path.name for path in local.iterdir() if path.is_dir()) == ["eval", "train", "valid"]
    # The held-out split keeps its own name; there is no test/ for rfdetr to score.
    assert not (local / "test").exists()
    assert (local / "train" / "v101.jpg").is_file()
    assert (local / "eval" / "v301.jpg").is_file()
    assert (local / "candidates.json").is_file()

    record = json.loads((local / user_walls.FETCH_RECORD_FILENAME).read_text())
    assert record["exportId"] == EXPORT_ID
    assert datetime.fromisoformat(record["fetched_at"]) <= datetime.now(timezone.utc)

    out = capsys.readouterr().out
    assert "every sha256 verified" in out
    # 1 of the 4 holds on each of the 4 photos is a circle-only mask.
    assert "masks drawn from a circle, not an outline: 4/16 (25.0%)" in out
    assert "detector suggestion, accepted: 4/16 (25.0%)" in out
    assert f"--user-walls-export {EXPORT_ID}" in out


def test_fetch_takes_a_single_export_directory_too(exports_dir: Path, root: Path) -> None:
    export_dir = write_export(exports_dir)
    assert _fetch(export_dir, root) == root / EXPORT_ID


def test_fetch_picks_the_newest_export_with_a_manifest(exports_dir: Path, root: Path) -> None:
    write_export(exports_dir, OLDER_EXPORT_ID)
    write_export(exports_dir, EXPORT_ID)
    # Mid-write: images but no manifest yet. Must be ignored, not fetched.
    unfinished = exports_dir / "2026-10-08T08:00:00.000Z" / "train"
    unfinished.mkdir(parents=True)
    (unfinished / "v999.jpg").write_bytes(b"half an export")

    assert _fetch(exports_dir, root) == root / EXPORT_ID
    assert not (root / "2026-10-08T08:00:00.000Z").exists()


def test_a_sha256_mismatch_keeps_nothing(exports_dir: Path, root: Path) -> None:
    export_dir = write_export(exports_dir)
    (export_dir / "train" / "v101.jpg").write_bytes(b"not the photo the manifest hashed")

    with pytest.raises(SystemExit, match="v101.jpg sha256"):
        _fetch(exports_dir, root)
    assert not (root / EXPORT_ID).exists()
    assert not any(path.name.endswith(".partial") for path in root.iterdir())


def test_a_manifest_path_that_escapes_is_refused(exports_dir: Path, root: Path) -> None:
    export_dir = write_export(exports_dir)
    manifest = json.loads((export_dir / "manifest.json").read_text())
    manifest["files"]["../../outside.jpg"] = "0" * 64
    (export_dir / "manifest.json").write_text(json.dumps(manifest))

    with pytest.raises(SystemExit, match="not a plain relative path"):
        _fetch(exports_dir, root)


def test_an_unknown_schema_version_is_refused(exports_dir: Path, root: Path) -> None:
    export_dir = write_export(exports_dir)
    manifest = json.loads((export_dir / "manifest.json").read_text())
    manifest["schemaVersion"] = 2
    (export_dir / "manifest.json").write_text(json.dumps(manifest))

    with pytest.raises(SystemExit, match="schemaVersion 2"):
        _fetch(exports_dir, root)


def test_fetch_deletes_every_local_export_the_bucket_retired(exports_dir: Path, root: Path) -> None:
    """A wall whose owner switched training off retires its export; fetch removes the local copy."""
    retired = write_export(exports_dir, OLDER_EXPORT_ID)
    _fetch(exports_dir, root)
    # Caches train.py derives from that export live beside it and must go with it.
    (root / f"{OLDER_EXPORT_ID}-cap4" / "train").mkdir(parents=True)
    (root / f".{OLDER_EXPORT_ID}.partial").mkdir()

    shutil.rmtree(retired)
    write_export(exports_dir, EXPORT_ID)
    _fetch(exports_dir, root)

    assert sorted(path.name for path in root.iterdir()) == [user_walls.ROOT_MARKER_FILENAME, EXPORT_ID]


def test_fetch_keeps_an_older_export_the_bucket_still_holds(exports_dir: Path, root: Path) -> None:
    write_export(exports_dir, OLDER_EXPORT_ID)
    _fetch(exports_dir, root, now=NOW - timedelta(days=2))
    (root / f"{OLDER_EXPORT_ID}-cap400").mkdir()
    write_export(exports_dir, EXPORT_ID)
    _fetch(exports_dir, root, now=NOW - timedelta(days=1))
    (root / f"{EXPORT_ID}-tiles-2x2-0.15-1024").mkdir()

    _fetch(exports_dir, root)

    names = {path.name for path in root.iterdir()}
    assert {OLDER_EXPORT_ID, f"{OLDER_EXPORT_ID}-cap400", EXPORT_ID, f"{EXPORT_ID}-tiles-2x2-0.15-1024"} <= names
    # Still in the bucket means still eligible, so its fetched_at moves forward too.
    record = json.loads((root / OLDER_EXPORT_ID / user_walls.FETCH_RECORD_FILENAME).read_text())
    assert datetime.fromisoformat(record["fetched_at"]) == NOW


def test_a_broken_newest_export_still_deletes_retired_ones(exports_dir: Path, root: Path) -> None:
    """A schema bump or a missing file in the newest export must not keep a revoked wall here."""
    retired = write_export(exports_dir, OLDER_EXPORT_ID)
    _fetch(exports_dir, root)
    shutil.rmtree(retired)
    newest = write_export(exports_dir, EXPORT_ID)
    manifest = json.loads((newest / "manifest.json").read_text())
    manifest["schemaVersion"] = 2
    (newest / "manifest.json").write_text(json.dumps(manifest))

    with pytest.raises(SystemExit, match="schemaVersion 2"):
        _fetch(exports_dir, root)
    assert not (root / OLDER_EXPORT_ID).exists()


def test_a_replaced_export_loses_its_caches(exports_dir: Path, root: Path) -> None:
    """Caches built from a local copy that no longer matches the bucket are rebuilt, not reused."""
    export_dir = write_export(exports_dir)
    _fetch(exports_dir, root)
    (root / f"{EXPORT_ID}-cap4").mkdir()
    (root / f"{EXPORT_ID}-tiles-2x2-0.15-1024").mkdir()
    (root / EXPORT_ID / "train" / "v101.jpg").write_bytes(b"locally damaged")

    _fetch(exports_dir, root)

    assert not (root / f"{EXPORT_ID}-cap4").exists()
    assert not (root / f"{EXPORT_ID}-tiles-2x2-0.15-1024").exists()
    assert (root / EXPORT_ID / "train" / "v101.jpg").read_bytes() == (export_dir / "train" / "v101.jpg").read_bytes()


def test_only_train_py_cache_names_count_as_derived() -> None:
    assert user_walls.derived_from(f"{EXPORT_ID}-cap400", EXPORT_ID)
    assert user_walls.derived_from(f"{EXPORT_ID}-tiles-2x2-0.15-1024", EXPORT_ID)
    assert user_walls.derived_from(f"{EXPORT_ID}-tiles-2x2-0.15-1024-cap400", EXPORT_ID)
    assert not user_walls.derived_from(f"{EXPORT_ID}-copy", EXPORT_ID)
    assert not user_walls.derived_from(f"{EXPORT_ID}-cap", EXPORT_ID)
    assert not user_walls.derived_from(f"{EXPORT_ID}-", EXPORT_ID)


def test_fetch_deletes_a_lookalike_of_a_current_export(exports_dir: Path, root: Path) -> None:
    write_export(exports_dir)
    _fetch(exports_dir, root)
    (root / f"{EXPORT_ID}-copy").mkdir()
    _fetch(exports_dir, root)
    assert not (root / f"{EXPORT_ID}-copy").exists()


def test_an_empty_bucket_deletes_everything_local(exports_dir: Path, root: Path) -> None:
    export_dir = write_export(exports_dir)
    _fetch(exports_dir, root)

    shutil.rmtree(export_dir)
    assert _fetch(exports_dir, root) is None
    assert [path.name for path in root.iterdir()] == [user_walls.ROOT_MARKER_FILENAME]


def test_a_failed_listing_deletes_nothing(root: Path, exports_dir: Path) -> None:
    write_export(exports_dir)
    _fetch(exports_dir, root)

    class BrokenStore(user_walls.DirStore):
        def list_export_ids(self) -> list[str]:
            raise RuntimeError("bucket unreachable")

    with pytest.raises(RuntimeError):
        user_walls.fetch(BrokenStore(exports_dir), root, now=NOW)
    assert (root / EXPORT_ID / "train" / "v101.jpg").is_file()


def test_fetch_refuses_a_root_it_does_not_manage(exports_dir: Path, tmp_path: Path) -> None:
    write_export(exports_dir)
    data_dir = tmp_path / "data"
    (data_dir / "roboflow-1class").mkdir(parents=True)

    with pytest.raises(SystemExit, match="refusing to manage"):
        _fetch(exports_dir, data_dir)
    assert (data_dir / "roboflow-1class").is_dir()


def test_a_second_fetch_reuses_a_verified_copy(exports_dir: Path, root: Path, capsys: pytest.CaptureFixture[str]) -> None:
    write_export(exports_dir)
    _fetch(exports_dir, root, now=NOW - timedelta(days=3))
    capsys.readouterr()

    _fetch(exports_dir, root)

    assert "already matches the bucket" in capsys.readouterr().out
    record = json.loads((root / EXPORT_ID / user_walls.FETCH_RECORD_FILENAME).read_text())
    assert datetime.fromisoformat(record["fetched_at"]) == NOW


def test_bucket_config_reads_the_private_prefix_and_the_readme_aliases() -> None:
    config = user_walls.read_private_bucket_config(
        {
            "R2_PRIVATE_BUCKET": "boardsesh-user-private",
            "R2_ENDPOINT": "https://example.r2.cloudflarestorage.com",
            "PRIVATE_AWS_ACCESS_KEY_ID": "id",
            "PRIVATE_AWS_SECRET_ACCESS_KEY": "secret",
        }
    )
    assert config.bucket_name == "boardsesh-user-private"
    assert config.endpoint_url == "https://example.r2.cloudflarestorage.com"
    assert config.region == "auto"

    with pytest.raises(SystemExit, match="PRIVATE_AWS_SECRET_ACCESS_KEY"):
        user_walls.read_private_bucket_config({"PRIVATE_S3_BUCKET_NAME": "b", "PRIVATE_AWS_ACCESS_KEY_ID": "id"})


def test_bucket_store_lists_only_exports_with_a_manifest() -> None:
    class FakePaginator:
        def paginate(self, **kwargs: Any):
            assert kwargs["Prefix"] == user_walls.EXPORTS_PREFIX
            yield {
                "Contents": [
                    {"Key": f"spray-training/exports/{OLDER_EXPORT_ID}/manifest.json"},
                    {"Key": f"spray-training/exports/{OLDER_EXPORT_ID}/train/v1.jpg"},
                    {"Key": f"spray-training/exports/{EXPORT_ID}/train/v2.jpg"},
                    {"Key": f"spray-training/exports/{EXPORT_ID}/train/manifest.json"},
                ]
            }

    class FakeClient:
        def get_paginator(self, name: str) -> FakePaginator:
            assert name == "list_objects_v2"
            return FakePaginator()

    config = user_walls.read_private_bucket_config(
        {"PRIVATE_S3_BUCKET_NAME": "b", "PRIVATE_AWS_ACCESS_KEY_ID": "i", "PRIVATE_AWS_SECRET_ACCESS_KEY": "s"}
    )
    assert user_walls.BucketStore(config, client=FakeClient()).list_export_ids() == [OLDER_EXPORT_ID]


# --------------------------------------------------------------------------- #
# eval isolation
# --------------------------------------------------------------------------- #


def test_an_export_whose_eval_wall_is_also_in_train_is_refused(exports_dir: Path, root: Path) -> None:
    # A reset clone of wall-d (a new version, same root wall) landed in train.
    write_export(exports_dir, walls=[*WALLS, (302, "wall-d", "train")])

    with pytest.raises(SystemExit, match=r"eval wall \(root_ref\) also in train"):
        _fetch(exports_dir, root)
    assert not (root / EXPORT_ID).exists()


def test_an_export_whose_valid_wall_is_also_in_train_is_refused(exports_dir: Path, root: Path) -> None:
    """Valid picks the checkpoint; a training wall in it inflates that choice."""
    write_export(exports_dir, walls=[*WALLS, (202, "wall-c", "train")])

    with pytest.raises(SystemExit, match=r"valid wall \(root_ref\) also in train"):
        _fetch(exports_dir, root)
    assert not (root / EXPORT_ID).exists()


@pytest.mark.parametrize("kind", ["version_ref", "file_name"])
def test_a_valid_version_or_photo_shared_with_train_is_refused(exports_dir: Path, kind: str) -> None:
    export_dir = write_export(exports_dir)
    train_coco = json.loads((export_dir / "train" / "_annotations.coco.json").read_text())
    valid_path = export_dir / "valid" / "_annotations.coco.json"
    valid_coco = json.loads(valid_path.read_text())
    if kind == "version_ref":
        valid_coco["images"][0]["boardsesh"]["version_ref"] = train_coco["images"][0]["boardsesh"]["version_ref"]
    else:
        valid_coco["images"][0]["file_name"] = train_coco["images"][0]["file_name"]
    valid_path.write_text(json.dumps(valid_coco))

    problems = user_walls.eval_isolation_problems(export_dir)
    assert any(problem.startswith("1 valid") and "also in train" in problem for problem in problems)


def test_an_export_without_an_eval_file_is_refused(exports_dir: Path, root: Path) -> None:
    """The backend always writes eval, even empty; its absence means a broken export."""
    export_dir = write_export(exports_dir)
    (export_dir / "eval" / "_annotations.coco.json").unlink()
    manifest = json.loads((export_dir / "manifest.json").read_text())
    del manifest["files"]["eval/_annotations.coco.json"]
    (export_dir / "manifest.json").write_text(json.dumps(manifest))

    with pytest.raises(SystemExit, match="manifest lists no eval/_annotations.coco.json"):
        _fetch(exports_dir, root)


def test_an_export_with_an_empty_eval_split_is_fetched(exports_dir: Path, root: Path) -> None:
    write_export(exports_dir, walls=[wall for wall in WALLS if wall[2] != "eval"])
    local = _fetch(exports_dir, root)
    assert local is not None
    assert json.loads((local / "eval" / "_annotations.coco.json").read_text())["images"] == []


def test_check_training_dataset_catches_a_leak_added_after_fetch(exports_dir: Path, root: Path) -> None:
    write_export(exports_dir)
    local = _fetch(exports_dir, root)
    assert local is not None
    eval_coco = json.loads((local / "eval" / "_annotations.coco.json").read_text())
    train_coco_path = local / "valid" / "_annotations.coco.json"
    valid_coco = json.loads(train_coco_path.read_text())
    valid_coco["images"].append({**eval_coco["images"][0], "id": 99, "file_name": "copied.jpg"})
    train_coco_path.write_text(json.dumps(valid_coco))

    with pytest.raises(SystemExit, match="leaks into training"):
        user_walls.check_training_dataset(local, now=NOW)


@pytest.mark.parametrize("file_name", ["../train/v101.jpg", "sub/v301.jpg", "..", "a\\b.jpg"])
def test_a_coco_file_name_must_be_a_bare_name(exports_dir: Path, root: Path, file_name: str) -> None:
    """`../train/v101.jpg` in eval would score the model on a photo it trained on."""
    export_dir = write_export(exports_dir)
    coco_path = export_dir / "eval" / "_annotations.coco.json"
    coco = json.loads(coco_path.read_text())
    coco["images"][0]["file_name"] = file_name
    coco_path.write_text(json.dumps(coco))
    manifest = json.loads((export_dir / "manifest.json").read_text())
    manifest["files"]["eval/_annotations.coco.json"] = hashlib.sha256(coco_path.read_bytes()).hexdigest()
    (export_dir / "manifest.json").write_text(json.dumps(manifest))

    with pytest.raises(SystemExit):
        _fetch(exports_dir, root)
    assert not (root / EXPORT_ID).exists()
    assert user_walls.eval_isolation_problems(export_dir)


# --------------------------------------------------------------------------- #
# train.py's guards
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("derived", [f"{EXPORT_ID}-cap400", f"{EXPORT_ID}-tiles-2x2-0.15-1024", f"{EXPORT_ID}/train"])
def test_train_refuses_a_cache_or_split_inside_the_fetch_root(
    exports_dir: Path, root: Path, derived: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A derived directory has no fetch record; training on it must not skip the stale guard,
    and must not re-tile user photos into the shared .data/."""
    write_export(exports_dir)
    local = _fetch(exports_dir, root, now=datetime.now(timezone.utc))
    assert local is not None
    target = root / derived
    if not target.exists():
        shutil.copytree(local, target, ignore=shutil.ignore_patterns(user_walls.FETCH_RECORD_FILENAME, "manifest.json"))
    monkeypatch.setattr(train, "HOLDS_DIR", tmp_path / "holds")
    monkeypatch.setattr(train, "resolve_device", lambda requested: pytest.fail("reached device selection"))
    monkeypatch.setattr(sys, "argv", ["train.py", "--config", "seg-nano-tiled-1024", "--dataset", str(target)])

    with pytest.raises(SystemExit, match="is not an export"):
        train.main()
    assert user_walls.is_user_walls_dataset(target)
    # Even if something tiles it anyway, the tiles land in the fetch root.
    assert train.tiled_dataset_dir(load_config("seg-nano-tiled-1024"), target).parent == root.resolve()
    assert not (tmp_path / "holds" / ".data").exists()


def test_train_refuses_a_user_walls_fetch_older_than_seven_days(exports_dir: Path, root: Path) -> None:
    write_export(exports_dir)
    local = _fetch(exports_dir, root)
    assert local is not None

    user_walls.check_training_dataset(local, now=NOW + timedelta(days=6))
    with pytest.raises(SystemExit, match="Re-run `python data/user_walls.py fetch`"):
        user_walls.check_training_dataset(local, now=NOW + timedelta(days=8))


def test_train_main_stops_on_stale_data_before_building_a_model(
    exports_dir: Path, root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_export(exports_dir)
    local = _fetch(exports_dir, root, now=datetime.now(timezone.utc) - timedelta(days=30))
    assert local is not None

    def no_device(requested: str) -> tuple[str, str]:
        raise AssertionError("train.py reached device selection with stale user-walls data")

    monkeypatch.setattr(train, "resolve_device", no_device)
    monkeypatch.setattr(sys, "argv", ["train.py", "--config", "seg-nano-untiled-1024", "--dataset", str(local)])
    with pytest.raises(SystemExit, match="fetched 30 days ago"):
        train.main()


def test_a_user_walls_export_without_a_fetch_record_is_refused(exports_dir: Path) -> None:
    """Training straight off a copied export skips the deletion step, so it is not allowed."""
    export_dir = write_export(exports_dir)
    with pytest.raises(SystemExit, match="not fetched by data/user_walls.py"):
        user_walls.check_training_dataset(export_dir, now=NOW)


def test_other_datasets_are_not_affected(tmp_path: Path) -> None:
    (tmp_path / "roboflow-1class" / "train").mkdir(parents=True)
    user_walls.check_training_dataset(tmp_path / "roboflow-1class", now=NOW)


def test_the_fetched_export_passes_mask_training_validation(exports_dir: Path, root: Path) -> None:
    write_export(exports_dir)
    local = _fetch(exports_dir, root)
    assert local is not None

    train.validate_mask_training_dataset(load_config("seg-nano-untiled-1024"), local)
    train.validate_mask_training_dataset(load_config("seg-nano-tiled-1024"), local)


def test_tiles_of_user_photos_live_beside_the_export_and_leave_with_it(
    exports_dir: Path, root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A tiled config crops the photos; those crops must not outlive a retired export."""
    # train.py's shared .data/ goes to tmp_path, so a tile written there would show.
    fake_holds = tmp_path / "holds"
    fake_holds.mkdir()
    (fake_holds / "data").symlink_to(Path(train.__file__).resolve().parent / "data", target_is_directory=True)
    monkeypatch.setattr(train, "HOLDS_DIR", fake_holds)
    export_dir = write_export(exports_dir)
    local = _fetch(exports_dir, root)
    assert local is not None

    tiled = train.prepare_dataset(load_config("seg-nano-tiled-1024"), local)
    assert tiled.parent == root.resolve()
    assert tiled.name.startswith(f"{EXPORT_ID}-tiles-")
    assert (tiled / "train" / "_annotations.coco.json").is_file()
    assert not (fake_holds / ".data").exists()

    shutil.rmtree(export_dir)
    _fetch(exports_dir, root)
    assert not tiled.exists()


# --------------------------------------------------------------------------- #
# eval.py can score it
# --------------------------------------------------------------------------- #


def _first_photo_boxes(local: Path, split: str) -> np.ndarray:
    """The labelled holds of a split's first photo, as xyxy boxes."""
    payload = json.loads((local / split / "_annotations.coco.json").read_text())
    return np.array(
        [[x, y, x + w, y + h] for x, y, w, h in (a["bbox"] for a in payload["annotations"] if a["image_id"] == 1)],
        dtype=np.float32,
    )


def test_eval_scores_the_user_walls_eval_split(exports_dir: Path, root: Path, tmp_path: Path) -> None:
    write_export(exports_dir)
    local = _fetch(exports_dir, root)
    assert local is not None
    model = tmp_path / "model-int8.onnx"
    model.write_bytes(b"stand-in; the detector is injected")
    truth = _first_photo_boxes(local, "eval")

    def finds_all_but_one(photo: Image.Image) -> tuple[np.ndarray, np.ndarray]:
        # Three of the four real holds, plus one box on bare wall.
        boxes = np.concatenate([truth[:3], np.array([[140, 5, 155, 20]], dtype=np.float32)])
        return boxes, np.full(len(boxes), 0.9, dtype=np.float32)

    config = load_config("seg-nano-untiled-1024")
    results, _ = holds_eval.evaluate(config, local, "eval", model, 1, None, detect_photo=finds_all_but_one)

    assert results["split"] == "eval"
    assert results["photos"] == 1
    assert results["holds"] == 4
    assert results["box"]["tp"] == 3 and results["box"]["fp"] == 1 and results["box"]["fn"] == 1
    # 1 - (2·1 miss + 1 FP) / (2·4 holds)
    assert results["gesture_savings"] == pytest.approx(0.625)
    assert results["per_photo"][0]["gesture_savings"] == pytest.approx(0.625)

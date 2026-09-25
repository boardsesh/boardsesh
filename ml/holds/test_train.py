"""Tests for train.py's dataset preparation (SW-01 follow-up, issue #5434).

Exercise dataset preparation and the training entry point before model creation.
One test runs the real image tiler; none import torch or rfdetr or train a model.
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

    with pytest.raises(SystemExit, match="missing provenance"):
        train.prepare_dataset(config, dataset)
    assert fake_tiler == []


def test_untiled_config_uses_the_dataset_as_given(holds_dir: Path, tmp_path: Path) -> None:
    config = load_config("medium-untiled-1280")
    dataset = _coco_set(tmp_path / "roboflow-1class")
    assert train.prepare_dataset(config, dataset) == dataset


VALID_POLYGON = [[10, 10, 30, 10, 30, 30, 10, 30]]


def _mask_set(root: Path, segmentation: object) -> Path:
    from PIL import Image

    (root / "train").mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (100, 100)).save(root / "train" / "wall.jpg")
    annotation = {"id": 1, "image_id": 1, "category_id": 1, "bbox": [10, 10, 20, 20]}
    if segmentation is not None:
        annotation["segmentation"] = segmentation
    payload = {
        "images": [{"id": 1, "file_name": "wall.jpg", "width": 100, "height": 100}],
        "annotations": [annotation],
        "categories": [{"id": 1, "name": "hold"}],
    }
    (root / "train" / "_annotations.coco.json").write_text(json.dumps(payload))
    return root


@pytest.mark.parametrize("config_name", ["seg-nano-tiled-1024", "seg-nano-untiled-1024"])
@pytest.mark.parametrize("segmentation", [None, [], [[]], [[10, 10, 20, 20, 30, 30]]])
def test_segmentation_training_rejects_box_only_and_empty_masks_before_tiling(
    config_name: str, segmentation: object, holds_dir: Path, tmp_path: Path, fake_tiler: list[dict[str, str]]
) -> None:
    dataset = _mask_set(tmp_path / "coco", segmentation)
    with pytest.raises(SystemExit, match="requires a usable polygon mask for every hold"):
        train.prepare_dataset(load_config(config_name), dataset)
    assert fake_tiler == []


@pytest.mark.parametrize("malformation", ["orphaned annotation", "missing width", "missing height"])
def test_malformed_image_metadata_is_not_reported_as_a_mask_label_problem(
    malformation: str, holds_dir: Path, tmp_path: Path, fake_tiler: list[dict[str, str]]
) -> None:
    dataset = _mask_set(tmp_path / "malformed", VALID_POLYGON)
    path = dataset / "train" / "_annotations.coco.json"
    payload = json.loads(path.read_text())
    if malformation == "orphaned annotation":
        payload["annotations"][0]["image_id"] = 999
        expected_detail = "image_id 999 has no matching image"
    else:
        field = malformation.removeprefix("missing ")
        payload["images"][0].pop(field)
        expected_detail = field
    path.write_text(json.dumps(payload))

    with pytest.raises(SystemExit, match="invalid COCO image metadata") as failure:
        train.prepare_dataset(load_config("seg-nano-tiled-1024"), dataset)
    assert str(path) in str(failure.value)
    assert "annotation 1" in str(failure.value)
    assert expected_detail in str(failure.value)
    assert "box-only" not in str(failure.value)
    assert fake_tiler == []


def test_segmentation_training_rejects_a_mixed_box_and_polygon_corpus(
    holds_dir: Path, tmp_path: Path, fake_tiler: list[dict[str, str]]
) -> None:
    dataset = _mask_set(tmp_path / "mixed", VALID_POLYGON)
    path = dataset / "train" / "_annotations.coco.json"
    payload = json.loads(path.read_text())
    payload["annotations"].append({"id": 2, "image_id": 1, "bbox": [50, 50, 10, 10]})
    path.write_text(json.dumps(payload))
    with pytest.raises(SystemExit, match="annotation 2"):
        train.prepare_dataset(load_config("seg-nano-tiled-1024"), dataset)
    assert fake_tiler == []


@pytest.mark.parametrize("split", ["valid", "test"])
def test_segmentation_training_requires_masks_in_validation_and_test_splits(
    split: str, holds_dir: Path, tmp_path: Path
) -> None:
    dataset = _mask_set(tmp_path / "segmented", VALID_POLYGON)
    payload = json.loads((dataset / "train" / "_annotations.coco.json").read_text())
    payload["annotations"][0].pop("segmentation")
    (dataset / split).mkdir()
    (dataset / split / "_annotations.coco.json").write_text(json.dumps(payload))
    with pytest.raises(SystemExit, match=f"{split}/_annotations.coco.json"):
        train.prepare_dataset(load_config("seg-nano-untiled-1024"), dataset)


def test_segmentation_training_refuses_a_matching_cache_with_empty_masks(
    holds_dir: Path, tmp_path: Path, fake_tiler: list[dict[str, str]]
) -> None:
    config = load_config("seg-nano-tiled-1024")
    dataset = _mask_set(tmp_path / "segmented", VALID_POLYGON)
    cached = _mask_set(train.tiled_dataset_dir(config, dataset), [])
    (cached / train.TILE_SOURCE_FILENAME).write_text(json.dumps(train.tile_source_record(config, dataset)))
    with pytest.raises(SystemExit, match="rebuild any tiled cache"):
        train.prepare_dataset(config, dataset)
    assert fake_tiler == []


def test_valid_mask_cache_without_provenance_is_still_refused(
    holds_dir: Path, tmp_path: Path, fake_tiler: list[dict[str, str]]
) -> None:
    config = load_config("seg-nano-tiled-1024")
    dataset = _mask_set(tmp_path / "segmented", VALID_POLYGON)
    cached = _mask_set(train.tiled_dataset_dir(config, dataset), VALID_POLYGON)

    with pytest.raises(SystemExit, match="missing provenance"):
        train.prepare_dataset(config, dataset)
    assert fake_tiler == []
    assert not (cached / train.TILE_SOURCE_FILENAME).exists()


def test_segmentation_training_rejects_generated_tiles_without_mask_targets(
    holds_dir: Path, tmp_path: Path, fake_tiler: list[dict[str, str]]
) -> None:
    config = load_config("seg-nano-tiled-1024")
    dataset = _mask_set(tmp_path / "segmented", VALID_POLYGON)
    with pytest.raises(SystemExit, match="mask training needs annotated holds"):
        train.prepare_dataset(config, dataset)
    assert len(fake_tiler) == 1
    tiled_dir = train.tiled_dataset_dir(config, dataset)
    assert not (tiled_dir / train.TILE_SOURCE_FILENAME).exists()

    # A retry must preserve the useful mask failure, rather than claim that the
    # unchanged source corpus changed. Keep failed output for inspection; do not
    # silently overwrite it or manufacture a successful provenance stamp.
    with pytest.raises(SystemExit, match="mask training needs annotated holds"):
        train.prepare_dataset(config, dataset)
    assert len(fake_tiler) == 1
    assert (tiled_dir / "train" / "_annotations.coco.json").exists()
    assert not (tiled_dir / train.TILE_SOURCE_FILENAME).exists()


@pytest.mark.parametrize("config_name", ["nano-tiled-1024", "nano-tiled-1024-classical-mask"])
def test_box_models_and_classical_masks_still_allow_box_only_training(
    config_name: str, holds_dir: Path, tmp_path: Path, fake_tiler: list[dict[str, str]]
) -> None:
    dataset = _mask_set(tmp_path / "coco", None)
    assert train.prepare_dataset(load_config(config_name), dataset).exists()
    assert len(fake_tiler) == 1


def test_polygon_labels_survive_actual_tiling_and_can_be_reused_for_mask_training(
    holds_dir: Path, tmp_path: Path
) -> None:
    holds_dir.mkdir(parents=True)
    (holds_dir / "data").symlink_to(Path(__file__).parent / "data", target_is_directory=True)
    config = load_config("seg-nano-tiled-1024")
    dataset = _mask_set(tmp_path / "segmented", VALID_POLYGON)
    prepared = train.prepare_dataset(config, dataset)
    annotations = json.loads((prepared / "train" / "_annotations.coco.json").read_text())["annotations"]
    assert annotations and all(annotation["segmentation"] for annotation in annotations)
    assert train.prepare_dataset(config, dataset) == prepared
    assert train.prepare_dataset(load_config("seg-nano-untiled-1024"), dataset) == dataset


def test_documented_box_only_dataset_cannot_reach_segmentation_model_construction(
    monkeypatch: pytest.MonkeyPatch, holds_dir: Path, tmp_path: Path
) -> None:
    dataset = _mask_set(tmp_path / "coco", None)
    monkeypatch.setattr(train.sys, "argv", ["train.py", "--config", "seg-nano-tiled-1024", "--dataset", str(dataset)])
    monkeypatch.setattr(train, "cap_threads", lambda _threads: None)
    monkeypatch.setattr(train, "resolve_device", lambda _requested: ("cpu", "cpu"))

    def unexpected_model(*args: object, **kwargs: object) -> None:
        pytest.fail("Box-only labels must be rejected before constructing the mask model")

    monkeypatch.setattr(train, "build_model", unexpected_model)
    with pytest.raises(SystemExit, match="box-only labels cannot train a mask model"):
        train.main()


def test_capping_to_only_negative_images_cannot_reach_mask_model_construction(
    monkeypatch: pytest.MonkeyPatch, holds_dir: Path, tmp_path: Path
) -> None:
    dataset = _mask_set(tmp_path / "segmented", VALID_POLYGON)
    path = dataset / "train" / "_annotations.coco.json"
    payload = json.loads(path.read_text())
    # The first image has no holds. A one-image cap drops the only mask target.
    payload["images"].insert(0, {**payload["images"][0], "id": 2, "file_name": "negative.jpg"})
    (dataset / "train" / "negative.jpg").write_bytes((dataset / "train" / payload["images"][1]["file_name"]).read_bytes())
    path.write_text(json.dumps(payload))
    monkeypatch.setattr(
        train.sys, "argv",
        ["train.py", "--config", "seg-nano-untiled-1024", "--dataset", str(dataset), "--max-train-images", "1"],
    )
    monkeypatch.setattr(train, "cap_threads", lambda _threads: None)
    monkeypatch.setattr(train, "resolve_device", lambda _requested: ("cpu", "cpu"))

    def unexpected_model(*args: object, **kwargs: object) -> None:
        pytest.fail("A cap containing no mask targets must be rejected before model construction")

    monkeypatch.setattr(train, "build_model", unexpected_model)
    with pytest.raises(SystemExit, match="mask training needs annotated holds"):
        train.main()

"""Geometry and annotation propagation checks; no model, corpus or network needed."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image
import pytest

from common import TileGrid
from data.tile_coco import clip_polygon_to_tile, tile_split


def vertices(ring: list[float]) -> set[tuple[float, float]]:
    return set(zip(ring[::2], ring[1::2]))


def test_inside_polygon_is_translated_into_tile_coordinates() -> None:
    assert clip_polygon_to_tile([[12, 22, 18, 22, 18, 28, 12, 28]], 1, 10, 20, 30, 40) == [
        [2, 2, 8, 2, 8, 8, 2, 8]
    ]


def test_coordinates_are_scaled_before_clipping() -> None:
    assert clip_polygon_to_tile([[6, 11, 9, 11, 9, 14, 6, 14]], 2, 10, 20, 30, 40) == [
        [2, 2, 8, 2, 8, 8, 2, 8]
    ]


def test_crossing_an_edge_adds_the_intersection_vertices() -> None:
    clipped = clip_polygon_to_tile([[5, 25, 15, 25, 15, 35, 5, 35]], 1, 10, 20, 30, 40)
    assert len(clipped) == 1
    assert vertices(clipped[0]) == {(0, 5), (5, 5), (5, 15), (0, 15)}


def test_polygon_enclosing_the_tile_is_clipped_at_all_four_edges() -> None:
    clipped = clip_polygon_to_tile([[0, 0, 100, 0, 100, 100, 0, 100]], 1, 10, 20, 30, 40)
    assert len(clipped) == 1
    assert vertices(clipped[0]) == {(0, 0), (20, 0), (20, 20), (0, 20)}


@pytest.mark.parametrize(
    "segmentation",
    [None, [], [[]], [[12, 22, 18, 28]], [[0, 0, 5, 0, 5, 5, 0, 5]],
     [[0, 25, 10, 25, 10, 35, 0, 35]], [[12, 22, 14, 24, 16, 26]]],
)
def test_missing_outside_and_degenerate_polygons_produce_no_ring(segmentation: object) -> None:
    assert clip_polygon_to_tile(segmentation, 1, 10, 20, 30, 40) == []


def test_each_polygon_component_is_preserved() -> None:
    polygons = [[12, 22, 14, 22, 14, 24], [20, 30, 22, 30, 22, 32]]
    assert clip_polygon_to_tile(polygons, 1, 10, 20, 30, 40) == [
        [2, 2, 4, 2, 4, 4], [10, 10, 12, 10, 12, 12]
    ]


@pytest.mark.parametrize("counts", [[0, 5, 1], "compressed-rle"])
def test_rle_masks_fail_explicitly_instead_of_losing_training_labels(counts: object) -> None:
    with pytest.raises(ValueError, match="RLE segmentation is not supported"):
        clip_polygon_to_tile({"size": [50, 100], "counts": counts}, 1, 0, 0, 50, 50)


def test_incomplete_coordinate_pair_is_rejected() -> None:
    with pytest.raises(ValueError, match="complete coordinate pairs"):
        clip_polygon_to_tile([[1, 2, 3, 4, 5, 6, 7]], 1, 0, 0, 10, 10)


@pytest.mark.parametrize("coordinate", [float("nan"), float("inf"), "1", True])
def test_invalid_coordinate_is_rejected(coordinate: object) -> None:
    with pytest.raises(ValueError, match="finite numbers"):
        clip_polygon_to_tile([[coordinate, 2, 3, 4, 5, 6]], 1, 0, 0, 10, 10)


def test_tiled_annotations_keep_clipped_polygons(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    Image.new("RGB", (100, 50)).save(source / "wall.jpg")
    (source / "_annotations.coco.json").write_text(json.dumps({
        "images": [{"id": 1, "file_name": "wall.jpg"}],
        "categories": [{"id": 1, "name": "hold"}],
        "annotations": [{
            "id": 1, "image_id": 1, "bbox": [40, 10, 20, 20],
            "segmentation": [[40, 10, 60, 10, 60, 30, 40, 30]],
        }],
    }))
    target = tmp_path / "tiles"
    assert tile_split(source, target, TileGrid(1, 2, 0), 0.5, 100) == {"tiles": 2, "holds": 2}
    annotations = json.loads((target / "_annotations.coco.json").read_text())["annotations"]
    assert annotations[0]["bbox"] == [40, 10, 10, 20]
    assert vertices(annotations[0]["segmentation"][0]) == {(40, 10), (50, 10), (50, 30), (40, 30)}
    assert annotations[1]["bbox"] == [0, 10, 10, 20]
    assert vertices(annotations[1]["segmentation"][0]) == {(0, 10), (10, 10), (10, 30), (0, 30)}


def test_fractional_collinear_points_do_not_survive_floating_point_area_noise() -> None:
    polygon = [[0.01, 0.03, 0.02, 0.05, 0.03, 0.07]]
    assert clip_polygon_to_tile(polygon, 1, 0, 0, 1, 1) == []


def test_smallest_nonzero_triangle_on_the_rounded_grid_is_preserved() -> None:
    polygon = [[0, 0, 0.01, 0, 0, 0.01]]
    assert clip_polygon_to_tile(polygon, 1, 0, 0, 1, 1) == polygon

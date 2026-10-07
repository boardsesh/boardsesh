"""Tests for eval.py's gesture savings (SW-20, issue #5471).

No ONNX model is loaded: these check the arithmetic and that the number lands in
the results file publish_model.py reads.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import eval as holds_eval

HOLDS_DIR = Path(__file__).resolve().parent


def test_a_perfect_detector_saves_every_gesture() -> None:
    assert holds_eval.gesture_savings(fp=0, fn=0, holds=10) == 1.0


def test_finding_nothing_saves_nothing() -> None:
    assert holds_eval.gesture_savings(fp=0, fn=10, holds=10) == 0.0


def test_a_flood_of_false_positives_goes_negative() -> None:
    assert holds_eval.gesture_savings(fp=30, fn=0, holds=10) == pytest.approx(-0.5)


def test_no_labelled_holds_is_none_not_a_number() -> None:
    assert holds_eval.gesture_savings(fp=3, fn=0, holds=0) is None


def test_it_reproduces_the_node_detectors_48_2_percent() -> None:
    """docs/spray-recognition-rollout.md quotes 48.2% for onnxruntime-node on `2026-09-18-seg`.

    That run reported P 0.6909 / R 0.6214 on the 964-hold spray eval split:
    599 true positives, 365 misses and 268 false positives.
    """
    tp, fn = 599, 365
    fp = round(tp / 0.6909) - tp
    assert fp == 268
    assert holds_eval.gesture_savings(fp=fp, fn=fn, holds=tp + fn) == pytest.approx(0.482, abs=0.0005)


@pytest.mark.parametrize(
    ("config", "weighted", "savings"),
    [("nano-untiled-1024", 1.02, 0.489), ("medium-untiled-1280", 1.05, 0.476)],
)
def test_it_agrees_with_the_readme_weighted_corrections(config: str, weighted: float, savings: float) -> None:
    """The committed full-run results: savings is 1 - weighted/2, the README's row halved."""
    results = json.loads(
        (HOLDS_DIR / "results" / "full-run-2026-09-15-m5max" / config / "eval-spraywall-eval.json").read_text()
    )
    box, holds = results["box"], results["holds"]
    assert holds_eval.weighted_corrections(box["fp"], box["fn"]) / holds == pytest.approx(weighted, abs=0.005)
    assert holds_eval.gesture_savings(box["fp"], box["fn"], holds) == pytest.approx(savings, abs=0.0005)

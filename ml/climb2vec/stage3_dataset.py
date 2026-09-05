"""Leakage-safe data and feature builders for the Stage-3 Climb2Vec trial.

The legacy ``dataset.py`` remains the reproduction path for the published
Phase-1 numbers.  This module implements the pre-registered Stage-3 comparison:

* split by physical problem, not UUID, so duplicate listings and every angle
  stay together;
* seal every physical problem containing a Tension benchmark from fitting and
  model selection;
* fit behavioral hold effects on the training fold only;
* compare the incumbent GBM and the relational candidate on exactly the same
  enhanced aggregate feature substrate.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge

import dataset as legacy_dataset

MORPHOLOGY_DIM = 12
HOLD_STATES = ("STARTING", "HAND", "FINISH", "FOOT")
HOLD_STATE_DIM = len(HOLD_STATES)
NODE_STATE_START = legacy_dataset.GEOM_DIM
NODE_STATE_END = NODE_STATE_START + HOLD_STATE_DIM
NODE_DIM = legacy_dataset.GEOM_DIM + HOLD_STATE_DIM + MORPHOLOGY_DIM + 3
PRIMARY_BOARD = "kilter"
TENSION_BOARD = "tension"


@dataclass(frozen=True)
class Stage3Split:
    train: list[dict]
    validation: list[dict]
    test: list[dict]
    tension_benchmark: list[dict]


@dataclass(frozen=True)
class HoldEffects:
    coefficients: Mapping[tuple[str, int, str], float]

    def for_hold(self, row: Mapping, hold: Mapping) -> float:
        key = (
            str(row.get("boardType", "")),
            int(hold.get("modelHoldId", hold["pid"])),
            str(hold["role"]),
        )
        return float(self.coefficients.get(key, 0.0))


def _finite_number(value, default=0.0):
    if value is None:
        return float(default)
    number = float(value)
    return number if math.isfinite(number) else float(default)


def physical_key(row: Mapping) -> str:
    key = row.get("physicalKey")
    if not isinstance(key, str) or not key:
        raise ValueError(
            "Stage-3 rows require physicalKey from extract-training-matrix.ts"
        )
    return key


def stable_fraction(key: str, seed: int = 13) -> float:
    digest = hashlib.sha256(f"climb2vec-stage3:{seed}\0{key}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / float(1 << 64)


def split_rows(
    rows: Sequence[dict],
    train_fraction: float = 0.70,
    validation_fraction: float = 0.15,
    seed: int = 13,
) -> Stage3Split:
    """Make a stable 70/15/15 split at physical-problem granularity.

    If any row for a physical problem is a Tension benchmark, every duplicate
    and angle for that physical problem is sealed into the benchmark set.  This
    is stricter than withholding only the labeled benchmark row and prevents a
    duplicate listing from leaking the answer key.
    """
    if train_fraction <= 0 or validation_fraction <= 0:
        raise ValueError("train and validation fractions must be positive")
    if train_fraction + validation_fraction >= 1:
        raise ValueError("train + validation fractions must be below one")

    sealed_keys = {
        physical_key(row)
        for row in rows
        if row.get("boardType") == TENSION_BOARD
        and row.get("benchmarkDifficulty") is not None
    }
    cross_board_collision_rows = [
        row
        for row in rows
        if row.get("boardType") != TENSION_BOARD
        and physical_key(row) in sealed_keys
    ]
    if cross_board_collision_rows:
        collision_keys = sorted(
            {physical_key(row) for row in cross_board_collision_rows}
        )
        collision_boards = sorted(
            {str(row.get("boardType")) for row in cross_board_collision_rows}
        )
        raise ValueError(
            "sealed Tension physicalKey collision across boards: "
            f"{len(collision_keys)} key(s), "
            f"{len(cross_board_collision_rows)} non-Tension row(s) on "
            f"{collision_boards}; examples={collision_keys[:3]}"
        )
    train: list[dict] = []
    validation: list[dict] = []
    test: list[dict] = []
    tension_benchmark: list[dict] = []
    validation_limit = train_fraction + validation_fraction

    for row in rows:
        key = physical_key(row)
        if key in sealed_keys:
            if row.get("boardType") == TENSION_BOARD:
                tension_benchmark.append(row)
            continue
        fraction = stable_fraction(key, seed=seed)
        if fraction < train_fraction:
            train.append(row)
        elif fraction < validation_limit:
            validation.append(row)
        else:
            test.append(row)

    return Stage3Split(train, validation, test, tension_benchmark)


def assert_disjoint_physical_splits(split: Stage3Split) -> None:
    named_rows = {
        "train": split.train,
        "validation": split.validation,
        "test": split.test,
        "tension_benchmark": split.tension_benchmark,
    }
    keys = {
        name: {physical_key(row) for row in rows}
        for name, rows in named_rows.items()
    }
    names = list(keys)
    for index, left_name in enumerate(names):
        for right_name in names[index + 1 :]:
            overlap = keys[left_name] & keys[right_name]
            if overlap:
                preview = sorted(overlap)[:3]
                raise ValueError(
                    f"physical-key leakage between {left_name} and "
                    f"{right_name}: {preview}"
                )


def assert_unique_physical_angles(rows: Sequence[Mapping]) -> None:
    seen: set[tuple[str, float]] = set()
    for row in rows:
        key = (physical_key(row), float(row["angle"]))
        if key in seen:
            raise ValueError(
                "training extract contains duplicate physicalKey+angle rows: "
                f"{key[0]} at {key[1]}"
            )
        seen.add(key)


def filter_supported_rows(
    rows: Sequence[dict],
    maximum_holds: int = 40,
) -> tuple[list[dict], dict]:
    """Exclude an entire physical problem if any row exceeds the fixed encoder."""
    unsupported_keys = {
        physical_key(row)
        for row in rows
        if len(row.get("holds", [])) == 0
        or len(row.get("holds", [])) > maximum_holds
    }
    supported = [
        row for row in rows if physical_key(row) not in unsupported_keys
    ]
    return supported, {
        "maximumHolds": maximum_holds,
        "inputRows": len(rows),
        "supportedRows": len(supported),
        "excludedRows": len(rows) - len(supported),
        "excludedPhysicalProblems": len(unsupported_keys),
        "excludedPhysicalKeys": sorted(unsupported_keys),
    }


def training_weights(rows: Sequence[Mapping]) -> np.ndarray:
    """Use the frozen Stage-2 signal weight, normalized without changing ratios."""
    raw = np.array(
        [
            max(1e-6, _finite_number(row.get("labelWeight"), 1.0))
            for row in rows
        ],
        dtype=np.float64,
    )
    if raw.size == 0:
        return raw
    mean = float(raw.mean())
    return raw / mean if mean > 0 else np.ones_like(raw)


def labels(rows: Sequence[Mapping], benchmark=False) -> np.ndarray:
    key = "benchmarkDifficulty" if benchmark else "label"
    result = []
    for row in rows:
        value = row.get(key)
        if value is None:
            raise ValueError(f"row {row.get('climbUuid')} has no {key}")
        result.append(float(value))
    return np.asarray(result, dtype=np.float64)


def _hold_token(row: Mapping, hold: Mapping) -> tuple[str, int, str]:
    """Identify the per-placement behavioral effect by hand/foot usage.

    STARTING, HAND, and FINISH remain distinct in the physical route identity
    and in the model's explicit state features.  They intentionally share the
    hand-use effect here, matching the hand/foot behavioral substrate that this
    fold-local ridge estimate replaces.
    """
    return (
        str(row.get("boardType", "")),
        int(hold.get("modelHoldId", hold["pid"])),
        str(hold["role"]),
    )


def fit_hold_effects(
    rows: Sequence[dict],
    alpha: float = 5.0,
) -> HoldEffects:
    """Fit de-confounded hand/foot hold contributions on one training fold."""
    if not rows:
        raise ValueError("cannot fit hold effects on an empty split")
    tokens = sorted(
        {
            _hold_token(row, hold)
            for row in rows
            for hold in row["holds"]
            # The extractor maps STARTING/HAND/FINISH to the behavioral
            # ``hand`` role and FOOT to ``foot``; state remains a separate
            # physical-identity and model feature.
            if hold.get("role") in {"hand", "foot"}
        }
    )
    token_index = {token: index for index, token in enumerate(tokens)}
    angle_column = len(tokens)
    sparse_values: list[float] = []
    sparse_columns: list[int] = []
    sparse_offsets = [0]

    for row in rows:
        active_columns = {
            token_index[_hold_token(row, hold)]
            for hold in row["holds"]
            if _hold_token(row, hold) in token_index
        }
        for column in sorted(active_columns):
            sparse_columns.append(column)
            sparse_values.append(1.0)
        sparse_columns.append(angle_column)
        sparse_values.append((float(row["angle"]) - 40.0) / 10.0)
        sparse_offsets.append(len(sparse_columns))

    incidence = csr_matrix(
        (sparse_values, sparse_columns, sparse_offsets),
        shape=(len(rows), len(tokens) + 1),
        dtype=np.float64,
    )
    model = Ridge(alpha=alpha)
    model.fit(
        incidence,
        labels(rows),
        sample_weight=training_weights(rows),
    )
    return HoldEffects(
        {
            token: float(model.coef_[index])
            for token, index in token_index.items()
        }
    )


def morphology_vector(hold: Mapping) -> np.ndarray:
    raw = hold.get("morph")
    if raw is None:
        return np.zeros(MORPHOLOGY_DIM, dtype=np.float64)
    if len(raw) != MORPHOLOGY_DIM:
        raise ValueError(
            f"morphology vector must have {MORPHOLOGY_DIM} values, got {len(raw)}"
        )
    vector = np.asarray(raw, dtype=np.float64)
    if not np.isfinite(vector).all():
        raise ValueError("morphology vectors must be finite")
    return vector


def hold_state(hold: Mapping) -> str:
    raw_state = hold.get("state")
    if raw_state is None:
        role = hold.get("role")
        if role == "hand":
            return "HAND"
        if role == "foot":
            return "FOOT"
        raise ValueError("hold requires a valid state or hand/foot role")
    state = str(raw_state)
    if state not in HOLD_STATES:
        raise ValueError(f"unknown hold state: {state}")
    return state


def hold_state_one_hot(hold: Mapping) -> np.ndarray:
    state = hold_state(hold)
    return np.asarray(
        [1.0 if state == candidate else 0.0 for candidate in HOLD_STATES],
        dtype=np.float64,
    )


def hold_state_counts(holds: Sequence[Mapping]) -> np.ndarray:
    counts = np.zeros(HOLD_STATE_DIM, dtype=np.float64)
    for hold in holds:
        counts += hold_state_one_hot(hold)
    return counts


def node_feature(hold: Mapping, hold_effect: float) -> np.ndarray:
    geometry = np.asarray(legacy_dataset.hold_geom(hold), dtype=np.float64)
    state_one_hot = hold_state_one_hot(hold)
    morphology = morphology_vector(hold)
    morphology_present = 1.0 if hold.get("morph") is not None else 0.0
    morphology_center_distance = _finite_number(
        hold.get("morphCenterDistance"),
        0.45 if morphology_present == 0 else 0.0,
    )
    return np.concatenate(
        [
            geometry,
            state_one_hot,
            morphology,
            np.asarray(
                [
                    morphology_present,
                    morphology_center_distance,
                    hold_effect,
                ],
                dtype=np.float64,
            ),
        ]
    ).astype(np.float32)


def _effect_aggregate(values: Iterable[float]) -> list[float]:
    array = np.asarray(list(values), dtype=np.float64)
    if array.size == 0:
        array = np.zeros(1, dtype=np.float64)
    return [
        float(array.sum()),
        float(array.mean()),
        float(array.max()),
        float(array.min()),
    ]


def incumbent_features(row: Mapping, effects: HoldEffects) -> np.ndarray:
    """The published Phase-1 GBM substrate, with train-fold hold effects."""
    hands = [
        effects.for_hold(row, hold)
        for hold in row["holds"]
        if hold.get("role") == "hand"
    ]
    feet = [
        effects.for_hold(row, hold)
        for hold in row["holds"]
        if hold.get("role") == "foot"
    ]
    return np.asarray(
        [
            *legacy_dataset.climb_geom_vector(row).tolist(),
            (float(row["angle"]) - 40.0) / 10.0,
            *_effect_aggregate(hands),
            *_effect_aggregate(feet),
        ],
        dtype=np.float64,
    )


def _morphology_aggregate(holds: Sequence[Mapping]) -> list[float]:
    present = [hold for hold in holds if hold.get("morph") is not None]
    if present:
        matrix = np.stack([morphology_vector(hold) for hold in present])
        mean = matrix.mean(axis=0)
        standard_deviation = matrix.std(axis=0)
    else:
        mean = np.zeros(MORPHOLOGY_DIM)
        standard_deviation = np.zeros(MORPHOLOGY_DIM)
    coverage = len(present) / max(1, len(holds))
    distances = [
        _finite_number(hold.get("morphCenterDistance"))
        for hold in present
    ]
    mean_distance = float(np.mean(distances)) if distances else 0.45
    max_distance = float(np.max(distances)) if distances else 0.45
    return [
        *mean.tolist(),
        *standard_deviation.tolist(),
        coverage,
        mean_distance,
        max_distance,
    ]


def _pairwise_summary(holds: Sequence[Mapping]) -> list[float]:
    positions = np.asarray(
        [
            [_finite_number(hold.get("nx")), _finite_number(hold.get("ny"))]
            for hold in holds
        ],
        dtype=np.float64,
    )
    if len(positions) < 2:
        return [0.0] * 12
    left, right = np.triu_indices(len(positions), k=1)
    delta = np.abs(positions[left] - positions[right])
    distance = np.linalg.norm(delta, axis=1)
    features: list[float] = []
    for values in (distance, delta[:, 0], delta[:, 1]):
        features.extend(
            float(value)
            for value in np.quantile(values, [0.1, 0.5, 0.9])
        )
        features.append(float(values.max()))
    return features


def enhanced_features(row: Mapping, effects: HoldEffects) -> np.ndarray:
    """Incumbent features plus morphology and pairwise reach summaries."""
    holds = list(row["holds"])
    hands = [hold for hold in holds if hold.get("role") == "hand"]
    feet = [hold for hold in holds if hold.get("role") == "foot"]
    state_counts = hold_state_counts(holds)
    return np.asarray(
        [
            *incumbent_features(row, effects).tolist(),
            *state_counts,
            *_morphology_aggregate(holds),
            *_morphology_aggregate(hands),
            *_morphology_aggregate(feet),
            *_pairwise_summary(holds),
            *_pairwise_summary(hands),
        ],
        dtype=np.float64,
    )


def feature_matrix(
    rows: Sequence[Mapping],
    effects: HoldEffects,
    enhanced: bool,
) -> np.ndarray:
    builder = enhanced_features if enhanced else incumbent_features
    if not rows:
        width = len(builder({"holds": [], "angle": 40}, HoldEffects({})))
        return np.empty((0, width), dtype=np.float64)
    return np.stack([builder(row, effects) for row in rows])


def fit_gbm(
    train_rows: Sequence[dict],
    enhanced: bool,
    seed: int = 13,
) -> tuple[HistGradientBoostingRegressor, HoldEffects]:
    effects = fit_hold_effects(train_rows)
    model = HistGradientBoostingRegressor(
        max_iter=300,
        learning_rate=0.05,
        max_depth=6,
        random_state=seed,
    )
    model.fit(
        feature_matrix(train_rows, effects, enhanced),
        labels(train_rows),
        sample_weight=training_weights(train_rows),
    )
    return model, effects


def predict_gbm(
    model: HistGradientBoostingRegressor,
    effects: HoldEffects,
    rows: Sequence[dict],
    enhanced: bool,
) -> np.ndarray:
    if not rows:
        return np.empty(0, dtype=np.float64)
    return np.asarray(
        model.predict(feature_matrix(rows, effects, enhanced)),
        dtype=np.float64,
    )


def _fold_for_key(key: str, seed: int) -> int:
    return 0 if stable_fraction(f"crossfit\0{key}", seed=seed) < 0.5 else 1


def cross_fitted_gbm(
    train_rows: Sequence[dict],
    seed: int = 13,
) -> tuple[np.ndarray, list[HoldEffects]]:
    """Out-of-fold enhanced-GBM predictions and matching hold effects."""
    if not train_rows:
        raise ValueError("cannot cross-fit an empty training split")
    folds = np.asarray(
        [_fold_for_key(physical_key(row), seed) for row in train_rows],
        dtype=np.int8,
    )
    if len(set(folds.tolist())) != 2:
        raise ValueError("cross-fit requires physical problems in both folds")

    predictions = np.zeros(len(train_rows), dtype=np.float64)
    row_effects: list[HoldEffects | None] = [None] * len(train_rows)
    for held_out_fold in (0, 1):
        fit_indices = np.flatnonzero(folds != held_out_fold)
        score_indices = np.flatnonzero(folds == held_out_fold)
        fit_rows = [train_rows[index] for index in fit_indices]
        score_rows = [train_rows[index] for index in score_indices]
        model, effects = fit_gbm(fit_rows, enhanced=True, seed=seed)
        fold_predictions = predict_gbm(
            model,
            effects,
            score_rows,
            enhanced=True,
        )
        predictions[score_indices] = fold_predictions
        for index in score_indices:
            row_effects[int(index)] = effects

    if any(effect is None for effect in row_effects):
        raise AssertionError("cross-fit left rows without hold-effect models")
    return predictions, [effect for effect in row_effects if effect is not None]


def tensor_arrays(
    rows: Sequence[dict],
    effects: HoldEffects | Sequence[HoldEffects],
    max_holds: int | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    if not rows:
        raise ValueError("cannot tensorize an empty row set")
    if max_holds is None:
        max_holds = max(len(row["holds"]) for row in rows)
    if max_holds > 40:
        raise ValueError(
            "rows with more than 40 holds must be excluded before tensorization"
        )
    if any(len(row["holds"]) > max_holds for row in rows):
        raise ValueError("max_holds would truncate a supported climb")
    nodes = np.zeros((len(rows), max_holds, NODE_DIM), dtype=np.float32)
    positions = np.zeros((len(rows), max_holds, 2), dtype=np.float32)
    mask = np.zeros((len(rows), max_holds), dtype=np.float32)
    angle = np.zeros((len(rows), 1), dtype=np.float32)

    per_row_effects = (
        list(effects)
        if isinstance(effects, Sequence)
        else [effects] * len(rows)
    )
    if len(per_row_effects) != len(rows):
        raise ValueError("row-specific hold effects must match the row count")

    for row_index, (row, row_effect) in enumerate(
        zip(rows, per_row_effects, strict=True)
    ):
        for hold_index, hold in enumerate(row["holds"]):
            effect = row_effect.for_hold(row, hold)
            nodes[row_index, hold_index] = node_feature(hold, effect)
            positions[row_index, hold_index] = [
                _finite_number(hold.get("nx")),
                _finite_number(hold.get("ny")),
            ]
            mask[row_index, hold_index] = 1.0
        angle[row_index, 0] = (float(row["angle"]) - 40.0) / 20.0
    return nodes, positions, mask, angle


def board_rows(rows: Sequence[dict], board_type: str) -> list[dict]:
    return [row for row in rows if row.get("boardType") == board_type]

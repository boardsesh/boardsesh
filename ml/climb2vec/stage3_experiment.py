"""Pre-registered Stage-3 Climb2Vec experiment.

Top-level compute budget (five runs):

3. Reproduce the incumbent aggregate-feature GBM.
4. Train the same GBM with morphology + pairwise geometry.  Stop unless Kilter
   validation MAE improves by at least 0.05 Aurora difficulty steps.
5. Train the relational residual model with seed 13.
6. Repeat with seed 29.  Stop unless both seeds beat Run 4 by at least 0.05.
7. Refit the selected seed on train+validation with internal cross-fitting, then
   open the sealed test sets once. Ship only if Kilter improves by at least 0.05
   and Tension benchmark MAE regresses by no more than 0.01.

The command defaults to the complete five-run budget and still stops
automatically at either kill criterion. ``--through-run=4`` and ``6`` exist for
cheap pipeline audits, not as a sequential workflow that repeats earlier fits.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Mapping, Sequence

import numpy as np
import torch

import dataset as legacy_dataset
import stage3_dataset as data
from model import RelationalResidualGrader
from training import (
    ResidualTrainingConfig,
    fit_relational_residual,
    set_deterministic_seed,
)

MORPHOLOGY_KILL_IMPROVEMENT = 0.05
RELATIONAL_MIN_IMPROVEMENT = 0.05
FINAL_KILTER_MIN_IMPROVEMENT = 0.05
TENSION_MAX_REGRESSION = 0.01
RELATIONAL_SEEDS = (13, 29)
SUPPORTED_THROUGH_RUNS = (4, 6, 7)
MODEL_VERSION = "climb2vec-relational-morphology-v1"
MIN_CONTENT_SD = 1e-4


@dataclass(frozen=True)
class GradeMetrics:
    n: int
    mae: float
    rmse: float
    exact: float
    within_one: float


@dataclass
class RelationalFit:
    seed: int
    model: RelationalResidualGrader
    max_holds: int
    validation_prediction: np.ndarray
    validation_embedding: np.ndarray
    metrics: GradeMetrics
    improvement: float
    losses: list[float]


@dataclass
class TrainedRelationalModel:
    seed: int
    model: RelationalResidualGrader
    max_holds: int
    losses: list[float]


def require_single_version(
    rows: Sequence[Mapping],
    field: str,
    expected: str | None = None,
) -> str:
    versions = {row.get(field) for row in rows}
    if None in versions or "" in versions:
        raise ValueError(f"every Stage-3 row must record {field}")
    if len(versions) != 1:
        raise ValueError(f"mixed {field} values are not reproducible: {versions}")
    version = str(next(iter(versions)))
    if expected is not None and version != expected:
        raise ValueError(f"{field}={version}; expected {expected}")
    return version


def grade_metrics(prediction, truth) -> GradeMetrics:
    prediction = np.asarray(prediction, dtype=np.float64)
    truth = np.asarray(truth, dtype=np.float64)
    if prediction.shape != truth.shape:
        raise ValueError(
            f"prediction shape {prediction.shape} != truth shape {truth.shape}"
        )
    if truth.size == 0:
        raise ValueError("cannot calculate grade metrics on an empty population")
    error = prediction - truth
    return GradeMetrics(
        n=int(truth.size),
        mae=float(np.mean(np.abs(error))),
        rmse=float(np.sqrt(np.mean(error**2))),
        exact=float(np.mean(np.round(prediction) == np.round(truth))),
        within_one=float(
            np.mean(np.abs(np.round(prediction) - np.round(truth)) <= 1)
        ),
    )


def rounded_metrics(metrics: GradeMetrics) -> dict:
    result = asdict(metrics)
    for key, value in result.items():
        if key != "n":
            result[key] = round(float(value), 4)
    return result


def _indices_for_board(rows: Sequence[Mapping], board_type: str) -> np.ndarray:
    return np.asarray(
        [
            index
            for index, row in enumerate(rows)
            if row.get("boardType") == board_type
        ],
        dtype=np.int64,
    )


def board_metrics(
    prediction: np.ndarray,
    rows: Sequence[dict],
    board_type: str,
    benchmark=False,
) -> GradeMetrics:
    indices = _indices_for_board(rows, board_type)
    if benchmark:
        indices = np.asarray(
            [
                index
                for index in indices
                if rows[int(index)].get("benchmarkDifficulty") is not None
            ],
            dtype=np.int64,
        )
    selected_rows = [rows[int(index)] for index in indices]
    return grade_metrics(
        prediction[indices],
        data.labels(selected_rows, benchmark=benchmark),
    )


def _torch_arrays(
    rows: Sequence[dict],
    effects,
    max_holds=None,
):
    nodes, positions, mask, angle = data.tensor_arrays(
        rows,
        effects,
        max_holds=max_holds,
    )
    return (
        torch.from_numpy(nodes),
        torch.from_numpy(positions),
        torch.from_numpy(mask),
        torch.from_numpy(angle),
    )


def predict_relational(
    model: RelationalResidualGrader,
    rows: Sequence[dict],
    effects: data.HoldEffects,
    baseline_prediction: np.ndarray,
    max_holds: int,
    batch_size: int = 2048,
) -> tuple[np.ndarray, np.ndarray]:
    if len(rows) != len(baseline_prediction):
        raise ValueError("baseline predictions must match relational rows")
    if not rows:
        return (
            np.empty(0, dtype=np.float64),
            np.empty((0, model.emb_dim), dtype=np.float32),
        )
    node, positions, mask, angle = _torch_arrays(
        rows,
        effects,
        max_holds=max_holds,
    )
    grade_chunks = []
    embedding_chunks = []
    model.eval()
    with torch.no_grad():
        for start in range(0, len(rows), batch_size):
            end = min(len(rows), start + batch_size)
            grade, embedding = model(
                node[start:end],
                positions[start:end],
                mask[start:end],
                angle[start:end],
                torch.from_numpy(
                    np.asarray(baseline_prediction[start:end], dtype=np.float32)
                ),
            )
            grade_chunks.append(grade.cpu().numpy())
            embedding_chunks.append(embedding.cpu().numpy())
    return (
        np.concatenate(grade_chunks).astype(np.float64),
        np.concatenate(embedding_chunks).astype(np.float32),
    )


def train_relational_model(
    train_rows: Sequence[dict],
    crossfit_prediction: np.ndarray,
    row_effects: Sequence[data.HoldEffects],
    seed: int,
    epochs: int,
) -> TrainedRelationalModel:
    max_holds = 40
    train_tensors = _torch_arrays(
        train_rows,
        row_effects,
        max_holds=max_holds,
    )
    set_deterministic_seed(seed)
    model = RelationalResidualGrader(node_dim=data.NODE_DIM, seed=seed)
    losses = fit_relational_residual(
        model,
        *train_tensors,
        torch.from_numpy(crossfit_prediction.astype(np.float32)),
        torch.from_numpy(data.labels(train_rows).astype(np.float32)),
        weight=torch.from_numpy(
            data.training_weights(train_rows).astype(np.float32)
        ),
        config=ResidualTrainingConfig(
            epochs=epochs,
            batch_size=512,
            learning_rate=1e-3,
            weight_decay=1e-5,
            huber_delta=1.0,
            seed=seed,
        ),
    )
    return TrainedRelationalModel(
        seed=seed,
        model=model,
        max_holds=max_holds,
        losses=losses,
    )


def fit_relational_candidate(
    train_rows: Sequence[dict],
    validation_rows: Sequence[dict],
    crossfit_prediction: np.ndarray,
    row_effects: Sequence[data.HoldEffects],
    validation_baseline: np.ndarray,
    validation_effects: data.HoldEffects,
    run4_metrics: GradeMetrics,
    seed: int,
    epochs: int,
) -> RelationalFit:
    trained = train_relational_model(
        train_rows,
        crossfit_prediction,
        row_effects,
        seed=seed,
        epochs=epochs,
    )
    validation_prediction, validation_embedding = predict_relational(
        trained.model,
        validation_rows,
        validation_effects,
        validation_baseline,
        max_holds=trained.max_holds,
    )
    metrics = board_metrics(
        validation_prediction,
        validation_rows,
        data.PRIMARY_BOARD,
    )
    return RelationalFit(
        seed=seed,
        model=trained.model,
        max_holds=trained.max_holds,
        validation_prediction=validation_prediction,
        validation_embedding=validation_embedding,
        metrics=metrics,
        improvement=run4_metrics.mae - metrics.mae,
        losses=trained.losses,
    )


def neighbor_grade_agreement(
    rows: Sequence[dict],
    embeddings: np.ndarray,
    sample_limit=2000,
    seed=13,
    benchmark=False,
) -> dict:
    """Production-like nearest-neighbor agreement within one wall configuration.

    Embeddings from different boards or layouts do not share a physical hold
    space, and angle is part of the graded problem. Keep this diagnostic aligned
    with the production export instead of silently selecting cross-space vectors.
    """
    scope = "boardType+layoutId+angle"
    if len(rows) != len(embeddings):
        raise ValueError("embedding count must match rows")
    if len(rows) < 2:
        return {"scope": scope, "n": 0, "neighborGradeMae": None}
    normalized = embeddings / (
        np.linalg.norm(embeddings, axis=1, keepdims=True) + 1e-12
    )
    generator = np.random.default_rng(seed)
    query_indices = np.arange(len(rows))
    if len(query_indices) > sample_limit:
        query_indices = generator.choice(
            query_indices,
            size=sample_limit,
            replace=False,
        )
    keys = [data.physical_key(row) for row in rows]
    cohorts: dict[tuple[str, object, float], list[int]] = {}
    for index, row in enumerate(rows):
        cohort = (
            str(row.get("boardType")),
            row.get("layoutId"),
            float(row["angle"]),
        )
        cohorts.setdefault(cohort, []).append(index)
    row_labels = data.labels(rows, benchmark=benchmark)
    deltas = []
    for query in query_indices:
        query_index = int(query)
        row = rows[query_index]
        cohort = (
            str(row.get("boardType")),
            row.get("layoutId"),
            float(row["angle"]),
        )
        candidates = np.asarray(cohorts[cohort], dtype=np.int64)
        similarities = normalized[candidates] @ normalized[query_index]
        order = candidates[np.argsort(-similarities)]
        neighbor = next(
            (
                int(index)
                for index in order
                if int(index) != query_index
                and keys[int(index)] != keys[query_index]
            ),
            None,
        )
        if neighbor is not None:
            deltas.append(abs(row_labels[query_index] - row_labels[neighbor]))
    return {
        "scope": scope,
        "n": len(deltas),
        "neighborGradeMae": (
            round(float(np.mean(deltas)), 4) if deltas else None
        ),
    }


def grade_band(grade: float) -> str:
    if grade <= 15:
        return "v0-2"
    if grade <= 20:
        return "v3-5"
    if grade <= 24:
        return "v6-8"
    return "v9+"


def calibration_rmse(
    prediction: np.ndarray,
    rows: Sequence[dict],
    benchmark=False,
) -> dict[str, float]:
    """RMSE by predicted band, matching how score-time content_sd is selected."""
    truth = data.labels(rows, benchmark=benchmark)
    squared_by_band: dict[str, list[float]] = {}
    for predicted, actual in zip(prediction, truth, strict=True):
        squared_by_band.setdefault(grade_band(float(predicted)), []).append(
            float((predicted - actual) ** 2)
        )
    all_squared = [
        error
        for errors in squared_by_band.values()
        for error in errors
    ]
    result = {
        band: math.sqrt(float(np.mean(errors)))
        for band, errors in squared_by_band.items()
        if errors
    }
    if all_squared:
        result["all"] = math.sqrt(float(np.mean(all_squared)))
    return result


def board_offsets(rows: Sequence[dict]) -> dict[str, float]:
    offsets: dict[str, list[float]] = {}
    for row in rows:
        local = row.get("localLabel")
        if local is None or row.get("label") is None:
            continue
        offsets.setdefault(str(row.get("boardType")), []).append(
            float(row["label"]) - float(local)
        )
    return {
        board_type: float(np.median(values))
        for board_type, values in offsets.items()
        if values
    }


def content_sd_for(
    board_type: str,
    prediction: float,
    calibration: Mapping[str, Mapping[str, float]],
) -> float:
    band = grade_band(prediction)
    board_calibration = calibration.get(board_type, {})
    direct = board_calibration.get(band)
    if direct is None:
        direct = board_calibration.get("all")
    if direct is not None:
        return max(MIN_CONTENT_SD, float(direct))
    candidates = []
    for source_board in (data.PRIMARY_BOARD, data.TENSION_BOARD):
        source = calibration.get(source_board, {})
        value = source.get(band)
        if value is None:
            value = source.get("all")
        if value is not None:
            candidates.append(float(value))
    return max(MIN_CONTENT_SD, max(candidates)) if candidates else 1.5


def export_predictions(
    path: str,
    rows: Sequence[dict],
    universal_prediction: np.ndarray,
    embeddings: np.ndarray,
    calibration: Mapping[str, Mapping[str, float]],
    offsets: Mapping[str, float],
    unsupported_rows: Sequence[dict] = (),
) -> int:
    if len(rows) != len(universal_prediction) or len(rows) != len(embeddings):
        raise ValueError("score rows, predictions, and embeddings must align")
    pooled_prediction = np.asarray(universal_prediction, dtype=np.float64).copy()
    pooled_embeddings = np.asarray(embeddings, dtype=np.float64).copy()
    groups: dict[tuple[str, float], list[int]] = {}
    for index, row in enumerate(rows):
        groups.setdefault(
            (data.physical_key(row), float(row["angle"])),
            [],
        ).append(index)
    for indices in groups.values():
        if len(indices) < 2:
            continue
        shared_prediction = float(np.mean(pooled_prediction[indices]))
        shared_embedding = np.mean(pooled_embeddings[indices], axis=0)
        shared_norm = float(np.linalg.norm(shared_embedding))
        if shared_norm >= 1e-8:
            shared_embedding /= shared_norm
        else:
            shared_embedding = np.zeros_like(shared_embedding)
        pooled_prediction[indices] = shared_prediction
        pooled_embeddings[indices] = shared_embedding

    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w") as handle:
        for row, universal_grade, embedding in zip(
            rows,
            pooled_prediction,
            pooled_embeddings,
            strict=True,
        ):
            board_type = str(row.get("boardType"))
            local_grade = float(universal_grade) - offsets.get(board_type, 0.0)
            record = {
                "boardType": board_type,
                "climbUuid": row["climbUuid"],
                "angle": row["angle"],
                "layoutId": row.get("layoutId"),
                "fingerprint": row.get("fingerprint"),
                "physicalKey": row.get("physicalKey"),
                "ascents": row.get("ascents", 0),
                "difficultyAverage": row.get("difficultyAverage"),
                "displayDifficulty": row.get("displayDifficulty"),
                "contentPrior": round(local_grade, 4),
                "universalPrior": round(float(universal_grade), 4),
                "contentSd": round(
                    content_sd_for(
                        board_type,
                        float(universal_grade),
                        calibration,
                    ),
                    4,
                ),
                "embedding": [
                    round(float(component), 6)
                    for component in embedding
                ],
                "modelVersion": MODEL_VERSION,
                "supported": True,
            }
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")
        for row in unsupported_rows:
            record = {
                "boardType": str(row.get("boardType")),
                "climbUuid": row["climbUuid"],
                "angle": row["angle"],
                "layoutId": row.get("layoutId"),
                "fingerprint": row.get("fingerprint"),
                "physicalKey": row.get("physicalKey"),
                "ascents": row.get("ascents", 0),
                "difficultyAverage": row.get("difficultyAverage"),
                "displayDifficulty": row.get("displayDifficulty"),
                "contentPrior": None,
                "universalPrior": None,
                "contentSd": None,
                "embedding": None,
                "modelVersion": MODEL_VERSION,
                "supported": False,
                "unsupportedReason": "hold_count_outside_1_to_40",
            }
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")
    return len(rows) + len(unsupported_rows)


def _log_metrics(label: str, metrics: GradeMetrics) -> None:
    print(
        f"[{label}] n={metrics.n} MAE={metrics.mae:.4f} "
        f"RMSE={metrics.rmse:.4f} exact={metrics.exact:.3f} "
        f"within±1={metrics.within_one:.3f}"
    )


def run_experiment(args) -> dict:
    if args.through_run not in SUPPORTED_THROUGH_RUNS:
        raise ValueError(
            "through_run must be one of "
            f"{', '.join(str(run) for run in SUPPORTED_THROUGH_RUNS)}"
        )
    rows = [
        row
        for path in args.data
        for row in legacy_dataset.load_rows(path)
    ]
    rows, hold_count_filter = data.filter_supported_rows(rows, maximum_holds=40)
    data.assert_unique_physical_angles(rows)
    morphology_version = require_single_version(rows, "morphologyVersion")
    morphology_source_version = require_single_version(
        rows,
        "morphologySourceVersion",
    )
    morphology_artifact_sha = require_single_version(
        rows,
        "morphologyArtifactSha256",
    )
    target_version = require_single_version(
        rows,
        "targetVersion",
        expected="climb2vec-frozen-stage2-v1",
    )
    coefficient_version = require_single_version(rows, "coeffVersion")
    extraction_snapshot = require_single_version(rows, "extractionSnapshot")
    benchmark_rejection_manifest = require_single_version(
        rows,
        "benchmarkRejectionManifestSha256",
    )
    rejected_benchmark_physical = int(
        require_single_version(
            rows,
            "rejectedBenchmarkPhysicalProblems",
        )
    )
    split = data.split_rows(rows, seed=13)
    data.assert_disjoint_physical_splits(split)
    if not split.train or not split.validation:
        raise ValueError("training and validation splits must both be non-empty")
    if not data.board_rows(split.validation, data.PRIMARY_BOARD):
        raise ValueError("validation contains no Kilter rows")
    print(
        "[stage3] "
        f"{len(rows)} rows · train={len(split.train)} "
        f"validation={len(split.validation)} test={len(split.test)} "
        f"sealed-tension={len(split.tension_benchmark)}"
    )

    results = {
        "modelVersion": MODEL_VERSION,
        "unit": "one Aurora difficulty integer step (one Font sub-grade, about half a V-grade)",
        "budget": {
            "topLevelRuns": 5,
            "runs": [3, 4, 5, 6, 7],
            "fitAccounting": (
                "Runs 5/6 share two train-fold GBMs. Run 7 refits one final "
                "enhanced GBM and the selected relational seed on "
                "train+validation; its residual target uses two internal "
                "cross-fold GBMs before the sealed sets are opened once."
            ),
            "throughRun": args.through_run,
        },
        "split": {
            "seed": 13,
            "granularity": "physicalKey; duplicates and all angles co-located",
            "train": len(split.train),
            "validation": len(split.validation),
            "test": len(split.test),
            "tensionBenchmark": len(split.tension_benchmark),
        },
        "holdCountFilter": hold_count_filter,
        "dataVersions": {
            "morphology": morphology_version,
            "morphologySource": morphology_source_version,
            "morphologyArtifactSha256": morphology_artifact_sha,
            "target": target_version,
            "coefficients": coefficient_version,
            "extractionSnapshot": extraction_snapshot,
            "benchmarkRejectionManifestSha256": (
                benchmark_rejection_manifest
            ),
            "rejectedBenchmarkPhysicalProblems": (
                rejected_benchmark_physical
            ),
        },
        "decisionRule": {
            "run4Kill": MORPHOLOGY_KILL_IMPROVEMENT,
            "run5And6Minimum": RELATIONAL_MIN_IMPROVEMENT,
            "run7KilterMinimum": FINAL_KILTER_MIN_IMPROVEMENT,
            "run7TensionMaxRegression": TENSION_MAX_REGRESSION,
        },
        "runs": {},
    }

    # Run 3: exact incumbent feature family.
    incumbent, incumbent_effects = data.fit_gbm(
        split.train,
        enhanced=False,
        seed=13,
    )
    incumbent_validation_prediction = data.predict_gbm(
        incumbent,
        incumbent_effects,
        split.validation,
        enhanced=False,
    )
    run3_metrics = board_metrics(
        incumbent_validation_prediction,
        split.validation,
        data.PRIMARY_BOARD,
    )
    _log_metrics("run3 incumbent-gbm kilter-validation", run3_metrics)
    results["runs"]["3"] = {
        "model": "incumbent GBM",
        "population": "Kilter validation",
        "metrics": rounded_metrics(run3_metrics),
    }

    # Run 4: same learner, enhanced label-free morphology/relation features.
    enhanced_gbm, enhanced_effects = data.fit_gbm(
        split.train,
        enhanced=True,
        seed=13,
    )
    enhanced_validation_prediction = data.predict_gbm(
        enhanced_gbm,
        enhanced_effects,
        split.validation,
        enhanced=True,
    )
    run4_metrics = board_metrics(
        enhanced_validation_prediction,
        split.validation,
        data.PRIMARY_BOARD,
    )
    morphology_improvement = run3_metrics.mae - run4_metrics.mae
    morphology_passed = morphology_improvement >= MORPHOLOGY_KILL_IMPROVEMENT
    _log_metrics("run4 enhanced-gbm kilter-validation", run4_metrics)
    print(
        f"[run4] improvement={morphology_improvement:.4f}; "
        f"required={MORPHOLOGY_KILL_IMPROVEMENT:.2f}; "
        f"{'continue' if morphology_passed else 'KILL'}"
    )
    results["runs"]["4"] = {
        "model": "same GBM + morphology + pairwise geometry",
        "population": "Kilter validation",
        "metrics": rounded_metrics(run4_metrics),
        "improvementOverRun3": round(morphology_improvement, 4),
        "passed": morphology_passed,
    }
    if args.through_run <= 4 or not morphology_passed:
        results["decision"] = {
            "status": (
                "stopped_after_run4"
                if args.through_run <= 4 and morphology_passed
                else "killed_after_run4"
            ),
            "ship": False,
            "reason": (
                "neural budget not opened"
                if morphology_passed
                else "same-feature GBM gained <0.05 Aurora steps"
            ),
        }
        return results

    relational_fits = []
    train_crossfit_prediction, train_row_effects = data.cross_fitted_gbm(
        split.train,
        seed=13,
    )
    for run_number, seed in zip((5, 6), RELATIONAL_SEEDS, strict=True):
        candidate = fit_relational_candidate(
            split.train,
            split.validation,
            train_crossfit_prediction,
            train_row_effects,
            enhanced_validation_prediction,
            enhanced_effects,
            run4_metrics,
            seed=seed,
            epochs=args.epochs,
        )
        relational_fits.append(candidate)
        passed = candidate.improvement >= RELATIONAL_MIN_IMPROVEMENT
        _log_metrics(
            f"run{run_number} relational seed={seed} kilter-validation",
            candidate.metrics,
        )
        print(
            f"[run{run_number}] improvement={candidate.improvement:.4f}; "
            f"required={RELATIONAL_MIN_IMPROVEMENT:.2f}; "
            f"{'pass' if passed else 'KILL'}"
        )
        results["runs"][str(run_number)] = {
            "model": "relational residual over cross-fitted enhanced GBM",
            "seed": seed,
            "population": "Kilter validation",
            "metrics": rounded_metrics(candidate.metrics),
            "improvementOverRun4": round(candidate.improvement, 4),
            "passed": passed,
            "lastTrainingLoss": round(candidate.losses[-1], 6),
            "similarity": neighbor_grade_agreement(
                split.validation,
                candidate.validation_embedding,
                seed=seed,
            ),
        }

    seeds_passed = all(
        fit.improvement >= RELATIONAL_MIN_IMPROVEMENT
        for fit in relational_fits
    )
    if args.through_run <= 6 or not seeds_passed:
        results["decision"] = {
            "status": (
                "stopped_after_run6"
                if args.through_run <= 6 and seeds_passed
                else "killed_after_run6"
            ),
            "ship": False,
            "reason": (
                "sealed test budget not opened"
                if seeds_passed
                else "both fixed relational seeds did not beat Run 4 by 0.05"
            ),
        }
        return results

    # Run 7: refit the selected seed on train+validation, then open each sealed
    # answer key once. Cross-fitting is internal to this top-level run and keeps
    # the residual target out-of-fold.
    selected = min(relational_fits, key=lambda fit: fit.metrics.mae)
    final_fit_rows = [*split.train, *split.validation]
    final_crossfit_prediction, final_row_effects = data.cross_fitted_gbm(
        final_fit_rows,
        seed=13,
    )
    final_gbm, final_effects = data.fit_gbm(
        final_fit_rows,
        enhanced=True,
        seed=13,
    )
    final_relational = train_relational_model(
        final_fit_rows,
        final_crossfit_prediction,
        final_row_effects,
        seed=selected.seed,
        epochs=args.epochs,
    )
    test_baseline = data.predict_gbm(
        final_gbm,
        final_effects,
        split.test,
        enhanced=True,
    )
    test_candidate, test_embedding = predict_relational(
        final_relational.model,
        split.test,
        final_effects,
        test_baseline,
        max_holds=final_relational.max_holds,
    )
    kilter_test_indices = np.asarray(
        [
            index
            for index, row in enumerate(split.test)
            if row.get("boardType") == data.PRIMARY_BOARD
            and float(row.get("ascents", 0)) >= 50
        ],
        dtype=np.int64,
    )
    kilter_test_rows = [split.test[int(index)] for index in kilter_test_indices]
    if not kilter_test_rows:
        raise ValueError("sealed Kilter >=50-ascent test population is empty")
    kilter_baseline_metrics = grade_metrics(
        test_baseline[kilter_test_indices],
        data.labels(kilter_test_rows),
    )
    kilter_candidate_metrics = grade_metrics(
        test_candidate[kilter_test_indices],
        data.labels(kilter_test_rows),
    )
    kilter_improvement = (
        kilter_baseline_metrics.mae - kilter_candidate_metrics.mae
    )

    benchmark_rows = [
        row
        for row in split.tension_benchmark
        if row.get("benchmarkDifficulty") is not None
    ]
    if not benchmark_rows:
        raise ValueError("sealed Tension benchmark population is empty")
    benchmark_baseline = data.predict_gbm(
        final_gbm,
        final_effects,
        benchmark_rows,
        enhanced=True,
    )
    benchmark_candidate, benchmark_embedding = predict_relational(
        final_relational.model,
        benchmark_rows,
        final_effects,
        benchmark_baseline,
        max_holds=final_relational.max_holds,
    )
    tension_baseline_metrics = board_metrics(
        benchmark_baseline,
        benchmark_rows,
        data.TENSION_BOARD,
        benchmark=True,
    )
    tension_candidate_metrics = board_metrics(
        benchmark_candidate,
        benchmark_rows,
        data.TENSION_BOARD,
        benchmark=True,
    )
    tension_regression = (
        tension_candidate_metrics.mae - tension_baseline_metrics.mae
    )
    final_passed = (
        kilter_improvement >= FINAL_KILTER_MIN_IMPROVEMENT
        and tension_regression <= TENSION_MAX_REGRESSION
    )
    _log_metrics("run7 enhanced-gbm kilter-test", kilter_baseline_metrics)
    _log_metrics("run7 relational kilter-test", kilter_candidate_metrics)
    _log_metrics(
        "run7 enhanced-gbm tension-benchmark",
        tension_baseline_metrics,
    )
    _log_metrics(
        "run7 relational tension-benchmark",
        tension_candidate_metrics,
    )
    results["runs"]["7"] = {
        "model": "selected relational seed refit on train+validation before sealed evaluation",
        "seed": selected.seed,
        "kilterTest": {
            "population": "Kilter physical problems with pooled ascents >=50",
            "baseline": rounded_metrics(kilter_baseline_metrics),
            "candidate": rounded_metrics(kilter_candidate_metrics),
            "improvement": round(kilter_improvement, 4),
            "required": FINAL_KILTER_MIN_IMPROVEMENT,
        },
        "tensionBenchmark": {
            "baseline": rounded_metrics(tension_baseline_metrics),
            "candidate": rounded_metrics(tension_candidate_metrics),
            "regression": round(tension_regression, 4),
            "maximum": TENSION_MAX_REGRESSION,
        },
        "similarity": {
            "kilterTest": neighbor_grade_agreement(
                kilter_test_rows,
                test_embedding[kilter_test_indices],
                seed=selected.seed,
            ),
            "tensionBenchmark": neighbor_grade_agreement(
                benchmark_rows,
                benchmark_embedding,
                seed=selected.seed,
                benchmark=True,
            ),
        },
        "lastTrainingLoss": round(final_relational.losses[-1], 6),
        "passed": final_passed,
    }
    calibration = {
        data.PRIMARY_BOARD: calibration_rmse(
            test_candidate[kilter_test_indices],
            kilter_test_rows,
        ),
        data.TENSION_BOARD: calibration_rmse(
            benchmark_candidate,
            benchmark_rows,
            benchmark=True,
        ),
    }
    results["contentSd"] = {
        board_type: {
            band: round(value, 4)
            for band, value in values.items()
        }
        for board_type, values in calibration.items()
    }
    results["decision"] = {
        "status": "eligible_for_shadow_gates" if final_passed else "no_ship",
        "ship": False,
        "modelPassedOfflineRule": final_passed,
        "reason": (
            "offline thresholds passed; run read-only shadow and unchanged publish-path gates"
            if final_passed
            else "sealed final thresholds failed"
        ),
    }

    if final_passed and args.score and args.predictions_out:
        all_score_rows = [
            row
            for path in args.score
            for row in legacy_dataset.load_rows(path)
        ]
        require_single_version(
            all_score_rows,
            "morphologyVersion",
            expected=morphology_version,
        )
        require_single_version(
            all_score_rows,
            "morphologySourceVersion",
            expected=morphology_source_version,
        )
        require_single_version(
            all_score_rows,
            "morphologyArtifactSha256",
            expected=morphology_artifact_sha,
        )
        score_rows, score_hold_count_filter = data.filter_supported_rows(
            all_score_rows,
            maximum_holds=40,
        )
        unsupported_keys = set(
            score_hold_count_filter["excludedPhysicalKeys"]
        )
        unsupported_score_rows = [
            row
            for row in all_score_rows
            if data.physical_key(row) in unsupported_keys
        ]
        score_baseline = data.predict_gbm(
            final_gbm,
            final_effects,
            score_rows,
            enhanced=True,
        )
        score_prediction, score_embedding = predict_relational(
            final_relational.model,
            score_rows,
            final_effects,
            score_baseline,
            max_holds=final_relational.max_holds,
        )
        written = export_predictions(
            args.predictions_out,
            score_rows,
            score_prediction,
            score_embedding,
            calibration,
            board_offsets(final_fit_rows),
            unsupported_rows=unsupported_score_rows,
        )
        results["predictionArtifact"] = {
            "path": args.predictions_out,
            "rows": written,
            "supportedRows": len(score_rows),
            "unsupportedRows": len(unsupported_score_rows),
            "holdCountFilter": score_hold_count_filter,
        }
        print(
            f"[run7] wrote {written} shadow predictions to "
            f"{args.predictions_out}"
        )
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data",
        action="append",
        help="Kilter/Tension Stage-2-target JSONL; repeat for multiple boards",
    )
    parser.add_argument(
        "--through-run",
        type=int,
        choices=SUPPORTED_THROUGH_RUNS,
        default=7,
        help="explicitly open only the requested top-level compute budget",
    )
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument(
        "--score",
        action="append",
        help="all-board score JSONL; repeat per board, used only after Run 7 passes",
    )
    parser.add_argument(
        "--predictions-out",
        default="artifacts/stage3-shadow-predictions.jsonl",
    )
    parser.add_argument(
        "--out",
        default="artifacts/stage3-results.json",
    )
    args = parser.parse_args()
    if not args.data:
        args.data = ["data/stage3-train.jsonl"]
    if args.epochs < 1:
        parser.error("--epochs must be positive")
    if args.score and args.through_run != 7:
        parser.error("--score requires --through-run=7")

    results = run_experiment(args)
    output_path = Path(args.out)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w") as handle:
        json.dump(results, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"[stage3] wrote {output_path}")

    decision = results.get("decision", {})
    if decision.get("status") in {"killed_after_run4", "killed_after_run6"}:
        raise SystemExit(2)
    if args.through_run == 7 and not decision.get("modelPassedOfflineRule", False):
        raise SystemExit(3)


if __name__ == "__main__":
    main()

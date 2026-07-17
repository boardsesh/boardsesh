"""Synthetic leakage and decision-contract tests for the Stage-3 runner."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np

import stage3_dataset as data
import stage3_experiment as experiment
from stage3_experiment import (
    board_offsets,
    calibration_rmse,
    content_sd_for,
    export_predictions,
    grade_metrics,
    neighbor_grade_agreement,
    run_experiment,
)


EXPERIMENT_VERSIONS = {
    "morphologyVersion": "hold-morphology-v1",
    "morphologySourceVersion": "source-v1",
    "morphologyArtifactSha256": "artifact-v1",
    "targetVersion": "climb2vec-frozen-stage2-v1",
    "coeffVersion": "coeff-v1",
    "extractionSnapshot": "100:100:",
    "benchmarkRejectionManifestSha256": "rejections-v1",
    "rejectedBenchmarkPhysicalProblems": 0,
}


def hold(pid=1, role="hand", morphology=None, hd=99.0, state=None):
    return {
        "pid": pid,
        "role": role,
        "nx": 0.25 + pid * 0.01,
        "ny": 0.4 + pid * 0.01,
        "edge": 0.2,
        "nbr": 0.1,
        "hd": hd,
        "fd": -hd,
        "pull": 45,
        "kb": False,
        "footSet": role == "foot",
        **({"state": state} if state is not None else {}),
        **({"morph": morphology} if morphology is not None else {}),
    }


def row(
    key,
    board="kilter",
    climb="climb",
    angle=40,
    label=20.0,
    benchmark=None,
):
    return {
        "boardType": board,
        "climbUuid": climb,
        "physicalKey": key,
        "angle": angle,
        "label": label,
        "localLabel": label + (1.0 if board == "kilter" else 0.0),
        "labelWeight": 5.0,
        "ascents": 20,
        "layoutId": 1,
        "fingerprint": key,
        "benchmarkDifficulty": benchmark,
        "holds": [hold(1), hold(2, "foot")],
    }


def experiment_rows(count=120):
    rows = []
    for index in range(count):
        morphology = [index / count] * data.MORPHOLOGY_DIM
        sample = row(
            f"problem-{index}",
            climb=f"climb-{index}",
            label=15 + 8 * morphology[0],
        )
        sample["holds"] = [
            hold(1, morphology=morphology),
            hold(2, "foot", morphology=morphology),
        ]
        sample.update(EXPERIMENT_VERSIONS)
        rows.append(sample)
    return rows


def experiment_args(input_path, through_run):
    return SimpleNamespace(
        data=[str(input_path)],
        through_run=through_run,
        epochs=1,
        score=None,
        predictions_out=None,
    )


class Stage3SplitTest(unittest.TestCase):
    def test_duplicates_and_angles_never_cross_splits(self):
        rows = [
            row("same", climb="a", angle=30),
            row("same", climb="b", angle=50),
            row("different", climb="c", angle=40),
        ]
        split = data.split_rows(rows)
        data.assert_disjoint_physical_splits(split)

        membership = {}
        for name in ("train", "validation", "test"):
            for split_row in getattr(split, name):
                membership.setdefault(split_row["physicalKey"], set()).add(name)
        self.assertEqual(membership["same"], {next(iter(membership["same"]))})

    def test_rejects_unsupported_compute_checkpoints_before_file_io(self):
        for through_run in (2, 3, 5, 8):
            with self.subTest(through_run=through_run):
                with self.assertRaisesRegex(
                    ValueError,
                    "through_run must be one of 4, 6, 7",
                ):
                    run_experiment(
                        SimpleNamespace(
                            data=["does-not-exist.jsonl"],
                            through_run=through_run,
                            epochs=1,
                            score=None,
                            predictions_out=None,
                        )
                    )

    def test_tension_benchmark_seals_every_angle_for_physical_problem(self):
        benchmark_row = row(
            "benchmark-problem",
            board="tension",
            climb="benchmark",
            angle=40,
            benchmark=21,
        )
        # Cold benchmark-only rows deliberately remain in the extract with zero
        # training weight so their answer key can be sealed before any fit.
        benchmark_row["labelWeight"] = 0
        rows = [
            benchmark_row,
            row(
                "benchmark-problem",
                board="tension",
                climb="benchmark-duplicate",
                angle=50,
                benchmark=None,
            ),
            row("ordinary", board="tension", climb="ordinary"),
        ]
        split = data.split_rows(rows)
        fitted_keys = {
            item["physicalKey"]
            for item in [*split.train, *split.validation, *split.test]
        }

        self.assertNotIn("benchmark-problem", fitted_keys)
        self.assertEqual(
            {item["physicalKey"] for item in split.tension_benchmark},
            {"benchmark-problem"},
        )
        self.assertIn(benchmark_row, split.tension_benchmark)

    def test_sealed_tension_key_collision_with_kilter_fails_loudly(self):
        rows = [
            row(
                "unexpected-shared-key",
                board="tension",
                climb="benchmark",
                benchmark=21,
            ),
            row(
                "unexpected-shared-key",
                board="kilter",
                climb="kilter-climb",
            ),
        ]

        with self.assertRaisesRegex(
            ValueError,
            "collision across boards: 1 key\\(s\\), 1 non-Tension row",
        ):
            data.split_rows(rows)


class Stage3FeatureTest(unittest.TestCase):
    def test_node_features_exclude_stored_behavioral_difficulty(self):
        first = hold(hd=10)
        second = hold(hd=999)

        np.testing.assert_array_equal(
            data.node_feature(first, hold_effect=0.25),
            data.node_feature(second, hold_effect=0.25),
        )
        self.assertEqual(len(data.node_feature(first, 0.25)), data.NODE_DIM)

    def test_hold_effect_lookup_uses_mirror_canonical_model_identity(self):
        sample = row("canonical", board="tension")
        canonical_hold = {
            **hold(100),
            "modelHoldId": 70,
        }
        effects = data.HoldEffects({("tension", 70, "hand"): 1.25})

        self.assertEqual(effects.for_hold(sample, canonical_hold), 1.25)

    def test_neural_state_one_hots_match_enhanced_gbm_state_counts(self):
        effects = data.HoldEffects({})
        holds = [
            hold(1, state="STARTING"),
            hold(2, state="HAND"),
            hold(3, state="FINISH"),
            hold(4, role="foot", state="FOOT"),
        ]
        sample = {**row("state-parity"), "holds": holds}
        neural_counts = np.stack(
            [
                data.node_feature(item, hold_effect=0.0)[
                    data.NODE_STATE_START : data.NODE_STATE_END
                ]
                for item in holds
            ]
        ).sum(axis=0)
        incumbent_width = len(data.incumbent_features(sample, effects))
        gbm_counts = data.enhanced_features(sample, effects)[
            incumbent_width : incumbent_width + data.HOLD_STATE_DIM
        ]

        np.testing.assert_array_equal(neural_counts, [1, 1, 1, 1])
        np.testing.assert_array_equal(gbm_counts, neural_counts)
        self.assertEqual(data.NODE_DIM, data.NODE_STATE_END + data.MORPHOLOGY_DIM + 3)

    def test_state_fallback_is_shared_by_neural_and_gbm_features(self):
        effects = data.HoldEffects({})
        sample = {
            **row("fallback-parity"),
            "holds": [hold(1, role="hand"), hold(2, role="foot")],
        }
        neural_counts = np.stack(
            [
                data.node_feature(item, hold_effect=0.0)[
                    data.NODE_STATE_START : data.NODE_STATE_END
                ]
                for item in sample["holds"]
            ]
        ).sum(axis=0)
        incumbent_width = len(data.incumbent_features(sample, effects))
        gbm_counts = data.enhanced_features(sample, effects)[
            incumbent_width : incumbent_width + data.HOLD_STATE_DIM
        ]

        np.testing.assert_array_equal(neural_counts, [0, 1, 0, 1])
        np.testing.assert_array_equal(gbm_counts, neural_counts)

    def test_morphology_changes_enhanced_but_not_incumbent_features(self):
        effects = data.HoldEffects({})
        base = row("shape")
        shaped = {
            **base,
            "holds": [
                hold(1, morphology=[0.1] * data.MORPHOLOGY_DIM),
                hold(2, "foot", morphology=[0.9] * data.MORPHOLOGY_DIM),
            ],
        }

        np.testing.assert_array_equal(
            data.incumbent_features(base, effects),
            data.incumbent_features(shaped, effects),
        )
        self.assertFalse(
            np.array_equal(
                data.enhanced_features(base, effects),
                data.enhanced_features(shaped, effects),
            )
        )

    def test_training_weights_preserve_frozen_stage2_ratios(self):
        rows = [
            {**row(str(index)), "labelWeight": weight}
            for index, weight in enumerate([1, 4, 9, 10_000])
        ]
        weights = data.training_weights(rows)

        self.assertAlmostEqual(float(weights.mean()), 1.0)
        self.assertGreater(float(weights.min()), 0)
        self.assertAlmostEqual(float(weights[-1] / weights[0]), 10_000)

    def test_fit_hold_effects_includes_starting_and_finish_as_hand_roles(self):
        easy = {
            **row("easy", label=10),
            "holds": [hold(101, state="STARTING")],
        }
        hard = {
            **row("hard", label=30),
            "holds": [hold(202, state="FINISH")],
        }

        effects = data.fit_hold_effects([easy, hard], alpha=1e-9)

        self.assertLess(effects.for_hold(easy, easy["holds"][0]), 0)
        self.assertGreater(effects.for_hold(hard, hard["holds"][0]), 0)
        self.assertEqual(
            set(effects.coefficients),
            {("kilter", 101, "hand"), ("kilter", 202, "hand")},
        )
        self.assertEqual(effects.for_hold(easy, hold(999)), 0.0)

    def test_cross_fitted_gbm_never_uses_held_out_problem_hold_effects(self):
        rows = []
        for index in range(16):
            key = f"crossfit-problem-{index}"
            angles = (40, 50) if index == 0 else (40,)
            for angle in angles:
                sample = row(
                    key,
                    climb=f"crossfit-climb-{index}-{angle}",
                    angle=angle,
                    label=12 + index,
                )
                sample["holds"] = [hold(1_000 + index)]
                rows.append(sample)

        predictions, row_effects = data.cross_fitted_gbm(rows, seed=13)

        self.assertEqual(predictions.shape, (len(rows),))
        self.assertTrue(np.isfinite(predictions).all())
        self.assertEqual(len(row_effects), len(rows))
        self.assertIs(row_effects[0], row_effects[1])
        for sample, effects in zip(rows, row_effects, strict=True):
            self.assertEqual(
                effects.for_hold(sample, sample["holds"][0]),
                0.0,
            )

    def test_duplicate_physical_angle_rows_are_rejected(self):
        duplicate = [row("same", climb="a"), row("same", climb="b")]
        with self.assertRaisesRegex(ValueError, "duplicate physicalKey\\+angle"):
            data.assert_unique_physical_angles(duplicate)

    def test_oversized_physical_problem_is_excluded_without_truncation(self):
        supported = row("supported")
        oversized = {
            **row("oversized"),
            "holds": [hold(index + 1) for index in range(41)],
        }
        oversized_sibling = {**row("oversized", angle=50)}

        filtered, report = data.filter_supported_rows(
            [supported, oversized, oversized_sibling]
        )

        self.assertEqual([item["physicalKey"] for item in filtered], ["supported"])
        self.assertEqual(report["excludedRows"], 2)
        self.assertEqual(report["excludedPhysicalProblems"], 1)


class Stage3ArtifactTest(unittest.TestCase):
    def test_grade_metrics_use_aurora_steps_without_rounding_mae(self):
        metrics = grade_metrics([20.0, 22.0], [21.0, 22.5])
        self.assertEqual(metrics.n, 2)
        self.assertEqual(metrics.mae, 0.75)

    def test_content_sd_is_calibrated_by_predicted_band(self):
        samples = [
            row("low", label=25),
            row("high", label=15),
        ]
        calibration = calibration_rmse(
            np.asarray([15.0, 25.0]),
            samples,
        )

        self.assertEqual(calibration["v0-2"], 10.0)
        self.assertEqual(calibration["v9+"], 10.0)

    def test_content_sd_never_exports_zero_precision(self):
        self.assertEqual(
            content_sd_for("kilter", 20, {"kilter": {"v3-5": 0.0}}),
            1e-4,
        )

    def test_moon_content_sd_uses_conservative_cross_board_calibration(self):
        calibration = {
            "kilter": {"v3-5": 1.1, "all": 1.2},
            "tension": {"v3-5": 1.4, "all": 1.5},
        }

        self.assertEqual(
            content_sd_for("moonboard", 20, calibration),
            1.4,
        )

    def test_export_converts_universal_kilter_prediction_back_to_local(self):
        source = row("artifact")
        source["difficultyAverage"] = 21.0
        calibration = {
            "kilter": {"v3-5": 1.2, "all": 1.4},
            "tension": {"all": 1.5},
        }
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "predictions.jsonl"
            export_predictions(
                str(output),
                [source],
                np.asarray([20.0]),
                np.ones((1, 64), dtype=np.float32),
                calibration,
                board_offsets([source]),
            )
            record = json.loads(output.read_text())

        self.assertEqual(record["universalPrior"], 20.0)
        self.assertEqual(record["contentPrior"], 21.0)
        self.assertEqual(record["contentSd"], 1.2)
        self.assertEqual(record["difficultyAverage"], 21.0)

    def test_export_pools_alias_predictions_by_physical_problem_and_angle(self):
        first = row("same", climb="alias-a")
        second = row("same", climb="alias-b")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "predictions.jsonl"
            export_predictions(
                str(output),
                [first, second],
                np.asarray([19.0, 21.0]),
                np.asarray([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32),
                {"kilter": {"all": 1.0}},
                board_offsets([first, second]),
            )
            records = [
                json.loads(line)
                for line in output.read_text().splitlines()
            ]

        self.assertEqual(
            {record["universalPrior"] for record in records},
            {20.0},
        )
        self.assertEqual(
            {tuple(record["embedding"]) for record in records},
            {(0.707107, 0.707107)},
        )
        self.assertEqual({record["supported"] for record in records}, {True})

    def test_export_zeroes_a_degenerate_pooled_alias_embedding(self):
        first = row("same", climb="alias-a")
        second = row("same", climb="alias-b")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "predictions.jsonl"
            export_predictions(
                str(output),
                [first, second],
                np.asarray([19.0, 21.0]),
                np.asarray(
                    [[1.0, 0.0], [-1.0 + 1e-10, 0.0]],
                    dtype=np.float64,
                ),
                {"kilter": {"all": 1.0}},
                board_offsets([first, second]),
            )
            records = [
                json.loads(line)
                for line in output.read_text().splitlines()
            ]

        self.assertEqual(
            {tuple(record["embedding"]) for record in records},
            {(0.0, 0.0)},
        )

    def test_similarity_diagnostic_stays_within_board_layout_and_angle(self):
        query = row("query", climb="query", label=10)
        valid_neighbor = row("valid", climb="valid", label=11)
        cross_board = row(
            "cross-board",
            board="tension",
            climb="cross-board",
            label=30,
        )
        cross_layout = {
            **row("cross-layout", climb="cross-layout", label=30),
            "layoutId": 2,
        }
        cross_angle = row(
            "cross-angle",
            climb="cross-angle",
            angle=50,
            label=30,
        )
        embeddings = np.asarray(
            [
                [1.0, 0.0],
                [0.0, 1.0],
                [1.0, 0.0],
                [1.0, 0.0],
                [1.0, 0.0],
            ],
            dtype=np.float32,
        )

        result = neighbor_grade_agreement(
            [
                query,
                valid_neighbor,
                cross_board,
                cross_layout,
                cross_angle,
            ],
            embeddings,
        )

        self.assertEqual(result["scope"], "boardType+layoutId+angle")
        self.assertEqual(result["n"], 2)
        self.assertEqual(result["neighborGradeMae"], 1.0)

    def test_tension_similarity_diagnostic_uses_benchmark_answers(self):
        first = row(
            "benchmark-a",
            board="tension",
            climb="benchmark-a",
            label=5,
            benchmark=20,
        )
        second = row(
            "benchmark-b",
            board="tension",
            climb="benchmark-b",
            label=5,
            benchmark=22,
        )

        result = neighbor_grade_agreement(
            [first, second],
            np.asarray([[1.0, 0.0], [0.9, 0.1]], dtype=np.float32),
            benchmark=True,
        )

        self.assertEqual(result["n"], 2)
        self.assertEqual(result["neighborGradeMae"], 2.0)

    def test_export_accounts_for_unsupported_score_rows_with_null_signals(self):
        supported = row("supported", climb="supported")
        unsupported = {
            **row("unsupported", climb="unsupported"),
            "holds": [hold(index + 1) for index in range(41)],
        }
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "predictions.jsonl"
            count = export_predictions(
                str(output),
                [supported],
                np.asarray([20.0]),
                np.ones((1, 64), dtype=np.float32),
                {"kilter": {"all": 1.0}},
                board_offsets([supported]),
                unsupported_rows=[unsupported],
            )
            records = [
                json.loads(line)
                for line in output.read_text().splitlines()
            ]

        self.assertEqual(count, 2)
        unsupported_record = next(
            record for record in records if not record["supported"]
        )
        self.assertIsNone(unsupported_record["contentPrior"])
        self.assertIsNone(unsupported_record["contentSd"])
        self.assertIsNone(unsupported_record["embedding"])

    def test_run3_and_run4_execute_without_opening_neural_budget(self):
        rows = experiment_rows()

        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "train.jsonl"
            input_path.write_text(
                "".join(json.dumps(sample) + "\n" for sample in rows)
            )
            result = run_experiment(experiment_args(input_path, 4))

        self.assertIn("3", result["runs"])
        self.assertIn("4", result["runs"])
        self.assertNotIn("5", result["runs"])

    def test_run4_kill_reports_morphology_failure(self):
        rows = experiment_rows()
        mock_effects = data.HoldEffects({})
        metrics = [
            experiment.GradeMetrics(10, 1.0, 1.2, 0.2, 0.8),
            experiment.GradeMetrics(10, 0.96, 1.1, 0.2, 0.8),
        ]

        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "train.jsonl"
            input_path.write_text(
                "".join(json.dumps(sample) + "\n" for sample in rows)
            )
            with (
                mock.patch.object(
                    data,
                    "fit_gbm",
                    return_value=(object(), mock_effects),
                ),
                mock.patch.object(
                    data,
                    "predict_gbm",
                    side_effect=lambda _model, _effects, score_rows, enhanced: np.zeros(
                        len(score_rows)
                    ),
                ),
                mock.patch.object(
                    experiment,
                    "board_metrics",
                    side_effect=metrics,
                ),
                mock.patch.object(
                    data,
                    "cross_fitted_gbm",
                ) as cross_fitted,
            ):
                result = run_experiment(experiment_args(input_path, 4))

        self.assertEqual(result["decision"]["status"], "killed_after_run4")
        self.assertEqual(
            result["decision"]["reason"],
            "morphology-enhanced GBM gained <0.05 Aurora steps over the incumbent-feature GBM",
        )
        cross_fitted.assert_not_called()

    def test_run6_kill_requires_both_relational_seeds(self):
        rows = experiment_rows()
        mock_effects = data.HoldEffects({})
        improvements = (0.06, 0.01)
        candidates = [
            SimpleNamespace(
                seed=seed,
                model=object(),
                max_holds=40,
                validation_prediction=np.zeros(1),
                validation_embedding=np.zeros((1, 64), dtype=np.float32),
                metrics=experiment.GradeMetrics(
                    10,
                    0.90 - improvement,
                    1.0,
                    0.2,
                    0.8,
                ),
                improvement=improvement,
                losses=[1.0],
            )
            for seed, improvement in zip(
                experiment.RELATIONAL_SEEDS,
                improvements,
                strict=True,
            )
        ]

        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "train.jsonl"
            input_path.write_text(
                "".join(json.dumps(sample) + "\n" for sample in rows)
            )
            with (
                mock.patch.object(
                    data,
                    "fit_gbm",
                    return_value=(object(), mock_effects),
                ),
                mock.patch.object(
                    data,
                    "predict_gbm",
                    side_effect=lambda _model, _effects, score_rows, enhanced: np.zeros(
                        len(score_rows)
                    ),
                ),
                mock.patch.object(
                    experiment,
                    "board_metrics",
                    side_effect=[
                        experiment.GradeMetrics(10, 1.0, 1.2, 0.2, 0.8),
                        experiment.GradeMetrics(10, 0.90, 1.1, 0.2, 0.8),
                    ],
                ),
                mock.patch.object(
                    data,
                    "cross_fitted_gbm",
                    side_effect=lambda train_rows, seed: (
                        np.zeros(len(train_rows)),
                        [mock_effects] * len(train_rows),
                    ),
                ),
                mock.patch.object(
                    experiment,
                    "fit_relational_candidate",
                    side_effect=candidates,
                ),
                mock.patch.object(
                    experiment,
                    "neighbor_grade_agreement",
                    return_value={"n": 0, "neighborGradeMae": None},
                ),
            ):
                result = run_experiment(experiment_args(input_path, 7))

        self.assertEqual(result["decision"]["status"], "killed_after_run6")
        self.assertEqual(
            result["decision"]["reason"],
            "at least one fixed relational seed did not beat Run 4 by 0.05",
        )
        self.assertTrue(result["runs"]["5"]["passed"])
        self.assertFalse(result["runs"]["6"]["passed"])

    def test_cli_exits_two_for_pre_registered_kill_decisions(self):
        for status in ("killed_after_run4", "killed_after_run6"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                output_path = Path(directory) / "results.json"
                with (
                    mock.patch.object(
                        experiment,
                        "run_experiment",
                        return_value={"decision": {"status": status}},
                    ),
                    mock.patch(
                        "sys.argv",
                        [
                            "stage3_experiment.py",
                            "--through-run",
                            "7",
                            "--out",
                            str(output_path),
                        ],
                    ),
                    self.assertRaises(SystemExit) as raised,
                ):
                    experiment.main()

                self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()

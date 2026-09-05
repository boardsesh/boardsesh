"""Fast synthetic tests for the Climb2Vec PyTorch models."""

import unittest

import torch
import torch.nn as nn

from model import (
    DeepSetsGrader,
    RelationalResidualGrader,
    weighted_huber_loss,
)
from training import ResidualTrainingConfig, fit_relational_residual


def synthetic_batch(node_dim=7):
    generator = torch.Generator().manual_seed(41)
    node_features = torch.randn(3, 5, node_dim, generator=generator)
    positions = torch.randn(3, 5, 2, generator=generator)
    mask = torch.tensor(
        [
            [1, 1, 1, 0, 0],
            [1, 1, 1, 1, 0],
            [1, 1, 1, 1, 1],
        ],
        dtype=torch.float32,
    )
    angle = torch.tensor([[-0.5], [0.0], [1.0]], dtype=torch.float32)
    baseline = torch.tensor([4.0, 6.5, 9.0], dtype=torch.float32)
    return node_features, positions, mask, angle, baseline


class DeepSetsCompatibilityTest(unittest.TestCase):
    def test_legacy_forward_contract_is_unchanged(self):
        model = DeepSetsGrader(
            n_pids=8,
            geom_dim=4,
            hidden=16,
            emb_dim=12,
        )
        node_features = torch.randn(2, 3, 4)
        placement_ids = torch.tensor([[1, 2, 0], [3, 4, 5]])
        mask = torch.tensor([[1, 1, 0], [1, 1, 1]], dtype=torch.float32)
        angle = torch.zeros(2, 1)

        grade, embedding = model(
            node_features,
            placement_ids,
            mask,
            angle,
        )

        self.assertEqual(grade.shape, (2,))
        self.assertEqual(embedding.shape, (2, 12))


class RelationalResidualGraderTest(unittest.TestCase):
    def test_default_architecture_and_output_contract(self):
        model = RelationalResidualGrader(node_dim=7, seed=13)
        batch = synthetic_batch()

        grade, embedding = model(*batch)

        self.assertEqual(len(model.layers), 2)
        self.assertTrue(
            all(layer.attention.n_heads == 4 for layer in model.layers)
        )
        self.assertEqual(grade.shape, (3,))
        self.assertEqual(embedding.shape, (3, 64))
        torch.testing.assert_close(
            torch.linalg.vector_norm(embedding, dim=-1),
            torch.ones(3),
        )
        self.assertFalse(
            any(isinstance(module, nn.Embedding) for module in model.modules())
        )

    def test_permutation_and_translation_invariance(self):
        model = RelationalResidualGrader(node_dim=7, seed=13)
        model.eval()
        node_features, positions, mask, angle, baseline = synthetic_batch()
        permutation = torch.tensor([2, 0, 4, 1, 3])

        with torch.no_grad():
            grade, embedding = model(
                node_features,
                positions,
                mask,
                angle,
                baseline,
            )
            permuted_grade, permuted_embedding = model(
                node_features[:, permutation],
                positions[:, permutation],
                mask[:, permutation],
                angle,
                baseline,
            )
            shifted_grade, shifted_embedding = model(
                node_features,
                positions + torch.tensor([23.0, -7.0]),
                mask,
                angle,
                baseline,
            )

        torch.testing.assert_close(grade, permuted_grade)
        torch.testing.assert_close(embedding, permuted_embedding)
        torch.testing.assert_close(grade, shifted_grade)
        torch.testing.assert_close(embedding, shifted_embedding)

    def test_padding_cannot_change_prediction_or_embedding(self):
        model = RelationalResidualGrader(node_dim=7, seed=13)
        model.eval()
        node_features, positions, mask, angle, baseline = synthetic_batch()
        changed_features = node_features.clone()
        changed_positions = positions.clone()
        padding = ~mask.to(dtype=torch.bool)
        changed_features[padding] = float("nan")
        changed_positions[padding] = float("nan")

        with torch.no_grad():
            grade, embedding = model(
                node_features,
                positions,
                mask,
                angle,
                baseline,
            )
            changed_grade, changed_embedding = model(
                changed_features,
                changed_positions,
                mask,
                angle,
                baseline,
            )

        torch.testing.assert_close(grade, changed_grade)
        torch.testing.assert_close(embedding, changed_embedding)

    def test_relative_geometry_changes_the_embedding(self):
        model = RelationalResidualGrader(node_dim=7, seed=13)
        model.eval()
        node_features, positions, mask, angle, baseline = synthetic_batch()
        changed_positions = positions.clone()
        changed_positions[:, 1, 0] += 2.0

        with torch.no_grad():
            _, embedding = model(
                node_features,
                positions,
                mask,
                angle,
                baseline,
            )
            _, changed_embedding = model(
                node_features,
                changed_positions,
                mask,
                angle,
                baseline,
            )

        self.assertGreater(
            float(torch.linalg.vector_norm(embedding - changed_embedding)),
            1e-4,
        )

    def test_baseline_is_a_frozen_skip_connection(self):
        model = RelationalResidualGrader(node_dim=7, seed=13)
        node_features, positions, mask, angle, baseline = synthetic_batch()
        baseline.requires_grad_(True)

        grade, _ = model(
            node_features,
            positions,
            mask,
            angle,
            baseline,
        )
        grade.sum().backward()

        self.assertIsNone(baseline.grad)
        with torch.no_grad():
            residual = model.predict_residual(
                node_features,
                positions,
                mask,
                angle,
            )
        torch.testing.assert_close(grade.detach(), baseline.detach() + residual)

    def test_seeded_initialization_is_reproducible(self):
        first = RelationalResidualGrader(node_dim=7, seed=19)
        second = RelationalResidualGrader(node_dim=7, seed=19)
        different = RelationalResidualGrader(node_dim=7, seed=20)

        for first_parameter, second_parameter in zip(
            first.parameters(),
            second.parameters(),
        ):
            torch.testing.assert_close(first_parameter, second_parameter)
        self.assertTrue(
            any(
                not torch.equal(first_parameter, different_parameter)
                for first_parameter, different_parameter in zip(
                    first.parameters(),
                    different.parameters(),
                )
            )
        )

    def test_empty_climb_is_rejected(self):
        model = RelationalResidualGrader(node_dim=7, seed=13)
        node_features, positions, mask, angle, baseline = synthetic_batch()
        mask[0] = 0

        with self.assertRaisesRegex(ValueError, "at least one unmasked hold"):
            model(node_features, positions, mask, angle, baseline)

    def test_non_finite_active_inputs_and_baseline_are_rejected(self):
        model = RelationalResidualGrader(node_dim=7, seed=13)
        node_features, positions, mask, angle, baseline = synthetic_batch()
        node_features[0, 0, 0] = float("nan")
        with self.assertRaisesRegex(ValueError, "node_features must be finite"):
            model(node_features, positions, mask, angle, baseline)

        node_features, positions, mask, angle, baseline = synthetic_batch()
        baseline[0] = float("inf")
        with self.assertRaisesRegex(ValueError, "baseline_prediction must be finite"):
            model(node_features, positions, mask, angle, baseline)


class ResidualTrainingTest(unittest.TestCase):
    def test_weighted_huber_uses_one_step_transition(self):
        prediction = torch.tensor([0.5, 2.0])
        target = torch.zeros(2)
        weight = torch.tensor([1.0, 3.0])

        loss = weighted_huber_loss(
            prediction,
            target,
            weight=weight,
            delta=1.0,
        )

        self.assertAlmostEqual(float(loss), 1.15625)

    def test_synthetic_residual_fit_reduces_loss(self):
        generator = torch.Generator().manual_seed(7)
        node_features = torch.randn(12, 4, 5, generator=generator)
        positions = torch.randn(12, 4, 2, generator=generator)
        mask = torch.ones(12, 4)
        angle = torch.linspace(-1.0, 1.0, 12).unsqueeze(-1)
        baseline = torch.linspace(3.0, 8.0, 12)
        residual = node_features[:, :, 0].mean(dim=1) + 0.5 * angle.squeeze(-1)
        target = baseline + residual
        model = RelationalResidualGrader(
            node_dim=5,
            width=16,
            emb_dim=16,
            n_heads=4,
            seed=23,
        )

        losses = fit_relational_residual(
            model,
            node_features,
            positions,
            mask,
            angle,
            baseline,
            target,
            config=ResidualTrainingConfig(
                epochs=20,
                batch_size=12,
                learning_rate=1e-2,
                seed=23,
            ),
        )

        self.assertLess(losses[-1], losses[0] * 0.5)

    def test_seed_reproduces_training_order_and_weights(self):
        generator = torch.Generator().manual_seed(9)
        node_features = torch.randn(6, 3, 4, generator=generator)
        positions = torch.randn(6, 3, 2, generator=generator)
        mask = torch.ones(6, 3)
        angle = torch.zeros(6, 1)
        baseline = torch.linspace(2.0, 5.0, 6)
        target = baseline + node_features[:, :, 0].mean(dim=1)
        first = RelationalResidualGrader(
            node_dim=4,
            width=16,
            emb_dim=16,
            seed=31,
        )
        second = RelationalResidualGrader(
            node_dim=4,
            width=16,
            emb_dim=16,
            seed=31,
        )
        config = ResidualTrainingConfig(
            epochs=3,
            batch_size=2,
            seed=31,
        )

        first_losses = fit_relational_residual(
            first,
            node_features,
            positions,
            mask,
            angle,
            baseline,
            target,
            config=config,
        )
        second_losses = fit_relational_residual(
            second,
            node_features,
            positions,
            mask,
            angle,
            baseline,
            target,
            config=config,
        )

        self.assertEqual(first_losses, second_losses)
        for first_parameter, second_parameter in zip(
            first.parameters(),
            second.parameters(),
        ):
            torch.testing.assert_close(first_parameter, second_parameter)


if __name__ == "__main__":
    unittest.main()

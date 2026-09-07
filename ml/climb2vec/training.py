"""Training helpers for the relation-aware Climb2Vec residual model."""

import random
from dataclasses import dataclass

import numpy as np
import torch

from model import weighted_huber_loss


@dataclass(frozen=True)
class ResidualTrainingConfig:
    """Small, explicit CPU-training budget for one candidate fit."""

    epochs: int = 30
    batch_size: int = 512
    learning_rate: float = 1e-3
    weight_decay: float = 1e-5
    huber_delta: float = 1.0
    seed: int = 13


def set_deterministic_seed(seed):
    """Seed Python, NumPy, and PyTorch for a reproducible CPU run."""
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True, warn_only=True)


def fit_relational_residual(
    model,
    node_features,
    positions,
    mask,
    angle,
    baseline_prediction,
    target,
    weight=None,
    config=ResidualTrainingConfig(),
):
    """Fit a residual head over fixed, precomputed GBM predictions.

    The baseline is detached once before training, so this helper cannot backprop
    through or refit the GBM. It returns one weighted mean loss per epoch.
    """
    if config.epochs < 1:
        raise ValueError("epochs must be positive")
    if config.batch_size < 1:
        raise ValueError("batch_size must be positive")
    if config.learning_rate <= 0:
        raise ValueError("learning_rate must be positive")
    if node_features.shape[0] == 0:
        raise ValueError("training data must not be empty")
    if not torch.all(mask.to(dtype=torch.bool).any(dim=1)):
        raise ValueError("every training climb must contain at least one hold")

    sample_count = node_features.shape[0]
    expected_vectors = {
        "positions": positions,
        "mask": mask,
        "angle": angle,
        "baseline_prediction": baseline_prediction,
        "target": target,
    }
    if weight is not None:
        expected_vectors["weight"] = weight
    for name, tensor in expected_vectors.items():
        if tensor.shape[0] != sample_count:
            raise ValueError(
                f"{name} has {tensor.shape[0]} rows; expected {sample_count}"
            )
    finite_inputs = {
        "node_features": node_features[mask.to(dtype=torch.bool)],
        "positions": positions[mask.to(dtype=torch.bool)],
        "angle": angle,
        "baseline_prediction": baseline_prediction,
        "target": target,
    }
    if weight is not None:
        finite_inputs["weight"] = weight
    for name, tensor in finite_inputs.items():
        if not torch.isfinite(tensor).all():
            raise ValueError(f"{name} must be finite on active rows")
    if weight is not None and torch.any(weight < 0):
        raise ValueError("weight must be non-negative")

    set_deterministic_seed(config.seed)
    device = next(model.parameters()).device
    features_device = node_features.to(device=device)
    positions_device = positions.to(device=device)
    mask_device = mask.to(device=device)
    angle_device = angle.to(device=device)
    baseline_device = baseline_prediction.detach().to(device=device)
    target_device = target.to(device=device)
    weight_device = weight.to(device=device) if weight is not None else None

    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=config.learning_rate,
        weight_decay=config.weight_decay,
    )
    order_generator = torch.Generator(device="cpu")
    order_generator.manual_seed(config.seed)
    epoch_losses = []

    for _ in range(config.epochs):
        model.train()
        order = torch.randperm(sample_count, generator=order_generator)
        epoch_loss_total = 0.0
        epoch_weight_total = 0.0

        for start in range(0, sample_count, config.batch_size):
            cpu_indices = order[start : start + config.batch_size]
            indices = cpu_indices.to(device=device)
            batch_mask = mask_device.index_select(0, indices)
            active_columns = batch_mask.to(dtype=torch.bool).any(dim=0)
            last_active_column = int(
                active_columns.nonzero(as_tuple=False)[-1].item()
            )
            hold_limit = last_active_column + 1
            batch_weight = (
                weight_device.index_select(0, indices)
                if weight_device is not None
                else None
            )
            prediction, _ = model(
                features_device.index_select(0, indices)[:, :hold_limit],
                positions_device.index_select(0, indices)[:, :hold_limit],
                batch_mask[:, :hold_limit],
                angle_device.index_select(0, indices),
                baseline_device.index_select(0, indices),
            )
            batch_target = target_device.index_select(0, indices)
            loss = weighted_huber_loss(
                prediction,
                batch_target,
                weight=batch_weight,
                delta=config.huber_delta,
            )

            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            if batch_weight is None:
                batch_total_weight = float(indices.numel())
            else:
                batch_total_weight = float(batch_weight.sum().detach().cpu())
            epoch_loss_total += float(loss.detach().cpu()) * batch_total_weight
            epoch_weight_total += batch_total_weight

        epoch_losses.append(epoch_loss_total / epoch_weight_total)

    return epoch_losses

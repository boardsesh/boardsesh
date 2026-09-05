"""PyTorch models for the Climb2Vec offline pipeline.

``DeepSetsGrader`` is the legacy Phase-1 model. ``RelationalResidualGrader`` is the
placement-identity-free Stage-3 candidate: it uses pairwise hold geometry to predict
only the residual over a frozen GBM baseline. Its returned 64-dimensional embedding
is L2-normalized for cosine similarity.
"""

import torch
import torch.nn as nn
import torch.nn.functional as functional


class DeepSetsGrader(nn.Module):
    def __init__(self, n_pids, geom_dim=10, pid_dim=16, hidden=64, emb_dim=64):
        super().__init__()
        # padding_idx=0 → UNK/padded holds contribute a zero embedding.
        self.pid_emb = nn.Embedding(n_pids + 1, pid_dim, padding_idx=0)
        self.phi = nn.Sequential(
            nn.Linear(geom_dim + pid_dim, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
        )
        # Pool = [mean, max, sum]. Sum matters because grade is roughly ADDITIVE in
        # per-hold difficulty (more hard holds → harder climb); mean/max alone can't
        # recover the count, so a sum term lets the encoder match the linear/GBM models.
        self.psi = nn.Sequential(
            nn.Linear(hidden * 3 + 1, emb_dim),
            nn.ReLU(),
        )
        self.head = nn.Linear(emb_dim, 1)

    def embed(self, node_feats, pids, mask, angle):
        # node_feats [B,H,geom]; pids [B,H]; mask [B,H] in {0,1}; angle [B,1]
        pid_vec = self.pid_emb(pids)
        nodes = torch.cat([node_feats, pid_vec], dim=-1)
        hidden = self.phi(nodes)
        mask3 = mask.unsqueeze(-1)
        hidden = hidden * mask3
        summed = hidden.sum(dim=1)
        count = mask3.sum(dim=1).clamp(min=1.0)
        mean_pool = summed / count
        masked = hidden.masked_fill(mask3 == 0, float("-inf"))
        max_pool = torch.nan_to_num(masked.max(dim=1).values, neginf=0.0)
        pooled = torch.cat([mean_pool, max_pool, summed, angle], dim=-1)
        return self.psi(pooled)

    def forward(self, node_feats, pids, mask, angle):
        embedding = self.embed(node_feats, pids, mask, angle)
        grade = self.head(embedding).squeeze(-1)
        return grade, embedding


class RelationAwareSelfAttention(nn.Module):
    """Multi-head self-attention with a learned relative-geometry bias.

    The attention bias sees only key-minus-query ``dx``, ``dy``, and Euclidean
    distance. Absolute location remains available through ``node_features`` when
    desired, while the relational part is translation invariant.
    """

    def __init__(
        self,
        width=64,
        n_heads=4,
        relation_hidden=32,
        dropout=0.0,
    ):
        super().__init__()
        if n_heads < 1:
            raise ValueError("n_heads must be positive")
        if width % n_heads != 0:
            raise ValueError(f"width ({width}) must be divisible by n_heads ({n_heads})")
        if relation_hidden < 1:
            raise ValueError("relation_hidden must be positive")

        self.width = width
        self.n_heads = n_heads
        self.head_dim = width // n_heads
        self.qkv = nn.Linear(width, width * 3)
        self.relative_bias = nn.Sequential(
            nn.Linear(3, relation_hidden),
            nn.SiLU(),
            nn.Linear(relation_hidden, n_heads, bias=False),
        )
        self.output = nn.Linear(width, width)
        self.attention_dropout = dropout
        self.output_dropout = nn.Dropout(dropout)

    def forward(self, hidden, positions, mask):
        batch_size, hold_count, width = hidden.shape
        if width != self.width:
            raise ValueError(f"expected hidden width {self.width}, got {width}")
        if positions.shape != (batch_size, hold_count, 2):
            raise ValueError(
                "positions must have shape "
                f"[batch, holds, 2], got {tuple(positions.shape)}"
            )
        if mask.shape != (batch_size, hold_count):
            raise ValueError(
                f"mask must have shape [batch, holds], got {tuple(mask.shape)}"
            )

        queries, keys, values = self.qkv(hidden).chunk(3, dim=-1)

        def split_heads(tensor):
            return tensor.reshape(
                batch_size,
                hold_count,
                self.n_heads,
                self.head_dim,
            ).transpose(1, 2)

        queries = split_heads(queries)
        keys = split_heads(keys)
        values = split_heads(values)

        # [B, query, key, 2]. Signed offsets retain direction; distance supplies a
        # rotation-insensitive reach term.
        relative_xy = positions.unsqueeze(1) - positions.unsqueeze(2)
        relative_distance = torch.linalg.vector_norm(
            relative_xy,
            dim=-1,
            keepdim=True,
        )
        relative_features = torch.cat(
            [relative_xy, relative_distance],
            dim=-1,
        )
        relation_bias = self.relative_bias(relative_features).permute(0, 3, 1, 2)

        valid_holds = mask.to(dtype=torch.bool)
        valid_keys = valid_holds[:, None, None, :]
        minimum = torch.finfo(relation_bias.dtype).min
        attention_bias = relation_bias.masked_fill(~valid_keys, minimum)
        attended = functional.scaled_dot_product_attention(
            queries,
            keys,
            values,
            attn_mask=attention_bias,
            dropout_p=self.attention_dropout if self.training else 0.0,
        )
        attended = attended.transpose(1, 2).reshape(batch_size, hold_count, width)
        attended = self.output_dropout(self.output(attended))
        return attended * valid_holds.unsqueeze(-1).to(dtype=attended.dtype)


class RelationalEncoderLayer(nn.Module):
    """Pre-norm relation-aware transformer layer for a padded hold set."""

    def __init__(
        self,
        width=64,
        n_heads=4,
        relation_hidden=32,
        dropout=0.0,
        feedforward_multiplier=2,
    ):
        super().__init__()
        self.attention_norm = nn.LayerNorm(width)
        self.attention = RelationAwareSelfAttention(
            width=width,
            n_heads=n_heads,
            relation_hidden=relation_hidden,
            dropout=dropout,
        )
        self.feedforward_norm = nn.LayerNorm(width)
        self.feedforward = nn.Sequential(
            nn.Linear(width, width * feedforward_multiplier),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(width * feedforward_multiplier, width),
            nn.Dropout(dropout),
        )

    def forward(self, hidden, positions, mask):
        mask3 = mask.to(dtype=torch.bool).unsqueeze(-1).to(dtype=hidden.dtype)
        hidden = hidden + self.attention(
            self.attention_norm(hidden),
            positions,
            mask,
        )
        hidden = hidden * mask3
        hidden = hidden + self.feedforward(self.feedforward_norm(hidden))
        return hidden * mask3


class RelationalResidualGrader(nn.Module):
    """Compact relation-aware encoder with a frozen-baseline residual head.

    ``node_features`` contains geometry, role, morphology, and any leakage-safe
    behavioural feature chosen by the evaluator. There is deliberately no board or
    placement-ID argument and no identity embedding.
    """

    def __init__(
        self,
        node_dim,
        width=64,
        emb_dim=64,
        n_heads=4,
        n_layers=2,
        relation_hidden=32,
        dropout=0.0,
        seed=None,
    ):
        super().__init__()
        if node_dim < 1:
            raise ValueError("node_dim must be positive")
        if width < 1:
            raise ValueError("width must be positive")
        if emb_dim < 1:
            raise ValueError("emb_dim must be positive")
        if n_layers < 1:
            raise ValueError("n_layers must be positive")

        self.node_dim = node_dim
        self.width = width
        self.emb_dim = emb_dim
        self.n_layers = n_layers

        if seed is None:
            self._build_modules(
                n_heads=n_heads,
                relation_hidden=relation_hidden,
                dropout=dropout,
            )
        else:
            # Seeded construction is reproducible without perturbing the caller's
            # global RNG stream.
            with torch.random.fork_rng(devices=[]):
                torch.manual_seed(seed)
                self._build_modules(
                    n_heads=n_heads,
                    relation_hidden=relation_hidden,
                    dropout=dropout,
                )

    def _build_modules(self, n_heads, relation_hidden, dropout):
        self.input_projection = nn.Sequential(
            nn.Linear(self.node_dim, self.width),
            nn.LayerNorm(self.width),
            nn.GELU(),
        )
        self.layers = nn.ModuleList(
            [
                RelationalEncoderLayer(
                    width=self.width,
                    n_heads=n_heads,
                    relation_hidden=relation_hidden,
                    dropout=dropout,
                )
                for _ in range(self.n_layers)
            ]
        )
        # Mean and max capture typical/crux holds. log1p(count) keeps cardinality
        # available without the scale instability of an unbounded sum pool.
        pooled_dim = self.width * 2 + 2
        self.embedding_projection = nn.Sequential(
            nn.Linear(pooled_dim, self.emb_dim),
            nn.GELU(),
            nn.LayerNorm(self.emb_dim),
        )
        self.residual_head = nn.Linear(self.emb_dim, 1)

    def _validate_inputs(self, node_features, positions, mask, angle):
        if node_features.ndim != 3:
            raise ValueError(
                "node_features must have shape [batch, holds, features]"
            )
        batch_size, hold_count, node_dim = node_features.shape
        if node_dim != self.node_dim:
            raise ValueError(
                f"expected node feature width {self.node_dim}, got {node_dim}"
            )
        if positions.shape != (batch_size, hold_count, 2):
            raise ValueError(
                "positions must have shape "
                f"[batch, holds, 2], got {tuple(positions.shape)}"
            )
        if mask.shape != (batch_size, hold_count):
            raise ValueError(
                f"mask must have shape [batch, holds], got {tuple(mask.shape)}"
            )
        if angle.shape != (batch_size, 1):
            raise ValueError(
                f"angle must have shape [batch, 1], got {tuple(angle.shape)}"
            )
        if not torch.all(mask.to(dtype=torch.bool).any(dim=1)):
            raise ValueError("every climb must contain at least one unmasked hold")
        valid_holds = mask.to(dtype=torch.bool)
        if not torch.isfinite(node_features[valid_holds]).all():
            raise ValueError("unmasked node_features must be finite")
        if not torch.isfinite(positions[valid_holds]).all():
            raise ValueError("unmasked positions must be finite")
        if not torch.isfinite(angle).all():
            raise ValueError("angle must be finite")

    def _raw_embedding(self, node_features, positions, mask, angle):
        self._validate_inputs(node_features, positions, mask, angle)
        valid_holds = mask.to(dtype=torch.bool)
        mask3 = valid_holds.unsqueeze(-1).to(dtype=node_features.dtype)
        safe_features = torch.where(
            valid_holds.unsqueeze(-1),
            node_features,
            torch.zeros_like(node_features),
        )
        safe_positions = torch.where(
            valid_holds.unsqueeze(-1),
            positions,
            torch.zeros_like(positions),
        )
        hidden = self.input_projection(safe_features) * mask3
        for layer in self.layers:
            hidden = layer(hidden, safe_positions, valid_holds)

        summed = hidden.sum(dim=1)
        hold_count = mask3.sum(dim=1).clamp(min=1.0)
        mean_pool = summed / hold_count
        minimum = torch.finfo(hidden.dtype).min
        masked = hidden.masked_fill(mask3 == 0, minimum)
        max_pool = masked.max(dim=1).values
        log_count = torch.log1p(hold_count)
        pooled = torch.cat(
            [
                mean_pool,
                max_pool,
                log_count,
                angle.to(dtype=hidden.dtype, device=hidden.device),
            ],
            dim=-1,
        )
        return self.embedding_projection(pooled)

    def embed(self, node_features, positions, mask, angle):
        """Return the L2-normalized 64-dimensional similarity embedding."""
        raw_embedding = self._raw_embedding(
            node_features,
            positions,
            mask,
            angle,
        )
        return functional.normalize(raw_embedding, p=2, dim=-1, eps=1e-8)

    def predict_residual(self, node_features, positions, mask, angle):
        raw_embedding = self._raw_embedding(
            node_features,
            positions,
            mask,
            angle,
        )
        return self.residual_head(raw_embedding).squeeze(-1)

    def forward(
        self,
        node_features,
        positions,
        mask,
        angle,
        baseline_prediction,
    ):
        """Predict grade as ``stop_gradient(GBM) + learned residual``."""
        raw_embedding = self._raw_embedding(
            node_features,
            positions,
            mask,
            angle,
        )
        residual = self.residual_head(raw_embedding).squeeze(-1)
        baseline = baseline_prediction.detach()
        if baseline.ndim == 2 and baseline.shape[-1] == 1:
            baseline = baseline.squeeze(-1)
        if baseline.shape != residual.shape:
            raise ValueError(
                "baseline_prediction must have shape "
                f"{tuple(residual.shape)} or {tuple(residual.shape) + (1,)}, "
                f"got {tuple(baseline_prediction.shape)}"
            )
        if not torch.isfinite(baseline).all():
            raise ValueError("baseline_prediction must be finite")
        grade = baseline.to(dtype=residual.dtype, device=residual.device) + residual
        embedding = functional.normalize(raw_embedding, p=2, dim=-1, eps=1e-8)
        return grade, embedding


def weighted_huber_loss(
    prediction,
    target,
    weight=None,
    delta=1.0,
):
    """Huber loss with an Aurora-step transition and normalized sample weights."""
    if delta <= 0:
        raise ValueError("delta must be positive")
    if not torch.isfinite(prediction).all() or not torch.isfinite(target).all():
        raise ValueError("prediction and target must be finite")
    losses = functional.huber_loss(
        prediction,
        target,
        reduction="none",
        delta=delta,
    )
    if weight is None:
        return losses.mean()
    if weight.shape != losses.shape:
        raise ValueError(
            f"weight must have shape {tuple(losses.shape)}, got {tuple(weight.shape)}"
        )
    if torch.any(weight < 0):
        raise ValueError("weight must be non-negative")
    if not torch.isfinite(weight).all():
        raise ValueError("weight must be finite")
    total_weight = weight.sum()
    if not bool(total_weight > 0):
        raise ValueError("weight must contain at least one positive value")
    return (losses * weight).sum() / total_weight

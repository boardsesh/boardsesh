"""The Climb2Vec Deep Sets encoder (PyTorch).

A climb is a SET of holds. Each hold node = [label-free geometry features] concat
[a learned per-placement embedding]. Nodes go through a shared MLP (phi), are
masked-mean/max pooled into a permutation-invariant climb vector, concatenated with
the (scaled) wall angle, and mapped by psi to the penultimate EMBEDDING that feeds a
linear grade head. The learned pid embedding is the nonlinear, low-dimensional analog
of the ridge's per-hold coefficient — and the penultimate embedding is what powers
climb similarity + style downstream.
"""

import torch
import torch.nn as nn


class DeepSetsGrader(nn.Module):
    def __init__(self, n_pids, geom_dim=10, pid_dim=16, hidden=64, emb_dim=64, wide_deep=False):
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
        self.wide_deep = wide_deep
        if wide_deep:
            # Wide additive term: the sum over the climb's holds of the train-fit
            # per-hold ridge coefficient (already carried as the LAST node feature),
            # scaled by ONE learned weight. This injects the additive structure the
            # GBM exploits (grade ≈ Σ hold difficulty) without adding per-hold
            # parameters that overfit; the Deep Sets branch learns only the residual.
            self.wide_weight = nn.Parameter(torch.ones(1))

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
        if self.wide_deep:
            # node_feats[..., -1] is the per-hold train-fit ridge coefficient.
            additive = self.wide_weight * (node_feats[:, :, -1] * mask).sum(dim=1)
            grade = grade + additive
        return grade, embedding

"""Climb2Vec Phase-1 offline evaluation.

Answers the two Phase-1 questions on real Kilter data, leakage-free (hold effects
are learned on the TRAIN split only, evaluated on held-out climbs):

  1. Does hold geometry/identity predict grade? — ridge, GBM, and the Deep Sets
     encoder, scored by exact / within-±1 / MAE against the crowd grade.
  2. Does the learned embedding capture difficulty structure? — duplicate-holdset
     retrieval (sanity) + nearest-neighbour grade agreement vs a geometry baseline.

Run: python evaluate.py --data data/kilter-train.jsonl [--epochs 25] [--out artifacts/results.json]
"""

import argparse
import json
import os
import random

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge

import dataset as ds

SEED = 13


def metrics(pred, y):
    pred = np.asarray(pred, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    return {
        "n": int(len(y)),
        "mae": round(float(np.mean(np.abs(pred - y))), 4),
        "exact": round(float(np.mean(np.round(pred) == np.round(y))), 4),
        "within1": round(float(np.mean(np.abs(np.round(pred) - np.round(y)) <= 1)), 4),
    }


def index_map(pids):
    return {pid: i for i, pid in enumerate(sorted(pids))}


def build_incidence(rows, hand_index, foot_index, label_field="label"):
    n_hand, n_foot = len(hand_index), len(foot_index)
    ncol = n_hand + n_foot + 1  # + angle column
    data, indices, indptr = [], [], [0]
    labels, weights = [], []
    for row in rows:
        cols = {}
        for hold in row["holds"]:
            if hold["role"] == "hand":
                j = hand_index.get(hold["pid"])
                if j is not None:
                    cols[j] = 1.0
            else:
                j = foot_index.get(hold["pid"])
                if j is not None:
                    cols[n_hand + j] = 1.0
        cols[ncol - 1] = (row["angle"] - 40) / 10.0
        for col, val in cols.items():
            indices.append(col)
            data.append(val)
        indptr.append(len(indices))
        labels.append(row[label_field])
        weights.append(ds.weight(row))
    matrix = csr_matrix((data, indices, indptr), shape=(len(rows), ncol))
    return matrix, np.array(labels), np.array(weights)


def agg_features(rows, hand_coef, foot_coef):
    out = []
    for row in rows:
        hand_vals = [hand_coef[h["pid"]] for h in row["holds"] if h["role"] == "hand" and h["pid"] in hand_coef]
        foot_vals = [foot_coef[h["pid"]] for h in row["holds"] if h["role"] == "foot" and h["pid"] in foot_coef]

        def agg(vals):
            arr = np.array(vals) if vals else np.array([0.0])
            return [float(arr.sum()), float(arr.mean()), float(arr.max()), float(arr.min())]

        geom = ds.climb_geom_vector(row)
        row_feats = list(geom) + [(row["angle"] - 40) / 10.0] + agg(hand_vals) + agg(foot_vals)
        out.append(row_feats)
    return np.array(out, dtype=np.float64)


# Node feature width = geometry (GEOM_DIM) + the train-fit per-hold ridge coefficient
# (leak-free: learned on TRAIN only, applied by role; 0 for holds unseen in train).
NODE_DIM = ds.GEOM_DIM + 1


def build_tensors(rows, pid_vocab, max_holds, hand_coef, foot_coef, label_field="label"):
    n = len(rows)
    node = np.zeros((n, max_holds, NODE_DIM), dtype=np.float32)
    pids = np.zeros((n, max_holds), dtype=np.int64)
    mask = np.zeros((n, max_holds), dtype=np.float32)
    angle = np.zeros((n, 1), dtype=np.float32)
    labels = np.zeros(n, dtype=np.float32)
    weights = np.zeros(n, dtype=np.float32)
    for i, row in enumerate(rows):
        for k, hold in enumerate(row["holds"][:max_holds]):
            node[i, k, : ds.GEOM_DIM] = ds.hold_geom(hold)
            coef = hand_coef if hold["role"] == "hand" else foot_coef
            node[i, k, ds.GEOM_DIM] = coef.get(hold["pid"], 0.0)
            pids[i, k] = pid_vocab.get(hold["pid"], 0)
            mask[i, k] = 1.0
        angle[i, 0] = (row["angle"] - 40) / 20.0
        labels[i] = row[label_field]
        weights[i] = ds.weight(row)
    return node, pids, mask, angle, labels, weights


def run_deepsets(train, val, pid_vocab, epochs, hand_coef, foot_coef, train_label="label", eval_label="label", wide_deep=False):
    import torch
    from model import DeepSetsGrader

    torch.manual_seed(0)
    max_holds = min(40, max(len(r["holds"]) for r in train + val))
    ntr = build_tensors(train, pid_vocab, max_holds, hand_coef, foot_coef, label_field=train_label)
    nva = build_tensors(val, pid_vocab, max_holds, hand_coef, foot_coef, label_field=eval_label)
    y_mean = float(ntr[4].mean())

    def tensors(pack):
        node, pids, mask, angle, labels, weights = pack
        return (
            torch.from_numpy(node),
            torch.from_numpy(pids),
            torch.from_numpy(mask),
            torch.from_numpy(angle),
            torch.from_numpy(labels - y_mean),
            torch.from_numpy(weights / weights.mean()),
        )

    tr = tensors(ntr)
    va = tensors(nva)
    model = DeepSetsGrader(n_pids=len(pid_vocab), geom_dim=NODE_DIM, wide_deep=wide_deep)
    opt = torch.optim.Adam(model.parameters(), lr=1e-3, weight_decay=1e-5)

    n = tr[0].shape[0]
    batch = 512
    for _ in range(epochs):
        model.train()
        order = torch.randperm(n)
        for start in range(0, n, batch):
            idx = order[start : start + batch]
            pred, _ = model(tr[0][idx], tr[1][idx], tr[2][idx], tr[3][idx])
            loss = (((pred - tr[4][idx]) ** 2) * tr[5][idx]).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()

    model.eval()
    with torch.no_grad():
        pred_val, _ = model(va[0], va[1], va[2], va[3])
        pred_val = pred_val.numpy() + y_mean
    return model, metrics(pred_val, nva[4]), max_holds, y_mean


def embed_unique(model, rows, pid_vocab, max_holds, hand_coef, foot_coef):
    """Embed each unique climb at a canonical angle (40°) → [N, emb_dim]."""
    import torch

    node, pids, mask, angle, _, _ = build_tensors(
        [{**r, "angle": 40} for r in rows], pid_vocab, max_holds, hand_coef, foot_coef
    )
    with torch.no_grad():
        vecs = model.embed(
            torch.from_numpy(node), torch.from_numpy(pids), torch.from_numpy(mask), torch.from_numpy(angle)
        ).numpy()
    return vecs


def cosine_normalize(vectors):
    return vectors / (np.linalg.norm(vectors, axis=1, keepdims=True) + 1e-9)


def duplicate_retrieval(unique_rows, vectors):
    groups = {}
    for i, row in enumerate(unique_rows):
        groups.setdefault(ds.holdset_key(row), []).append(i)
    dup_groups = {k: v for k, v in groups.items() if len(v) >= 2}
    dup_idx = [i for members in dup_groups.values() for i in members]
    if not dup_idx:
        return {"duplicate_climbs": 0}
    member_of = {i: k for k, members in dup_groups.items() for i in members}
    unit = cosine_normalize(vectors)
    hit1 = hit5 = 0
    for q in dup_idx:
        sims = unit @ unit[q]
        sims[q] = -1e9
        order = np.argsort(-sims)
        if member_of.get(int(order[0])) == member_of[q]:
            hit1 += 1
        if any(member_of.get(int(i)) == member_of[q] for i in order[:5]):
            hit5 += 1
    return {
        "duplicate_climbs": len(dup_idx),
        "duplicate_groups": len(dup_groups),
        "recall@1": round(hit1 / len(dup_idx), 4),
        "recall@5": round(hit5 / len(dup_idx), 4),
    }


def neighbor_grade_agreement(unique_rows, vectors, climb_grade):
    """Mean |Δgrade| between a climb and its nearest NON-identical neighbour."""
    unit = cosine_normalize(vectors)
    keys = [ds.holdset_key(r) for r in unique_rows]
    grades = np.array([climb_grade[r["climbUuid"]] for r in unique_rows])
    deltas = []
    rng = random.Random(SEED)
    sample = list(range(len(unique_rows)))
    if len(sample) > 3000:
        sample = rng.sample(sample, 3000)
    for q in sample:
        sims = unit @ unit[q]
        order = np.argsort(-sims)
        neighbor = next((int(i) for i in order if i != q and keys[int(i)] != keys[q]), None)
        if neighbor is not None:
            deltas.append(abs(grades[q] - grades[neighbor]))
    random_delta = float(np.mean(np.abs(grades[rng.sample(range(len(grades)), min(3000, len(grades)))] - np.mean(grades))))
    return {
        "neighbor_grade_mae": round(float(np.mean(deltas)), 4) if deltas else None,
        "random_grade_mae": round(random_delta, 4),
        "sampled": len(deltas),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="data/kilter-train.jsonl")
    parser.add_argument("--epochs", type=int, default=25)
    parser.add_argument("--out", default="artifacts/results.json")
    args = parser.parse_args()

    random.seed(SEED)
    np.random.seed(SEED)

    rows = ds.load_rows(args.data)
    train, val = ds.group_split(rows, seed=SEED)
    print(f"[eval] {len(rows)} obs · train {len(train)} / val {len(val)} (grouped by climb)")

    # --- Ridge over hold-incidence (the de-confounded linear content model) ---
    hand_index = index_map({h["pid"] for r in train for h in r["holds"] if h["role"] == "hand"})
    foot_index = index_map({h["pid"] for r in train for h in r["holds"] if h["role"] == "foot"})
    x_tr, y_tr, w_tr = build_incidence(train, hand_index, foot_index)
    x_va, y_va, _ = build_incidence(val, hand_index, foot_index)
    ridge = Ridge(alpha=5.0)
    ridge.fit(x_tr, y_tr, sample_weight=w_tr)
    ridge_metrics = metrics(ridge.predict(x_va), y_va)
    print(f"[eval] ridge   {ridge_metrics}")

    # --- GBM over compact aggregate features (train-fit hold coefs + geometry) ---
    n_hand = len(hand_index)
    hand_coef = {pid: float(ridge.coef_[j]) for pid, j in hand_index.items()}
    foot_coef = {pid: float(ridge.coef_[n_hand + j]) for pid, j in foot_index.items()}
    gbm = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, max_depth=6, random_state=SEED)
    gbm.fit(agg_features(train, hand_coef, foot_coef), y_tr, sample_weight=w_tr)
    gbm_metrics = metrics(gbm.predict(agg_features(val, hand_coef, foot_coef)), y_va)
    print(f"[eval] gbm     {gbm_metrics}")

    # --- Deep Sets encoder (Climb2Vec) ---
    # Two Deep Sets configs on the crowd-mean label: the plain encoder, and the
    # wide&deep variant that adds the summed per-hold ridge coefficient as a
    # single-weight additive term (matches the additive structure the GBM exploits).
    pid_vocab = ds.build_pid_vocab(train)
    _, plain_metrics, _, _ = run_deepsets(train, val, pid_vocab, args.epochs, hand_coef, foot_coef)
    print(f"[eval] deepsets (plain)     {plain_metrics}")
    model, deep_metrics, max_holds, _ = run_deepsets(
        train, val, pid_vocab, args.epochs, hand_coef, foot_coef, wide_deep=True
    )
    print(f"[eval] deepsets (wide&deep) {deep_metrics}")

    # --- Similarity: duplicate retrieval + neighbour grade agreement (val climbs) ---
    val_unique = ds.unique_climbs(val)
    climb_grade = {}
    grade_bucket = {}
    for row in val:
        grade_bucket.setdefault(row["climbUuid"], []).append(row["label"])
    for uuid, labels in grade_bucket.items():
        climb_grade[uuid] = float(np.mean(labels))

    geom_vectors = np.array([ds.climb_geom_vector(r) for r in val_unique], dtype=np.float32)
    deep_vectors = embed_unique(model, val_unique, pid_vocab, max_holds, hand_coef, foot_coef)

    similarity = {
        "geometry_vector": {
            "duplicates": duplicate_retrieval(val_unique, geom_vectors),
            "grade_agreement": neighbor_grade_agreement(val_unique, geom_vectors, climb_grade),
        },
        "deepsets_embedding": {
            "duplicates": duplicate_retrieval(val_unique, deep_vectors),
            "grade_agreement": neighbor_grade_agreement(val_unique, deep_vectors, climb_grade),
        },
    }
    print(f"[eval] similarity {json.dumps(similarity)}")

    results = {
        "data": args.data,
        "n_obs": len(rows),
        "n_train": len(train),
        "n_val": len(val),
        "grade": {
            "ridge": ridge_metrics,
            "gbm": gbm_metrics,
            "deepsets_plain": plain_metrics,
            "deepsets_wide_deep": deep_metrics,
        },
        "similarity": similarity,
        "reference": {"moonboardrnn_exact": 0.467, "moonboardrnn_within1": 0.847},
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as handle:
        json.dump(results, handle, indent=2)
    print(f"[eval] wrote {args.out}")


if __name__ == "__main__":
    main()

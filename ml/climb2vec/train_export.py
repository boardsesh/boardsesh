"""Train the final Climb2Vec model on graded climbs and score `content_prior` +
embedding for EVERY (climb, angle) in the score extract. Output is a JSONL the TS
loader (`packages/db/scripts/load-content-model.ts`) upserts into
board_climb_embeddings — the only thing Python ever writes.

Run (from ml/climb2vec/):
  # 1. training matrix (graded) + score matrix (all climb-angles):
  node --import tsx ../../packages/db/scripts/extract-training-matrix.ts --board=kilter --out=ml/climb2vec/data/kilter-train.jsonl
  node --import tsx ../../packages/db/scripts/extract-training-matrix.ts --board=kilter --score --out=ml/climb2vec/data/kilter-score.jsonl
  # 2. train + score:
  python train_export.py --train data/kilter-train.jsonl --score data/kilter-score.jsonl --out data/kilter-content.jsonl
"""

import argparse
import json
import random

import numpy as np
import torch
from sklearn.linear_model import Ridge

import dataset as ds
from evaluate import NODE_DIM, SEED, build_incidence, build_tensors, index_map
from model import DeepSetsGrader

MODEL_VERSION = "climb2vec-v2-widedeep"


def train_deepsets(train, val, pid_vocab, hand_coef, foot_coef, epochs):
    torch.manual_seed(0)
    max_holds = 40
    node, pids, mask, angle, labels, weights = build_tensors(train, pid_vocab, max_holds, hand_coef, foot_coef)
    y_mean = float(labels.mean())
    tn, tp, tm, ta = (torch.from_numpy(node), torch.from_numpy(pids), torch.from_numpy(mask), torch.from_numpy(angle))
    ty = torch.from_numpy(labels - y_mean)
    tw = torch.from_numpy(weights / weights.mean())

    model = DeepSetsGrader(n_pids=len(pid_vocab), geom_dim=NODE_DIM, wide_deep=True)
    opt = torch.optim.Adam(model.parameters(), lr=1e-3, weight_decay=1e-5)
    n = tn.shape[0]
    batch = 512
    for _ in range(epochs):
        model.train()
        order = torch.randperm(n)
        for start in range(0, n, batch):
            idx = order[start : start + batch]
            pred, _ = model(tn[idx], tp[idx], tm[idx], ta[idx])
            loss = (((pred - ty[idx]) ** 2) * tw[idx]).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()

    val_rmse = None
    if val:
        vn, vp, vm, va, vy, _ = build_tensors(val, pid_vocab, max_holds, hand_coef, foot_coef)
        model.eval()
        with torch.no_grad():
            pred_val, _ = model(torch.from_numpy(vn), torch.from_numpy(vp), torch.from_numpy(vm), torch.from_numpy(va))
        val_rmse = float(np.sqrt(np.mean((pred_val.numpy() + y_mean - vy) ** 2)))
    return model, y_mean, val_rmse, max_holds


def score(model, y_mean, max_holds, pid_vocab, hand_coef, foot_coef, rows, out_path, content_sd, batch=4096):
    written = 0
    with open(out_path, "w") as handle:
        for start in range(0, len(rows), batch):
            chunk = rows[start : start + batch]
            node, pids, mask, angle, _, _ = build_tensors(chunk, pid_vocab, max_holds, hand_coef, foot_coef)
            model.eval()
            with torch.no_grad():
                grade, emb = model(
                    torch.from_numpy(node), torch.from_numpy(pids), torch.from_numpy(mask), torch.from_numpy(angle)
                )
            grade = grade.numpy() + y_mean
            emb = emb.numpy()
            emb = emb / (np.linalg.norm(emb, axis=1, keepdims=True) + 1e-9)
            for i, row in enumerate(chunk):
                record = {
                    "climbUuid": row["climbUuid"],
                    "angle": row["angle"],
                    "layoutId": row.get("layoutId"),
                    "contentPrior": round(float(grade[i]), 4),
                    "contentSd": round(content_sd, 4),
                    "embedding": [round(float(x), 5) for x in emb[i]],
                }
                handle.write(json.dumps(record) + "\n")
                written += 1
    return written


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", default="data/kilter-train.jsonl")
    parser.add_argument("--score", default="data/kilter-score.jsonl")
    parser.add_argument("--out", default="data/kilter-content.jsonl")
    parser.add_argument("--epochs", type=int, default=30)
    args = parser.parse_args()

    random.seed(SEED)
    np.random.seed(SEED)

    train_rows = ds.load_rows(args.train)
    score_rows = ds.load_rows(args.score)
    print(f"[export] train {len(train_rows)} · score {len(score_rows)}")

    hand_index = index_map({h["pid"] for r in train_rows for h in r["holds"] if h["role"] == "hand"})
    foot_index = index_map({h["pid"] for r in train_rows for h in r["holds"] if h["role"] == "foot"})
    x_tr, y_tr, w_tr = build_incidence(train_rows, hand_index, foot_index)
    ridge = Ridge(alpha=5.0).fit(x_tr, y_tr, sample_weight=w_tr)
    n_hand = len(hand_index)
    hand_coef = {pid: float(ridge.coef_[j]) for pid, j in hand_index.items()}
    foot_coef = {pid: float(ridge.coef_[n_hand + j]) for pid, j in foot_index.items()}
    pid_vocab = ds.build_pid_vocab(train_rows)

    # content_sd = held-out RMSE from a quick split; the final model trains on all.
    sub_tr, sub_va = ds.group_split(train_rows, val_frac=0.1, seed=SEED)
    _, _, val_rmse, _ = train_deepsets(sub_tr, sub_va, pid_vocab, hand_coef, foot_coef, args.epochs)
    content_sd = val_rmse if val_rmse is not None else 1.5
    print(f"[export] held-out RMSE (content_sd) = {content_sd:.4f}")

    model, y_mean, _, max_holds = train_deepsets(train_rows, None, pid_vocab, hand_coef, foot_coef, args.epochs)
    written = score(model, y_mean, max_holds, pid_vocab, hand_coef, foot_coef, score_rows, args.out, content_sd)
    print(f"[export] wrote {written} scored (climb,angle) rows → {args.out} (model {MODEL_VERSION})")


if __name__ == "__main__":
    main()

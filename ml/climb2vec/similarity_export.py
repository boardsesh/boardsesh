"""Compute content-similarity neighbours from the Climb2Vec embeddings.

Cosine top-K is computed within each (boardType, layoutId, angle) group.
Different boards and layouts are incompatible coordinate spaces, while different
angles are different problems. numpy BLAS makes the matrix multiplication fast
enough for the largest groups, where a pure-JS loop stalls.

Run (from ml/climb2vec/):
  python similarity_export.py --content data/kilter-content.jsonl \
    --out data/kilter-similar.jsonl --k 25
"""

import argparse
import json
import os
from collections import defaultdict
from pathlib import Path

import numpy as np

KNOWN_BOARD_TYPES = ("kilter", "tension", "moonboard")
DEFAULT_LEGACY_MODEL_VERSION = "climb2vec-v1"


def load_content(path):
    rows = []
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def infer_legacy_board_type(path):
    """Infer the board for an old single-board artifact from its file name."""
    filename = Path(path).name.lower()
    return next(
        (
            board_type
            for board_type in KNOWN_BOARD_TYPES
            if filename.startswith(f"{board_type}-")
        ),
        None,
    )


def prepare_similarity_rows(
    rows,
    legacy_board_type=None,
    legacy_model_version=DEFAULT_LEGACY_MODEL_VERSION,
):
    """Skip unsupported rows, validate embeddings, and attach board identity.

    Stage-3 artifacts carry boardType on every row. Older production artifacts
    were one file per board and omitted it; those remain supported only when all
    usable rows are untyped and the caller supplies one legacy board identity.
    """
    supported_rows = []
    typed_count = 0
    untyped_count = 0
    for row in rows:
        if row.get("supported") is False:
            continue
        embedding = row.get("embedding")
        try:
            embedding_array = np.asarray(embedding, dtype=np.float32)
        except (TypeError, ValueError) as error:
            raise ValueError(
                f"supported row {row.get('climbUuid')} has an invalid embedding"
            ) from error
        if (
            embedding_array.ndim != 1
            or embedding_array.size == 0
            or not np.isfinite(embedding_array).all()
        ):
            raise ValueError(
                f"supported row {row.get('climbUuid')} must have a finite one-dimensional embedding"
            )
        board_type = row.get("boardType")
        if isinstance(board_type, str) and board_type.strip():
            typed_count += 1
        else:
            untyped_count += 1
        supported_rows.append(row)

    if typed_count and untyped_count:
        raise ValueError(
            "similarity input cannot mix board-typed and legacy untyped rows"
        )
    if untyped_count:
        if not legacy_board_type:
            raise ValueError(
                "legacy similarity input requires --legacy-board or a board-specific file name"
            )
        supported_rows = [
            {
                **row,
                "boardType": legacy_board_type,
                "modelVersion": legacy_model_version,
            }
            for row in supported_rows
        ]
    else:
        for row in supported_rows:
            model_version = row.get("modelVersion")
            if not isinstance(model_version, str) or not model_version.strip():
                raise ValueError(
                    f"typed similarity row {row.get('climbUuid')} is missing modelVersion"
                )
    model_versions = {
        row["modelVersion"]
        for row in supported_rows
    }
    if len(model_versions) > 1:
        raise ValueError(
            "similarity input cannot mix model versions: "
            + ", ".join(sorted(model_versions))
        )
    return supported_rows


def physical_key(row):
    return row.get("physicalKey") or f"uuid:{row['climbUuid']}"


def similarity_group_key(row):
    """Return the production-safe coordinate-space boundary for a row."""
    board_type = row.get("boardType")
    if not isinstance(board_type, str) or not board_type.strip():
        raise ValueError(
            f"similarity row {row.get('climbUuid')} is missing boardType"
        )
    if row.get("layoutId") is None:
        raise ValueError(
            f"similarity row {row.get('climbUuid')} is missing layoutId"
        )
    if row.get("angle") is None:
        raise ValueError(
            f"similarity row {row.get('climbUuid')} is missing angle"
        )
    return (board_type, row["layoutId"], row["angle"])


def rank_neighbor_indices(similarities, excluded_indices, k):
    """Return top-k finite neighbors after excluding a physical problem."""
    scores = np.asarray(similarities, dtype=np.float32).copy()
    scores[np.asarray(list(excluded_indices), dtype=np.int64)] = -np.inf
    valid_count = int(np.isfinite(scores).sum())
    neighbor_count = min(k, valid_count)
    if neighbor_count <= 0:
        return np.empty(0, dtype=np.int64)
    partition = np.argpartition(-scores, kth=neighbor_count - 1)[:neighbor_count]
    return partition[np.argsort(-scores[partition])]


def similarity_records(rows, k, block=2000):
    """Yield production-like neighbors within one board/layout/angle space."""
    groups = defaultdict(list)
    for index, row in enumerate(rows):
        groups[similarity_group_key(row)].append(index)

    for (board_type, layout_id, angle), members in groups.items():
        member_count = len(members)
        if member_count < 2:
            continue
        matrix = np.array(
            [rows[index]["embedding"] for index in members],
            dtype=np.float32,
        )
        matrix = matrix / np.clip(
            np.linalg.norm(matrix, axis=1, keepdims=True),
            1e-9,
            None,
        )
        physical_members = defaultdict(list)
        for local_index, member_index in enumerate(members):
            physical_members[physical_key(rows[member_index])].append(
                local_index
            )
        for start in range(0, member_count, block):
            similarities = matrix[start : start + block] @ matrix.T
            for block_index in range(similarities.shape[0]):
                query_local_index = start + block_index
                query_row = rows[members[query_local_index]]
                order = rank_neighbor_indices(
                    similarities[block_index],
                    physical_members[physical_key(query_row)],
                    k,
                )
                neighbours = [
                    [
                        rows[members[neighbor_index]]["climbUuid"],
                        round(
                            float(
                                similarities[
                                    block_index,
                                    neighbor_index,
                                ]
                            ),
                            5,
                        ),
                    ]
                    for neighbor_index in order
                ]
                yield {
                    "boardType": board_type,
                    "climbUuid": query_row["climbUuid"],
                    "layoutId": layout_id,
                    "angle": angle,
                    "neighbours": neighbours,
                    "modelVersion": query_row["modelVersion"],
                }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--content", default="data/kilter-content.jsonl")
    parser.add_argument("--out", default="data/kilter-similar.jsonl")
    parser.add_argument("--k", type=int, default=25)
    parser.add_argument(
        "--legacy-board",
        default=os.environ.get("BOARD"),
        help="board identity for an old single-board artifact without boardType",
    )
    parser.add_argument(
        "--legacy-model",
        default=os.environ.get(
            "MODEL_VERSION",
            DEFAULT_LEGACY_MODEL_VERSION,
        ),
        help="model identity for an old single-board artifact without modelVersion",
    )
    args = parser.parse_args()

    legacy_board_type = args.legacy_board or infer_legacy_board_type(
        args.content
    )
    rows = prepare_similarity_rows(
        load_content(args.content),
        legacy_board_type=legacy_board_type,
        legacy_model_version=args.legacy_model,
    )
    print(f"[similarity] {len(rows)} embedded climb-angles")

    written = 0
    with open(args.out, "w") as out:
        for record in similarity_records(rows, args.k):
            out.write(json.dumps(record) + "\n")
            written += 1
    print(f"[similarity] wrote {written} climb neighbour lists → {args.out}")


if __name__ == "__main__":
    main()

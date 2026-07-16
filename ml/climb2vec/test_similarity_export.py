"""Focused safety tests for the content-similarity export."""

import unittest

import numpy as np

from similarity_export import (
    infer_legacy_board_type,
    physical_key,
    prepare_similarity_rows,
    rank_neighbor_indices,
    similarity_group_key,
    similarity_records,
)


class SimilarityExportTest(unittest.TestCase):
    def test_excludes_every_alias_of_the_query_physical_problem(self):
        similarities = np.asarray([1.0, 0.99, 0.8, 0.7])
        order = rank_neighbor_indices(similarities, [0, 1], k=3)

        np.testing.assert_array_equal(order, [2, 3])

    def test_legacy_rows_fall_back_to_uuid_identity(self):
        self.assertEqual(
            physical_key({"climbUuid": "abc"}),
            "uuid:abc",
        )
        self.assertEqual(
            physical_key({"climbUuid": "alias", "physicalKey": "same"}),
            "same",
        )

    def test_mixed_boards_and_layouts_never_share_neighbors(self):
        rows = prepare_similarity_rows(
            [
                self.row("kilter-a", "kilter", 1, [1.0, 0.0]),
                self.row("kilter-b", "kilter", 1, [0.9, 0.1]),
                self.row("tension-a", "tension", 1, [1.0, 0.0]),
                self.row("tension-b", "tension", 1, [0.9, 0.1]),
                self.row("layout-two-a", "kilter", 2, [1.0, 0.0]),
                self.row("layout-two-b", "kilter", 2, [0.9, 0.1]),
            ]
        )

        records = {
            record["climbUuid"]: record
            for record in similarity_records(rows, k=1, block=2)
        }

        self.assertEqual(
            records["kilter-a"],
            {
                "boardType": "kilter",
                "climbUuid": "kilter-a",
                "layoutId": 1,
                "angle": 40,
                "neighbours": [["kilter-b", 0.99388]],
                "modelVersion": "test-model",
            },
        )
        self.assertEqual(
            records["tension-a"]["neighbours"],
            [["tension-b", 0.99388]],
        )
        self.assertEqual(
            records["layout-two-a"]["neighbours"],
            [["layout-two-b", 0.99388]],
        )

    def test_group_key_contains_board_layout_and_angle(self):
        row = self.row("query", "kilter", 12, [1.0, 0.0])
        row["angle"] = 50

        self.assertEqual(
            similarity_group_key(row),
            ("kilter", 12, 50),
        )

    def test_unsupported_rows_are_skipped_before_embedding_validation(self):
        rows = prepare_similarity_rows(
            [
                {
                    "boardType": "moonboard",
                    "climbUuid": "unsupported",
                    "supported": False,
                    "embedding": None,
                },
                self.row("supported", "moonboard", 1, [1.0, 0.0]),
            ]
        )

        self.assertEqual([row["climbUuid"] for row in rows], ["supported"])

    def test_supported_rows_require_a_finite_embedding(self):
        for embedding in (None, [], [1.0, float("nan")]):
            with self.subTest(embedding=embedding):
                with self.assertRaisesRegex(
                    ValueError,
                    "must have a finite one-dimensional embedding|invalid embedding",
                ):
                    prepare_similarity_rows(
                        [
                            {
                                "boardType": "kilter",
                                "climbUuid": "bad",
                                "supported": True,
                                "embedding": embedding,
                            }
                        ]
                    )

    def test_mixed_typed_and_legacy_rows_are_rejected(self):
        with self.assertRaisesRegex(
            ValueError,
            "cannot mix board-typed and legacy untyped rows",
        ):
            prepare_similarity_rows(
                [
                    self.row("typed", "kilter", 1, [1.0, 0.0]),
                    {
                        **self.row("legacy", "kilter", 1, [0.0, 1.0]),
                        "boardType": None,
                    },
                ],
                legacy_board_type="kilter",
            )

    def test_legacy_single_board_artifact_gets_explicit_board_type(self):
        rows = prepare_similarity_rows(
            [
                {
                    **self.row("legacy", "kilter", 1, [1.0, 0.0]),
                    "boardType": None,
                }
            ],
            legacy_board_type="kilter",
        )

        self.assertEqual(rows[0]["boardType"], "kilter")
        self.assertEqual(rows[0]["modelVersion"], "climb2vec-v1")
        self.assertEqual(
            infer_legacy_board_type("data/tension-content.jsonl"),
            "tension",
        )

    def test_typed_rows_require_one_model_version(self):
        missing_model = self.row(
            "missing-model",
            "kilter",
            1,
            [1.0, 0.0],
        )
        del missing_model["modelVersion"]
        with self.assertRaisesRegex(ValueError, "missing modelVersion"):
            prepare_similarity_rows([missing_model])

        with self.assertRaisesRegex(ValueError, "cannot mix model versions"):
            prepare_similarity_rows(
                [
                    self.row("first", "kilter", 1, [1.0, 0.0]),
                    {
                        **self.row("second", "tension", 1, [0.0, 1.0]),
                        "modelVersion": "different-model",
                    },
                ]
            )

    @staticmethod
    def row(climb_uuid, board_type, layout_id, embedding):
        return {
            "boardType": board_type,
            "climbUuid": climb_uuid,
            "layoutId": layout_id,
            "angle": 40,
            "physicalKey": f"physical:{climb_uuid}",
            "embedding": embedding,
            "modelVersion": "test-model",
        }


if __name__ == "__main__":
    unittest.main()

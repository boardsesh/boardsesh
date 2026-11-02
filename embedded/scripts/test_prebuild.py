#!/usr/bin/env python3
"""
Unit tests for prebuild.py hash-based caching logic.

Run with: python3 embedded/scripts/test_prebuild.py
"""

import hashlib
import runpy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def get_combined_hash(schema_path: Path, types_path: Path) -> str:
    """Get combined hash of schema and types files by hashing contents directly."""
    hasher = hashlib.sha256()
    for filepath in [schema_path, types_path]:
        if filepath.exists():
            with open(filepath, "rb") as f:
                hasher.update(f.read())
    return hasher.hexdigest()


class TestHashFunctions(unittest.TestCase):
    """Test hash calculation functions."""

    def test_get_combined_hash(self):
        """Should combine hashes of both files."""
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.ts') as f:
            f.write("schema content")
            schema_path = Path(f.name)

        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.ts') as f:
            f.write("types content")
            types_path = Path(f.name)

        try:
            combined = get_combined_hash(schema_path, types_path)
            self.assertEqual(len(combined), 64)  # SHA256 hex length

            # Should change when schema changes
            with open(schema_path, 'w') as f:
                f.write("modified schema")
            new_combined = get_combined_hash(schema_path, types_path)
            self.assertNotEqual(combined, new_combined)
        finally:
            schema_path.unlink()
            types_path.unlink()

    def test_combined_hash_with_missing_file(self):
        """Should handle missing files gracefully."""
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.ts') as f:
            f.write("schema content")
            schema_path = Path(f.name)

        try:
            # One file missing
            combined = get_combined_hash(schema_path, Path("/nonexistent.ts"))
            self.assertEqual(len(combined), 64)  # SHA256 hex length
        finally:
            schema_path.unlink()


class TestRealSchemaHash(unittest.TestCase):
    """Integration tests with real schema files."""

    def setUp(self):
        """Set up paths to real schema files."""
        self.script_dir = Path(__file__).parent
        self.project_root = self.script_dir.parent.parent
        self.schema_path = self.project_root / "packages" / "shared-schema" / "src" / "schema.ts"
        self.types_path = self.project_root / "packages" / "shared-schema" / "src" / "types.ts"

    def test_real_schema_hash(self):
        """Should successfully hash real schema file using combined hash."""
        if not self.schema_path.exists():
            self.skipTest("Schema file not found")

        # Test with just schema (types may or may not exist)
        hash_value = get_combined_hash(self.schema_path, Path("/nonexistent.ts"))
        self.assertEqual(len(hash_value), 64)  # SHA256 hex length

    def test_real_combined_hash(self):
        """Should successfully create combined hash of real files."""
        if not self.schema_path.exists():
            self.skipTest("Schema file not found")

        combined = get_combined_hash(self.schema_path, self.types_path)
        self.assertEqual(len(combined), 64)  # SHA256 hex length

        # Hash should be consistent
        combined2 = get_combined_hash(self.schema_path, self.types_path)
        self.assertEqual(combined, combined2)


class TestHashStorage(unittest.TestCase):
    """Test hash storage and retrieval."""

    def test_store_and_retrieve_hash(self):
        """Should store and retrieve hash correctly."""
        with tempfile.TemporaryDirectory() as tmpdir:
            hash_file = Path(tmpdir) / ".schema_hash"

            # Store
            test_hash = "abc123def456"
            hash_file.parent.mkdir(parents=True, exist_ok=True)
            hash_file.write_text(test_hash)

            # Retrieve
            stored = hash_file.read_text().strip()
            self.assertEqual(stored, test_hash)

    def test_missing_hash_file(self):
        """Should handle missing hash file."""
        hash_file = Path("/nonexistent/.schema_hash")
        if hash_file.exists():
            stored = hash_file.read_text().strip()
        else:
            stored = ""
        self.assertEqual(stored, "")


class TestBoardDataCache(unittest.TestCase):
    def test_shard_and_generator_edits_invalidate_cached_board_data(self):
        class BuildEnvironment(dict):
            def GetProjectOption(self, _name, default):
                return default

            def AddPreAction(self, *_arguments):
                pass

        with patch("builtins.print"):
            namespace = runpy.run_path(
                str(Path(__file__).with_name("prebuild.py")),
                init_globals={"env": BuildEnvironment(), "Import": lambda _name: None},
            )
        tracked_sources = namespace["BOARD_DATA_SOURCES"]
        get_board_hash = namespace["get_board_data_hash"]
        for source_name in ("kilter.cjs", "tension.cjs", "generate-board-data.mjs"):
            with self.subTest(source=source_name), tempfile.TemporaryDirectory() as directory:
                self.assertIn(source_name, [source.name for source in tracked_sources])
                source = Path(directory) / source_name
                source.write_text("original hold coordinates")
                get_board_hash.__globals__["BOARD_DATA_SOURCES"] = [source]
                original_hash = get_board_hash()
                source.write_text("updated hold coordinates")
                self.assertNotEqual(original_hash, get_board_hash())


if __name__ == '__main__':
    # Run tests with verbosity
    unittest.main(verbosity=2)

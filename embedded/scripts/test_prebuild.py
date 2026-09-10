#!/usr/bin/env python3
"""Unit tests for the PlatformIO prebuild cache inputs and output gates."""

import importlib.util
import tempfile
import unittest
from pathlib import Path


PREBUILD_PATH = Path(__file__).with_name("prebuild.py")
PREBUILD_SPEC = importlib.util.spec_from_file_location("boardsesh_firmware_prebuild", PREBUILD_PATH)
if PREBUILD_SPEC is None or PREBUILD_SPEC.loader is None:
    raise RuntimeError(f"Could not load {PREBUILD_PATH}")
prebuild = importlib.util.module_from_spec(PREBUILD_SPEC)
PREBUILD_SPEC.loader.exec_module(prebuild)


class TestHashFunctions(unittest.TestCase):
    """Exercise the production hashing helpers instead of a test copy."""

    def test_hash_is_independent_of_input_order(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            first_path = temporary_root / "first.ts"
            second_path = temporary_root / "second.ts"
            first_path.write_text("first")
            second_path.write_text("second")

            self.assertEqual(
                prebuild.hash_input_files([first_path, second_path]),
                prebuild.hash_input_files([second_path, first_path]),
            )

    def test_hash_includes_path_names_as_well_as_contents(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            original_path = temporary_root / "original.png"
            renamed_path = temporary_root / "renamed.png"
            original_path.write_bytes(b"same pixels")
            original_hash = prebuild.hash_input_files([original_path])

            original_path.rename(renamed_path)

            self.assertNotEqual(original_hash, prebuild.hash_input_files([renamed_path]))

    def test_missing_required_file_fails(self):
        with self.assertRaisesRegex(FileNotFoundError, "Required codegen input is missing"):
            prebuild.hash_input_files([Path("/definitely-missing/codegen-input.ts")])


class TestBoardDataHash(unittest.TestCase):
    """Guard image-byte and file-set invalidation for display firmware."""

    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.temporary_root = Path(self.temporary_directory.name)
        self.source_path = self.temporary_root / "board-source.ts"
        self.source_path.write_text("board source")
        self.image_root = self.temporary_root / "images"
        self.image_root.mkdir()
        self.image_path = self.image_root / "board.png"
        self.image_path.write_bytes(b"initial pixels")

    def tearDown(self):
        self.temporary_directory.cleanup()

    def get_hash(self) -> str:
        return prebuild.get_board_data_hash([self.source_path], [self.image_root])

    def test_png_content_change_invalidates_hash(self):
        initial_hash = self.get_hash()
        self.image_path.write_bytes(b"changed pixels")
        self.assertNotEqual(initial_hash, self.get_hash())

    def test_add_delete_and_rename_invalidate_hash(self):
        initial_hash = self.get_hash()

        added_path = self.image_root / "added.png"
        added_path.write_bytes(b"added pixels")
        added_hash = self.get_hash()
        self.assertNotEqual(initial_hash, added_hash)

        added_path.unlink()
        self.assertEqual(initial_hash, self.get_hash())

        renamed_path = self.image_root / "renamed.png"
        self.image_path.rename(renamed_path)
        self.assertNotEqual(initial_hash, self.get_hash())

    def test_nested_alternate_image_change_invalidates_hash(self):
        nested_root = self.image_root / "future" / "alternate"
        nested_root.mkdir(parents=True)
        nested_image_path = nested_root / "board.webp"
        nested_image_path.write_bytes(b"nested pixels")
        initial_hash = self.get_hash()

        nested_image_path.write_bytes(b"changed nested pixels")

        self.assertNotEqual(initial_hash, self.get_hash())

    def test_missing_or_empty_image_root_fails(self):
        with self.assertRaisesRegex(FileNotFoundError, "Required board image directory is missing"):
            prebuild.get_board_data_hash([self.source_path], [self.temporary_root / "missing"])

        empty_root = self.temporary_root / "empty"
        empty_root.mkdir()
        with self.assertRaisesRegex(FileNotFoundError, "No board image files found"):
            prebuild.get_board_data_hash([self.source_path], [empty_root])


class TestProductionInputs(unittest.TestCase):
    """Assert the cache follows every tracked source consumed in production."""

    def test_graphql_inputs_are_controller_schema_and_generator(self):
        self.assertEqual(
            set(prebuild.GRAPHQL_CODEGEN_SOURCES),
            {prebuild.CODEGEN_SCRIPT, prebuild.CONTROLLER_SCHEMA_PATH},
        )
        self.assertTrue(prebuild.CONTROLLER_SCHEMA_PATH.is_file())
        self.assertTrue(prebuild.CODEGEN_SCRIPT.is_file())

    def test_board_inputs_include_generator_shards_data_and_pngs(self):
        expected_sources = {
            prebuild.BOARD_DATA_CODEGEN_SCRIPT,
            prebuild.PROJECT_ROOT
            / "packages"
            / "board-constants"
            / "src"
            / "generated"
            / "product-sizes-data.ts",
            prebuild.PROJECT_ROOT
            / "packages"
            / "board-constants"
            / "src"
            / "generated"
            / "led-placements-data.ts",
            prebuild.PROJECT_ROOT
            / "packages"
            / "board-constants"
            / "src"
            / "generated"
            / "hole-placements"
            / "kilter.cjs",
            prebuild.PROJECT_ROOT
            / "packages"
            / "board-constants"
            / "src"
            / "generated"
            / "hole-placements"
            / "tension.cjs",
            prebuild.PROJECT_ROOT / "packages" / "shared" / "board-config" / "src" / "board-data.ts",
        }
        self.assertEqual(set(prebuild.BOARD_DATA_SOURCES), expected_sources)

        production_inputs = prebuild.get_board_data_inputs()
        self.assertTrue(all(source_path.is_file() for source_path in production_inputs))
        self.assertTrue(any(source_path.suffix == ".png" for source_path in production_inputs))
        self.assertEqual(
            {image_root.name for image_root in prebuild.BOARD_DATA_IMAGE_ROOTS},
            {"kilter", "tension"},
        )


class TestGeneratedOutputGate(unittest.TestCase):
    def test_every_expected_output_must_be_nonempty(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            output_paths = [temporary_root / "one.h", temporary_root / "two.h", temporary_root / "three.cpp"]
            for output_path in output_paths:
                output_path.write_text("generated")

            self.assertTrue(prebuild.outputs_are_complete(output_paths))

            output_paths[1].write_text("")
            self.assertFalse(prebuild.outputs_are_complete(output_paths))

            output_paths[1].unlink()
            self.assertFalse(prebuild.outputs_are_complete(output_paths))


if __name__ == "__main__":
    unittest.main(verbosity=2)

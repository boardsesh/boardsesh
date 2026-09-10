#!/usr/bin/env python3
"""
PlatformIO Pre-Build Script for GraphQL Type Generation

This script runs before each build to ensure GraphQL types are up-to-date.
It checks if the schema has changed and regenerates types if needed.

Usage in platformio.ini:
    extra_scripts = pre:../scripts/prebuild.py
"""

import os
import subprocess
import hashlib
from pathlib import Path

try:
    Import("env")
except NameError:
    # Allow unit tests to import the pure hashing/cache helpers without SCons.
    env = None

# Paths
# __file__ may not be defined in some Python/SCons versions
try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    # Fallback: derive from the env's project directory
    SCRIPT_DIR = Path(env.subst("$PROJECT_DIR")).parent.parent / "scripts"
PROJECT_ROOT = SCRIPT_DIR.parent.parent
CONTROLLER_SCHEMA_PATH = PROJECT_ROOT / "packages" / "shared-schema" / "src" / "schema" / "controller.ts"
OUTPUT_PATH = SCRIPT_DIR.parent / "libs" / "graphql-types" / "src" / "graphql_types.h"
HASH_FILE = SCRIPT_DIR.parent / "libs" / "graphql-types" / ".schema_hash"
CODEGEN_SCRIPT = SCRIPT_DIR / "generate-graphql-types.mjs"
GRAPHQL_CODEGEN_SOURCES = [CODEGEN_SCRIPT, CONTROLLER_SCHEMA_PATH]

# Board data codegen paths
BOARD_DATA_CODEGEN_SCRIPT = SCRIPT_DIR / "generate-board-data.mjs"
BOARD_DATA_SOURCES = [
    BOARD_DATA_CODEGEN_SCRIPT,
    PROJECT_ROOT / "packages" / "board-constants" / "src" / "generated" / "product-sizes-data.ts",
    PROJECT_ROOT / "packages" / "board-constants" / "src" / "generated" / "led-placements-data.ts",
    PROJECT_ROOT / "packages" / "board-constants" / "src" / "generated" / "hole-placements" / "kilter.cjs",
    PROJECT_ROOT / "packages" / "board-constants" / "src" / "generated" / "hole-placements" / "tension.cjs",
    PROJECT_ROOT / "packages" / "shared" / "board-config" / "src" / "board-data.ts",
]
BOARD_DATA_IMAGE_ROOTS = [
    PROJECT_ROOT / "packages" / "web" / "public" / "images" / "kilter",
    PROJECT_ROOT / "packages" / "web" / "public" / "images" / "tension",
]
BOARD_DATA_OUTPUTS = [
    SCRIPT_DIR.parent / "libs" / "board-data" / "src" / "board_image_data.h",
    SCRIPT_DIR.parent / "libs" / "board-data" / "src" / "board_hold_data.h",
    SCRIPT_DIR.parent / "libs" / "board-data" / "src" / "board_data.cpp",
]
BOARD_DATA_HASH_FILE = SCRIPT_DIR.parent / "libs" / "board-data" / ".board_data_hash"

# Use environment variable to track execution across potential script reloads.
# This is more robust than a module-level variable if PlatformIO reloads scripts.
_CODEGEN_RAN_ENV_KEY = "_GRAPHQL_CODEGEN_RAN"
_BOARD_DATA_RAN_ENV_KEY = "_BOARD_DATA_CODEGEN_RAN"


def _has_codegen_run() -> bool:
    """Check if codegen has already run in this build session."""
    return os.environ.get(_CODEGEN_RAN_ENV_KEY) == "1"


def _mark_codegen_run():
    """Mark that codegen has run in this build session."""
    os.environ[_CODEGEN_RAN_ENV_KEY] = "1"


def hash_input_files(filepaths: list[Path]) -> str:
    """Hash stable path names and contents for a complete set of required inputs."""
    hasher = hashlib.sha256()
    for filepath in sorted(filepaths, key=lambda candidate: candidate.as_posix()):
        if not filepath.is_file():
            raise FileNotFoundError(f"Required codegen input is missing: {filepath}")
        try:
            stable_path = filepath.relative_to(PROJECT_ROOT).as_posix()
        except ValueError:
            stable_path = filepath.resolve().as_posix()
        hasher.update(stable_path.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(filepath.read_bytes())
        hasher.update(b"\0")
    return hasher.hexdigest()


def get_combined_hash() -> str:
    """Hash the actual controller schema and its C++ generator."""
    return hash_input_files(GRAPHQL_CODEGEN_SOURCES)


def get_stored_hash() -> str:
    """Read previously stored hash."""
    if HASH_FILE.exists():
        return HASH_FILE.read_text().strip()
    return ""


def store_hash(hash_value: str):
    """Store hash for future comparison."""
    HASH_FILE.parent.mkdir(parents=True, exist_ok=True)
    HASH_FILE.write_text(hash_value)


def run_codegen():
    """Run the JavaScript code generator."""
    print("=" * 60)
    print("GraphQL Codegen: Generating C++ types from schema...")
    print("=" * 60)

    try:
        # Run with node (ES module)
        result = subprocess.run(
            ["node", str(CODEGEN_SCRIPT)],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=60,
        )

        if result.returncode != 0:
            raise RuntimeError(f"GraphQL codegen failed:\n{result.stderr}")

        print(result.stdout)
        return

    except FileNotFoundError as error:
        raise RuntimeError("Node.js is required for GraphQL codegen") from error
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("GraphQL codegen timed out") from error


def get_board_data_inputs(
    source_files: list[Path] | None = None,
    image_roots: list[Path] | None = None,
) -> list[Path]:
    """Return fixed sources plus every file under each board image tree."""
    resolved_sources = list(BOARD_DATA_SOURCES if source_files is None else source_files)
    resolved_image_roots = BOARD_DATA_IMAGE_ROOTS if image_roots is None else image_roots

    for image_root in resolved_image_roots:
        if not image_root.is_dir():
            raise FileNotFoundError(f"Required board image directory is missing: {image_root}")
        image_paths = sorted(
            (candidate for candidate in image_root.rglob("*") if candidate.is_file()),
            key=lambda candidate: candidate.relative_to(image_root).as_posix(),
        )
        if not image_paths:
            raise FileNotFoundError(f"No board image files found in required directory: {image_root}")
        resolved_sources.extend(image_paths)

    return resolved_sources


def get_board_data_hash(
    source_files: list[Path] | None = None,
    image_roots: list[Path] | None = None,
) -> str:
    """Hash all board data and image inputs consumed by the generator."""
    return hash_input_files(get_board_data_inputs(source_files, image_roots))


def outputs_are_complete(output_paths: list[Path]) -> bool:
    """Return true only when every expected generated output is nonempty."""
    return all(output_path.is_file() and output_path.stat().st_size > 0 for output_path in output_paths)


def get_stored_board_data_hash() -> str:
    """Read previously stored board data hash."""
    if BOARD_DATA_HASH_FILE.exists():
        return BOARD_DATA_HASH_FILE.read_text().strip()
    return ""


def store_board_data_hash(hash_value: str):
    """Store board data hash for future comparison."""
    BOARD_DATA_HASH_FILE.parent.mkdir(parents=True, exist_ok=True)
    BOARD_DATA_HASH_FILE.write_text(hash_value)


def run_board_data_codegen():
    """Run the board data code generator."""
    print("=" * 60)
    print("Board Data Codegen: Generating C++ board image/hold data...")
    print("=" * 60)

    try:
        result = subprocess.run(
            ["node", str(BOARD_DATA_CODEGEN_SCRIPT)],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=600,  # Board data gen processes 36 board images (compositing + JPEG conversion)
        )

        if result.returncode != 0:
            raise RuntimeError(f"Board data codegen failed:\n{result.stderr}")

        print(result.stdout)
        return

    except FileNotFoundError as error:
        raise RuntimeError("Node.js is required for board data codegen") from error
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Board data codegen timed out") from error


def check_board_data_codegen():
    """Check and regenerate board data if needed."""
    if os.environ.get(_BOARD_DATA_RAN_ENV_KEY) == "1":
        return
    os.environ[_BOARD_DATA_RAN_ENV_KEY] = "1"

    print("\n[Board Data Codegen] Checking if board data needs regeneration...")

    current_hash = get_board_data_hash()

    # Check if every output exists and is nonempty.
    if not outputs_are_complete(BOARD_DATA_OUTPUTS):
        print("[Board Data Codegen] Output files missing, generating...")
        run_board_data_codegen()
        if not outputs_are_complete(BOARD_DATA_OUTPUTS):
            raise RuntimeError("Board data codegen completed without every required output")
        store_board_data_hash(current_hash)
        return

    # Check if sources have changed
    stored_hash = get_stored_board_data_hash()

    if current_hash != stored_hash:
        print("[Board Data Codegen] Source data changed, regenerating...")
        run_board_data_codegen()
        if not outputs_are_complete(BOARD_DATA_OUTPUTS):
            raise RuntimeError("Board data codegen completed without every required output")
        store_board_data_hash(current_hash)
    else:
        print("[Board Data Codegen] Board data is up-to-date")


def env_has_define(define_name: str) -> bool:
    """Return true when the active PlatformIO env has a C/C++ define set."""
    for define in env.get("CPPDEFINES", []):
        if define == define_name:
            return True
        if isinstance(define, (list, tuple)) and len(define) > 0 and define[0] == define_name:
            return True

    # During dependency scanning PlatformIO can load pre-scripts before every
    # build flag has been expanded into CPPDEFINES, so also inspect the raw
    # build flags for -D forms.
    build_flags = []
    try:
        build_flags.extend(env.GetProjectOption("build_flags", []))
    except Exception:
        pass
    build_flags.extend(env.get("BUILD_FLAGS", []))

    for flag in build_flags:
        flag_text = str(flag)
        if flag_text == f"-D{define_name}" or flag_text == f"-D {define_name}":
            return True
        if flag_text.startswith(f"-D{define_name}=") or flag_text.startswith(f"-D {define_name}="):
            return True
    return False


def before_build(source, target, env):
    """Pre-build hook to check and regenerate types if needed."""
    if _has_codegen_run():
        return
    _mark_codegen_run()

    print("\n[GraphQL Codegen] Checking if types need regeneration...")

    # Check if schema exists
    current_hash = get_combined_hash()

    # Check if output exists
    if not outputs_are_complete([OUTPUT_PATH]):
        print("[GraphQL Codegen] Output file missing, generating...")
        run_codegen()
        if not outputs_are_complete([OUTPUT_PATH]):
            raise RuntimeError("GraphQL codegen completed without a nonempty header")
        store_hash(current_hash)
        return

    # Check if schema has changed
    stored_hash = get_stored_hash()

    if current_hash != stored_hash:
        print("[GraphQL Codegen] Schema changed, regenerating types...")
        run_codegen()
        if not outputs_are_complete([OUTPUT_PATH]):
            raise RuntimeError("GraphQL codegen completed without a nonempty header")
        store_hash(current_hash)
    else:
        print("[GraphQL Codegen] Types are up-to-date")


# Register the pre-build action.
# "buildprog" runs before final linking, "$BUILD_DIR/firmware.elf" catches the build early.
# The environment variable deduplication ensures we only run once regardless of which fires first.
#
# Board data is needed while PlatformIO compiles dependent libraries, so it must
# be generated when this pre-script is loaded rather than in the link-time hook.
if env is not None:
    if env_has_define("ENABLE_BOARD_IMAGE"):
        check_board_data_codegen()
    else:
        print("[Board Data Codegen] Skipping (ENABLE_BOARD_IMAGE not set)")

    env.AddPreAction("buildprog", before_build)
    env.AddPreAction("$BUILD_DIR/${PROGNAME}.elf", before_build)

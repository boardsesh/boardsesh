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

Import("env")

# Paths
# __file__ may not be defined in some Python/SCons versions
try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    # Fallback: derive from the env's project directory
    SCRIPT_DIR = Path(env.subst("$PROJECT_DIR")).parent.parent / "scripts"
PROJECT_ROOT = SCRIPT_DIR.parent.parent
SCHEMA_PATH = PROJECT_ROOT / "packages" / "shared-schema" / "src" / "schema.ts"
TYPES_PATH = PROJECT_ROOT / "packages" / "shared-schema" / "src" / "types.ts"
OUTPUT_PATH = SCRIPT_DIR.parent / "libs" / "graphql-types" / "src" / "graphql_types.h"
HASH_FILE = SCRIPT_DIR.parent / "libs" / "graphql-types" / ".schema_hash"
CODEGEN_SCRIPT = SCRIPT_DIR / "generate-graphql-types.mjs"

# Board data codegen paths
BOARD_DATA_SOURCES = [
    PROJECT_ROOT / "packages" / "board-constants" / "src" / "generated" / "product-sizes-data.ts",
    PROJECT_ROOT / "packages" / "board-constants" / "src" / "generated" / "led-placements-data.ts",
    PROJECT_ROOT / "packages" / "web" / "app" / "lib" / "board-data.ts",
]
BOARD_DATA_OUTPUT = SCRIPT_DIR.parent / "libs" / "board-data" / "src" / "board_hold_data.h"
BOARD_DATA_HASH_FILE = SCRIPT_DIR.parent / "libs" / "board-data" / ".board_data_hash"
BOARD_DATA_CODEGEN_SCRIPT = SCRIPT_DIR / "generate-board-data.mjs"

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


def get_combined_hash() -> str:
    """Get combined hash of schema and types files by hashing contents directly."""
    hasher = hashlib.sha256()
    for filepath in [SCHEMA_PATH, TYPES_PATH]:
        if filepath.exists():
            with open(filepath, "rb") as f:
                hasher.update(f.read())
    return hasher.hexdigest()


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
            print(f"Error running codegen:\n{result.stderr}")
            # Don't fail the build, just warn
            print("Warning: GraphQL codegen failed, using existing types")
            return False

        print(result.stdout)
        return True

    except FileNotFoundError:
        print("Warning: Node.js not found. Skipping GraphQL codegen.")
        print("Install Node.js to enable automatic type generation.")
        return False
    except subprocess.TimeoutExpired:
        print("Warning: GraphQL codegen timed out")
        return False
    except Exception as e:
        print(f"Warning: GraphQL codegen error: {e}")
        return False


def get_board_data_hash() -> str:
    """Get combined hash of board data source files."""
    hasher = hashlib.sha256()
    for filepath in BOARD_DATA_SOURCES:
        if filepath.exists():
            with open(filepath, "rb") as f:
                hasher.update(f.read())
    return hasher.hexdigest()


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
            print(f"Error running board data codegen:\n{result.stderr}")
            print("Warning: Board data codegen failed, using existing data")
            return False

        print(result.stdout)
        return True

    except FileNotFoundError:
        print("Warning: Node.js not found. Skipping board data codegen.")
        return False
    except subprocess.TimeoutExpired:
        print("Warning: Board data codegen timed out")
        return False
    except Exception as e:
        print(f"Warning: Board data codegen error: {e}")
        return False


def check_board_data_codegen():
    """Check and regenerate board data if needed."""
    if os.environ.get(_BOARD_DATA_RAN_ENV_KEY) == "1":
        return
    os.environ[_BOARD_DATA_RAN_ENV_KEY] = "1"

    print("\n[Board Data Codegen] Checking if board data needs regeneration...")

    # Check if source files exist
    sources_exist = any(p.exists() for p in BOARD_DATA_SOURCES)
    if not sources_exist:
        print("[Board Data Codegen] Source files not found, skipping")
        return

    # Check if output exists
    if not BOARD_DATA_OUTPUT.exists():
        print("[Board Data Codegen] Output files missing, generating...")
        if run_board_data_codegen():
            store_board_data_hash(get_board_data_hash())
        return

    # Check if sources have changed
    current_hash = get_board_data_hash()
    stored_hash = get_stored_board_data_hash()

    if current_hash != stored_hash:
        print("[Board Data Codegen] Source data changed, regenerating...")
        if run_board_data_codegen():
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
    return False


def before_build(source, target, env):
    """Pre-build hook to check and regenerate types if needed."""
    if _has_codegen_run():
        return
    _mark_codegen_run()

    print("\n[GraphQL Codegen] Checking if types need regeneration...")

    # Check if schema exists
    if not SCHEMA_PATH.exists():
        print(f"[GraphQL Codegen] Schema not found at {SCHEMA_PATH}")
        print("[GraphQL Codegen] Skipping codegen (schema not available)")
        return

    # Check if output exists
    if not OUTPUT_PATH.exists():
        print("[GraphQL Codegen] Output file missing, generating...")
        if run_codegen():
            store_hash(get_combined_hash())
        return

    # Check if schema has changed
    current_hash = get_combined_hash()
    stored_hash = get_stored_hash()

    if current_hash != stored_hash:
        print("[GraphQL Codegen] Schema changed, regenerating types...")
        if run_codegen():
            store_hash(current_hash)
    else:
        print("[GraphQL Codegen] Types are up-to-date")

    # Only the local board-image firmware needs generated board image/hold data.
    if env_has_define("ENABLE_BOARD_IMAGE"):
        check_board_data_codegen()
    else:
        print("[Board Data Codegen] Skipping (ENABLE_BOARD_IMAGE not set)")


# Register the pre-build action.
# "buildprog" runs before final linking, "$BUILD_DIR/firmware.elf" catches the build early.
# The environment variable deduplication ensures we only run once regardless of which fires first.
env.AddPreAction("buildprog", before_build)
env.AddPreAction("$BUILD_DIR/${PROGNAME}.elf", before_build)

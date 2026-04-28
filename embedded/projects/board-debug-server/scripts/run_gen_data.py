"""PlatformIO pre-build hook: regenerate the firmware's board catalog and
placement maps from the workspace TS sources before each compile.

Skipped if `bun` is not on PATH; the firmware still builds against whatever the
last committed .gen.cpp files contain.
"""

import os
import shutil
import subprocess
import sys

Import("env")  # type: ignore[name-defined]  # noqa: F821 — provided by PlatformIO


def main():
    project_dir = env["PROJECT_DIR"]  # type: ignore[name-defined]  # noqa: F821
    script = os.path.join(project_dir, "scripts", "generate_debug_data.ts")
    if not os.path.isfile(script):
        return

    bun = shutil.which("bun")
    if not bun:
        print("[board-debug-server] bun not found, skipping data regeneration")
        return

    print("[board-debug-server] regenerating board catalog + placement maps")
    result = subprocess.run([bun, "run", script], cwd=project_dir, check=False)
    if result.returncode != 0:
        sys.stderr.write(
            "[board-debug-server] data generation failed (exit %d). "
            "Build will use the previously generated .gen.cpp files.\n" % result.returncode
        )


main()

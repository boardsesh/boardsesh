"""PlatformIO pre-build hook: read .env from the project dir and inject the
DEFAULT_WIFI_SSID / DEFAULT_WIFI_PASSWORD entries as build flags so the
firmware can fall back to a known-good network when NVS is empty.

The file is gitignored; this script is a no-op when it doesn't exist.
"""

import os

Import("env")  # type: ignore[name-defined]  # noqa: F821 — provided by PlatformIO


def shell_quote_cstring(value: str) -> str:
    # Wrap in escaped quotes so the value lands as a C string literal in the
    # compile command (build_flags are tokenized by the shell).
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'\\"{escaped}\\"'


def main():
    project_dir = env["PROJECT_DIR"]  # type: ignore[name-defined]  # noqa: F821
    for filename in (".env", ".env.local"):
        path = os.path.join(project_dir, filename)
        if not os.path.isfile(path):
            continue
        with open(path, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key in ("DEFAULT_WIFI_SSID", "DEFAULT_WIFI_PASSWORD"):
                    flag = f"-D {key}={shell_quote_cstring(value)}"
                    env.Append(BUILD_FLAGS=[flag])  # type: ignore[name-defined]  # noqa: F821
                    print(f"[board-debug-server] injected {key} from {filename}")


main()

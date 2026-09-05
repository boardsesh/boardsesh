# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Boardsesh contributors

"""PlatformIO pre-script: inject Wi-Fi credentials from .env as build flags.

Why a script instead of `${sysenv.EMULATOR_WIFI_SSID}` in platformio.ini:
PlatformIO expands `${sysenv.X}` at config-parse time, BEFORE pre-scripts run.
So a pre-script that loads .env into os.environ has no effect — the flags are
already empty strings by then. Instead, this script reads .env directly and
appends `-DEMULATOR_WIFI_SSID="..."` / `-DEMULATOR_WIFI_PASS="..."` to
BUILD_FLAGS via env.Append, which works after parse.

If .env is missing it's bootstrapped from .env.example so a fresh clone builds
with the committed defaults (AP: scout-iot / pw: dontspyonme on Marco's build).
Contributors edit .env locally; .env is git-ignored.
"""

import os
import shutil

Import("env")  # type: ignore  # noqa: F821 - injected by PlatformIO

PROJECT_DIR = env["PROJECT_DIR"]  # type: ignore  # noqa: F821
ENV_PATH = os.path.join(PROJECT_DIR, ".env")
EXAMPLE_PATH = os.path.join(PROJECT_DIR, ".env.example")


def _bootstrap_env_file() -> None:
    if os.path.exists(ENV_PATH):
        return
    if os.path.exists(EXAMPLE_PATH):
        shutil.copyfile(EXAMPLE_PATH, ENV_PATH)
        print(f"[load_env] Created {ENV_PATH} from .env.example (edit it for your AP).")
    else:
        print(f"[load_env] WARNING: no {ENV_PATH} and no .env.example — emulator Wi-Fi will be empty.")


def _read_env_file() -> dict[str, str]:
    values: dict[str, str] = {}
    if not os.path.exists(ENV_PATH):
        return values
    with open(ENV_PATH, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _escape_for_c_string(value: str) -> str:
    # Backslashes first, then double-quotes — the order matters.
    return value.replace("\\", "\\\\").replace('"', '\\"')


_bootstrap_env_file()
_env = _read_env_file()

# Shell environment wins so `EMULATOR_WIFI_SSID=foo pio run ...` overrides .env.
ssid = os.environ.get("EMULATOR_WIFI_SSID", _env.get("EMULATOR_WIFI_SSID", ""))
psk = os.environ.get("EMULATOR_WIFI_PASS", _env.get("EMULATOR_WIFI_PASS", ""))

env.Append(  # type: ignore  # noqa: F821
    BUILD_FLAGS=[
        f'-DEMULATOR_WIFI_SSID=\\"{_escape_for_c_string(ssid)}\\"',
        f'-DEMULATOR_WIFI_PASS=\\"{_escape_for_c_string(psk)}\\"',
    ]
)

print(f"[load_env] EMULATOR_WIFI_SSID = {ssid!r}")
print(f"[load_env] EMULATOR_WIFI_PASS = {'***' if psk else '(empty)'}")

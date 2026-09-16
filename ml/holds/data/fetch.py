#!/usr/bin/env python3
"""Download the public parts of the hold corpus into `ml/holds/.data/`.

Licence discipline is enforced here rather than left to a reviewer: an entry in
`sources.json` with no licence, or with a non-commercial licence, is refused.
Epic #5346 decided this repo ships Apache-2.0 models and may not take CC BY-NC
training data.

Nothing downloaded here is ever committed: `.data/` is gitignored.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

HOLDS_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = HOLDS_DIR / ".data"
SOURCES_PATH = Path(__file__).resolve().parent / "sources.json"

FORBIDDEN_LICENCE_MARKERS = (
    "nc",
    "non-commercial",
    "noncommercial",
    "unknown",
    "unspecified",
    "none",
    "not stated",
    "all rights reserved",
)


def licence_is_acceptable(licence: str | None) -> tuple[bool, str]:
    if not licence or not licence.strip():
        return False, "no licence recorded"
    lowered = licence.lower()
    for marker in FORBIDDEN_LICENCE_MARKERS:
        if marker == "nc":
            if "-nc" in lowered or lowered.startswith("nc-"):
                return False, f"non-commercial licence: {licence}"
        elif marker in lowered:
            return False, f"unusable licence: {licence}"
    return True, licence


def download(url: str, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        print(f"  already downloaded: {destination.name}")
        return destination
    print(f"  GET {url}")
    with urllib.request.urlopen(url) as response, destination.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    return destination


def unpack(archive: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as zf:
            # filter="data" refuses members with absolute paths or `..` segments,
            # which is the difference between unpacking a dataset and letting one
            # write wherever it likes.
            zf.extractall(target, filter="data")
    elif archive.suffixes[-2:] in ([".tar", ".gz"], [".tar", ".xz"]) or archive.suffix in (".tgz", ".tar"):
        with tarfile.open(archive) as tf:
            tf.extractall(target, filter="data")
    else:
        raise SystemExit(f"do not know how to unpack {archive}")


def roboflow_api_key() -> str:
    """Read the Roboflow key from the environment, or from the owner's key file.

    Never printed, never logged, never written into `sources.json` or any artifact.
    The file is the source of truth; the env var exists so a caller can do
    `ROBOFLOW_API_KEY=$(cat ~/.config/roboflow/api-key) python data/fetch.py`
    without the key reaching the process table of anything else.
    """
    from_env = os.environ.get("ROBOFLOW_API_KEY", "").strip()
    if from_env:
        return from_env
    key_path = Path.home() / ".config" / "roboflow" / "api-key"
    if key_path.exists():
        return key_path.read_text().strip()
    raise SystemExit(
        "no Roboflow API key. Put it in ~/.config/roboflow/api-key (mode 600), "
        "or set ROBOFLOW_API_KEY. Never pass it on a command line."
    )


def fetch_roboflow(entry: dict, target: Path) -> None:
    """Download one Roboflow Universe dataset version in COCO format.

    A dataset export does not consume training credits, but Roboflow-hosted
    training and hosted inference do — this repo trains locally, so neither is
    ever called from here.
    """
    try:
        from roboflow import Roboflow
    except ImportError as error:
        # Deliberately not in requirements.txt: the Roboflow SDK is only needed for
        # this one-off dataset download, never by train/export/eval, so the pinned
        # set stays the training set. Say so instead of dying on a bare traceback.
        raise SystemExit(
            "the Roboflow SDK is not installed, so this dataset cannot be downloaded.\n"
            "  pip install roboflow\n"
            f"(import error: {error})"
        ) from error

    workspace, project, version = entry["workspace"], entry["project"], int(entry["version"])
    if (target / "train" / "_annotations.coco.json").exists():
        print(f"  already downloaded: {target}")
        return
    # The SDK creates the location itself and skips the download when the
    # directory already exists, so do not pre-create it.
    target.parent.mkdir(parents=True, exist_ok=True)

    dataset = (
        Roboflow(api_key=roboflow_api_key())
        .workspace(workspace)
        .project(project)
        .version(version)
        .download("coco", location=str(target), overwrite=True)
    )
    # Record what we actually got, so a number in the report can be traced to a
    # dataset version rather than to "Roboflow, some time in September".
    manifest = {
        "workspace": workspace,
        "project": project,
        "version": version,
        "licence": entry["licence"],
        "url": entry.get("url"),
        "downloaded_to": str(dataset.location if hasattr(dataset, "location") else target),
        "fetched_on": date.today().isoformat(),
    }
    (target / "boardsesh-manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"  -> {target} (version {version}, {entry['licence']})")


def fetch_git(url: str, target: Path, ref: str | None) -> None:
    if target.exists():
        print(f"  already cloned: {target}")
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    command = ["git", "clone", "--depth", "1"]
    if ref:
        command += ["--branch", ref]
    command += [url, str(target)]
    subprocess.run(command, check=True)


def fetch_source(name: str, entry: dict) -> None:
    print(f"[{name}]")
    ok, reason = licence_is_acceptable(entry.get("licence"))
    if not ok:
        print(f"  SKIPPED — {reason}")
        return

    kind = entry.get("kind", "archive")
    if kind == "private":
        print("  private corpus; not fetchable here.")
        print(f"  {entry.get('notes', '')}")
        return
    if kind == "manual":
        print("  manual download required. Steps:")
        for step in entry.get("steps", []):
            print(f"    - {step}")
        return

    target = DATA_DIR / name
    if kind == "roboflow":
        fetch_roboflow(entry, target)
        return
    if kind == "git":
        fetch_git(entry["url"], target, entry.get("ref"))
    elif kind == "archive":
        archive = download(entry["url"], DATA_DIR / "_archives" / Path(entry["url"]).name)
        unpack(archive, target)
    elif kind == "huggingface":
        from huggingface_hub import snapshot_download

        snapshot_download(repo_id=entry["repo_id"], repo_type="dataset", local_dir=str(target))
    else:
        raise SystemExit(f"unknown source kind {kind!r}")
    print(f"  -> {target}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", action="append", help="fetch just these sources (repeatable)")
    parser.add_argument("--list", action="store_true", help="print the registry with licences and exit")
    args = parser.parse_args()

    registry = json.loads(SOURCES_PATH.read_text())["sources"]

    if args.list:
        for name, entry in registry.items():
            ok, reason = licence_is_acceptable(entry.get("licence"))
            print(f"{name:28s} {'USABLE ' if ok else 'SKIPPED'} {reason}")
        return 0

    wanted = args.only or list(registry)
    for name in wanted:
        if name not in registry:
            print(f"unknown source {name!r}", file=sys.stderr)
            return 1
        fetch_source(name, registry[name])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Fetch the spray-wall training export onto this machine (SW-20, issue #5471).

Climbers' spray walls are the training data the detector is missing: every
published wall is a photo plus a hold set its owner checked. The backend writes
the walls whose owner left "Help train hold finding" on, and that a spray admin
approved, to the PRIVATE bucket once a day:

    spray-training/exports/<exportId>/
      train/v<versionId>.jpg            the wall photo, EXIF already stripped
      train/_annotations.coco.json      one class, `hold`; bbox + polygon in photo px
      valid/...                         same layout
      eval/...                          same layout; frozen per root wall, never trained on
      candidates.json                   what the detector suggested and what became of it
      manifest.json                     written LAST: exportId, schemaVersion, counts,
                                        consent snapshot, split membership, and
                                        `files: {relpath: sha256}` for every file above

`fetch` mirrors the newest export that has a manifest into
`.data/user-walls/<exportId>/`, checks every file against its sha256, records
when it did so in `boardsesh-fetch.json`, and then DELETES every local export
the bucket no longer holds. The backend retires an export as soon as one of its
walls stops being eligible (consent switched off, wall deleted or hidden,
account deleted, approval revoked), so this deletion is how a removed wall
leaves the training machine. train.py refuses a user-walls dataset fetched more
than 7 days ago, so skipping `fetch` cannot keep a removed wall in a training run.

The directory it writes is the layout train.py already reads (`train/`,
`valid/`, each with `_annotations.coco.json`). The held-out split keeps its
export name, `eval`, which is also the name eval.py's `--split` takes for the
hand-labelled spray corpus. There is deliberately no `test/` directory: rfdetr
would score a `test/` split during training if `run_test` were ever switched on.

Credentials are the backend's PRIVATE_* bucket variables
(docs/user-media-storage.md). R2_PRIVATE_BUCKET and R2_ENDPOINT, which the
README's corpus-protocol `aws s3 sync` line uses, are accepted for the bucket and
endpoint. Nothing here ever writes to the bucket.

    python data/user_walls.py fetch                       # from the private bucket
    python data/user_walls.py fetch --from-dir <dir>      # a local copy, for tests

`--from-dir` takes either a directory standing in for `spray-training/exports/`
(one sub-directory per export) or a single export directory (it holds
`manifest.json` itself).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

HOLDS_DIR = Path(__file__).resolve().parent.parent
DEFAULT_ROOT = HOLDS_DIR / ".data" / "user-walls"

EXPORTS_PREFIX = "spray-training/exports/"
MANIFEST_FILENAME = "manifest.json"
FETCH_RECORD_FILENAME = "boardsesh-fetch.json"
ANNOTATIONS_FILENAME = "_annotations.coco.json"
SCHEMA_VERSION = 1

TRAINING_SPLITS = ("train", "valid")
HELD_OUT_SPLIT = "eval"
SPLITS = (*TRAINING_SPLITS, HELD_OUT_SPLIT)

# How old a local copy may be before train.py refuses it. The backend retires an
# export within 24 h of a wall leaving; a week bounds how long a machine that
# never re-fetches can keep training on it.
MAX_FETCH_AGE = timedelta(days=7)

# An exportId becomes a local directory name, so it must be one plain segment.
EXPORT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
# Marks a directory as one this script manages, so `fetch --root` pointed at the
# wrong place (say `.data/`) refuses instead of deleting everything in it.
ROOT_MARKER_FILENAME = ".boardsesh-user-walls"
# Files the manifest may not list: the manifest cannot hash itself, and the fetch
# record is ours.
RESERVED_FILES = {MANIFEST_FILENAME, FETCH_RECORD_FILENAME}


class UserWallsError(SystemExit):
    """A fetch or a dataset check that must stop the run, with a readable reason."""


# --------------------------------------------------------------------------- #
# Where an export is read from
# --------------------------------------------------------------------------- #


class ExportStore(Protocol):
    def describe(self) -> str: ...

    def list_export_ids(self) -> list[str]:
        """Every export that has a manifest. A prefix without one is mid-write or mid-retire."""
        ...

    def read_bytes(self, export_id: str, relpath: str) -> bytes: ...

    def download(self, export_id: str, relpath: str, destination: Path) -> str:
        """Write one file to `destination` and return the sha256 of what was written."""
        ...


def _hash_copy(source, destination: Path) -> str:
    digest = hashlib.sha256()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as handle:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
            handle.write(chunk)
    return digest.hexdigest()


class DirStore:
    """A local directory laid out like `spray-training/exports/`, or one export."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.single: str | None = None
        if (root / MANIFEST_FILENAME).is_file():
            manifest = json.loads((root / MANIFEST_FILENAME).read_text())
            export_id = manifest.get("exportId") if isinstance(manifest, dict) else None
            if not isinstance(export_id, str):
                raise UserWallsError(f"{root / MANIFEST_FILENAME} has no exportId")
            self.single = export_id

    def describe(self) -> str:
        return f"dir:{self.root}"

    def _dir(self, export_id: str) -> Path:
        return self.root if self.single == export_id else self.root / export_id

    def list_export_ids(self) -> list[str]:
        if not self.root.is_dir():
            raise UserWallsError(f"--from-dir {self.root} is not a directory")
        if self.single is not None:
            return [self.single]
        return sorted(child.name for child in self.root.iterdir() if (child / MANIFEST_FILENAME).is_file())

    def read_bytes(self, export_id: str, relpath: str) -> bytes:
        return (self._dir(export_id) / relpath).read_bytes()

    def download(self, export_id: str, relpath: str, destination: Path) -> str:
        source = self._dir(export_id) / relpath
        if not source.is_file():
            raise UserWallsError(f"{source} is listed in the manifest but missing")
        with source.open("rb") as handle:
            return _hash_copy(handle, destination)


@dataclass(frozen=True)
class PrivateBucketConfig:
    bucket_name: str
    endpoint_url: str | None
    region: str
    access_key_id: str
    secret_access_key: str
    force_path_style: bool


def _env(env: dict[str, str], *names: str) -> str | None:
    for name in names:
        value = env.get(name, "").strip()
        if value:
            return value
    return None


def read_private_bucket_config(env: dict[str, str] | None = None) -> PrivateBucketConfig:
    env = dict(os.environ) if env is None else env
    bucket_name = _env(env, "PRIVATE_S3_BUCKET_NAME", "R2_PRIVATE_BUCKET")
    access_key_id = _env(env, "PRIVATE_AWS_ACCESS_KEY_ID")
    secret_access_key = _env(env, "PRIVATE_AWS_SECRET_ACCESS_KEY")
    missing = [
        name
        for name, value in (
            ("PRIVATE_S3_BUCKET_NAME (or R2_PRIVATE_BUCKET)", bucket_name),
            ("PRIVATE_AWS_ACCESS_KEY_ID", access_key_id),
            ("PRIVATE_AWS_SECRET_ACCESS_KEY", secret_access_key),
        )
        if not value
    ]
    if missing:
        raise UserWallsError(
            "private bucket not configured: set "
            + ", ".join(missing)
            + " (docs/user-media-storage.md), or pass --from-dir for a local copy"
        )
    assert bucket_name and access_key_id and secret_access_key
    return PrivateBucketConfig(
        bucket_name=bucket_name,
        endpoint_url=_env(env, "PRIVATE_AWS_ENDPOINT_URL", "PRIVATE_AWS_ENDPOINT_URL_S3", "R2_ENDPOINT"),
        region=_env(env, "PRIVATE_AWS_REGION", "PRIVATE_AWS_DEFAULT_REGION") or "auto",
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        force_path_style=(_env(env, "PRIVATE_S3_FORCE_PATH_STYLE") or "false").lower() in ("1", "true", "yes"),
    )


class BucketStore:
    """The private R2 bucket, read through boto3. Read-only: no put, no delete."""

    def __init__(self, config: PrivateBucketConfig, client: Any = None) -> None:
        self.config = config
        if client is None:
            try:
                import boto3
                from botocore.config import Config
            except ImportError as error:
                raise UserWallsError(f"boto3 is not installed: pip install boto3 ({error})") from error
            client = boto3.client(
                "s3",
                endpoint_url=config.endpoint_url,
                region_name=config.region,
                aws_access_key_id=config.access_key_id,
                aws_secret_access_key=config.secret_access_key,
                config=Config(s3={"addressing_style": "path" if config.force_path_style else "virtual"}),
            )
        self.client = client

    def describe(self) -> str:
        return f"s3://{self.config.bucket_name}/{EXPORTS_PREFIX}"

    def _key(self, export_id: str, relpath: str) -> str:
        return f"{EXPORTS_PREFIX}{export_id}/{relpath}"

    def list_export_ids(self) -> list[str]:
        ids: set[str] = set()
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.config.bucket_name, Prefix=EXPORTS_PREFIX):
            for entry in page.get("Contents", []):
                rest = entry["Key"][len(EXPORTS_PREFIX) :]
                export_id, _, name = rest.partition("/")
                if name == MANIFEST_FILENAME:
                    ids.add(export_id)
        return sorted(ids)

    def read_bytes(self, export_id: str, relpath: str) -> bytes:
        response = self.client.get_object(Bucket=self.config.bucket_name, Key=self._key(export_id, relpath))
        return response["Body"].read()

    def download(self, export_id: str, relpath: str, destination: Path) -> str:
        response = self.client.get_object(Bucket=self.config.bucket_name, Key=self._key(export_id, relpath))
        return _hash_copy(response["Body"], destination)


# --------------------------------------------------------------------------- #
# The manifest
# --------------------------------------------------------------------------- #


def _safe_relpath(relpath: object) -> str:
    """A manifest path becomes a local path: refuse anything that could escape."""
    if not isinstance(relpath, str) or not relpath:
        raise UserWallsError(f"manifest lists a file with an unusable path: {relpath!r}")
    parts = PurePosixPath(relpath).parts
    if relpath.startswith("/") or "\\" in relpath or any(part in ("", ".", "..") for part in parts):
        raise UserWallsError(f"manifest path {relpath!r} is not a plain relative path")
    if relpath in RESERVED_FILES:
        raise UserWallsError(f"manifest must not list {relpath}")
    return relpath


def parse_manifest(raw: bytes, export_id: str) -> dict[str, Any]:
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as error:
        raise UserWallsError(f"export {export_id}: manifest.json is not JSON ({error})") from error
    if not isinstance(manifest, dict):
        raise UserWallsError(f"export {export_id}: manifest.json is not an object")
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise UserWallsError(
            f"export {export_id}: schemaVersion {manifest.get('schemaVersion')!r}, this script reads "
            f"{SCHEMA_VERSION}. Update data/user_walls.py before training on it."
        )
    if manifest.get("exportId") != export_id:
        raise UserWallsError(f"export {export_id}: manifest says exportId {manifest.get('exportId')!r}")
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        raise UserWallsError(f"export {export_id}: manifest has no `files` map")
    for relpath, digest in files.items():
        _safe_relpath(relpath)
        if not isinstance(digest, str) or not SHA256_PATTERN.match(digest):
            raise UserWallsError(f"export {export_id}: {relpath} has no usable sha256 ({digest!r})")
    for split in TRAINING_SPLITS:
        if f"{split}/{ANNOTATIONS_FILENAME}" not in files:
            raise UserWallsError(f"export {export_id}: manifest lists no {split}/{ANNOTATIONS_FILENAME}")
    return manifest


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def local_copy_matches(export_dir: Path, manifest_bytes: bytes, manifest: dict[str, Any]) -> bool:
    """True when `export_dir` already holds exactly this manifest and every file verifies."""
    local_manifest = export_dir / MANIFEST_FILENAME
    if not local_manifest.is_file() or local_manifest.read_bytes() != manifest_bytes:
        return False
    for relpath, digest in manifest["files"].items():
        path = export_dir / relpath
        if not path.is_file() or _sha256_file(path) != digest:
            return False
    return True


# --------------------------------------------------------------------------- #
# Dataset checks shared with train.py
# --------------------------------------------------------------------------- #


def _load_coco(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict) or not isinstance(payload.get("images"), list):
        raise UserWallsError(f"{path} is not a COCO file")
    return payload


def _split_refs(dataset_dir: Path, split: str) -> tuple[set[str], set[str], set[str], list[str]]:
    """(root refs, version refs, file names, problems) for one split."""
    path = dataset_dir / split / ANNOTATIONS_FILENAME
    roots: set[str] = set()
    versions: set[str] = set()
    names: set[str] = set()
    problems: list[str] = []
    if not path.is_file():
        return roots, versions, names, problems
    for image in _load_coco(path)["images"]:
        refs = image.get("boardsesh") if isinstance(image.get("boardsesh"), dict) else {}
        root_ref, version_ref = refs.get("root_ref"), refs.get("version_ref")
        if not root_ref or not version_ref:
            problems.append(f"{split}/{image.get('file_name')} has no boardsesh.root_ref/version_ref")
        if root_ref:
            roots.add(str(root_ref))
        if version_ref:
            versions.add(str(version_ref))
        names.add(str(image.get("file_name")))
    return roots, versions, names, problems


def eval_isolation_problems(dataset_dir: Path) -> list[str]:
    """Every way the held-out `eval` split overlaps train/valid. Empty means isolated.

    The backend assigns a split per ROOT wall (a reset clone follows its root), so
    one wall in two splits is a backend bug that would inflate the eval number.
    """
    held_roots, held_versions, held_names, problems = _split_refs(dataset_dir, HELD_OUT_SPLIT)
    for split in TRAINING_SPLITS:
        roots, versions, names, split_problems = _split_refs(dataset_dir, split)
        problems += split_problems
        for kind, overlap in (
            ("wall (root_ref)", held_roots & roots),
            ("version (version_ref)", held_versions & versions),
            ("photo file", held_names & names),
        ):
            if overlap:
                sample = ", ".join(sorted(overlap)[:3])
                problems.append(f"{len(overlap)} eval {kind} also in {split}: {sample}")
    return problems


def missing_image_files(dataset_dir: Path) -> list[str]:
    missing: list[str] = []
    for split in SPLITS:
        path = dataset_dir / split / ANNOTATIONS_FILENAME
        if not path.is_file():
            continue
        for image in _load_coco(path)["images"]:
            if not (dataset_dir / split / str(image.get("file_name"))).is_file():
                missing.append(f"{split}/{image.get('file_name')}")
    return missing


def is_user_walls_dataset(dataset_dir: Path) -> bool:
    if (dataset_dir / FETCH_RECORD_FILENAME).is_file():
        return True
    manifest_path = dataset_dir / MANIFEST_FILENAME
    if not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError:
        return False
    return isinstance(manifest, dict) and "exportId" in manifest


def check_training_dataset(dataset_dir: Path, now: datetime | None = None) -> None:
    """train.py's gate for a user-walls dataset: fresh, and eval kept out of training.

    A no-op for any other dataset.
    """
    if not is_user_walls_dataset(dataset_dir):
        return
    refetch = "Re-run `python data/user_walls.py fetch` and train on the directory it prints."
    record_path = dataset_dir / FETCH_RECORD_FILENAME
    if not record_path.is_file():
        raise UserWallsError(
            f"{dataset_dir} is a user-walls export that was not fetched by data/user_walls.py "
            f"(no {FETCH_RECORD_FILENAME}), so nothing proves its walls are still eligible. {refetch}"
        )
    try:
        record = json.loads(record_path.read_text())
        fetched_at = datetime.fromisoformat(str(record["fetched_at"]))
    except (KeyError, ValueError, TypeError, json.JSONDecodeError) as error:
        raise UserWallsError(f"{record_path} has no readable fetched_at ({error}). {refetch}") from error
    if fetched_at.tzinfo is None:
        fetched_at = fetched_at.replace(tzinfo=timezone.utc)
    now = now or datetime.now(timezone.utc)
    age = now - fetched_at
    if age > MAX_FETCH_AGE:
        raise UserWallsError(
            f"{dataset_dir} was fetched {age.days} days ago ({record['fetched_at']}); user-walls data "
            f"older than {MAX_FETCH_AGE.days} days may still hold walls whose owners switched training "
            f"off or deleted them. {refetch}"
        )
    problems = eval_isolation_problems(dataset_dir)
    if problems:
        raise UserWallsError(
            f"{dataset_dir}: the held-out eval split leaks into training:\n  - "
            + "\n  - ".join(problems)
            + "\nDo not train on this export; the backend's split assignment needs fixing."
        )


# --------------------------------------------------------------------------- #
# What an export holds
# --------------------------------------------------------------------------- #


@dataclass
class SplitSummary:
    images: int = 0
    holds: int = 0
    mask_from_circle: int = 0
    manual: int = 0
    auto_review: dict[str, int] = field(default_factory=dict)


def summarise(dataset_dir: Path) -> dict[str, SplitSummary]:
    summaries: dict[str, SplitSummary] = {}
    for split in SPLITS:
        path = dataset_dir / split / ANNOTATIONS_FILENAME
        if not path.is_file():
            continue
        payload = _load_coco(path)
        summary = SplitSummary(images=len(payload["images"]))
        for annotation in payload.get("annotations", []):
            summary.holds += 1
            attributes = annotation.get("attributes") if isinstance(annotation.get("attributes"), dict) else {}
            if attributes.get("mask_from_circle") is True:
                summary.mask_from_circle += 1
            if attributes.get("source") == "manual":
                summary.manual += 1
            else:
                review = attributes.get("auto_review") or "unreviewed"
                summary.auto_review[review] = summary.auto_review.get(review, 0) + 1
        summaries[split] = summary
    return summaries


def _share(part: int, whole: int) -> str:
    return f"{part}/{whole} ({100 * part / whole:.1f}%)" if whole else "0/0"


def print_summary(export_id: str, export_dir: Path, summaries: dict[str, SplitSummary]) -> None:
    print(f"export {export_id} -> {export_dir}")
    total = SplitSummary()
    for split, summary in summaries.items():
        print(f"  {split:5s} {summary.images:5d} photos {summary.holds:7d} holds")
        total.holds += summary.holds
        total.mask_from_circle += summary.mask_from_circle
        total.manual += summary.manual
        for review, count in summary.auto_review.items():
            total.auto_review[review] = total.auto_review.get(review, 0) + count
    # A circle-only hold got a 24-point polygon from the backend. It trains the
    # mask head on a circle, not a silhouette, so watch this share.
    print(f"  masks drawn from a circle, not an outline: {_share(total.mask_from_circle, total.holds)}")
    print(f"  placed by hand: {_share(total.manual, total.holds)}")
    for review in sorted(total.auto_review):
        # `accepted` holds are the old model's guesses kept as-is: they agree with
        # that model by construction, which biases any score measured on them.
        print(f"  detector suggestion, {review}: {_share(total.auto_review[review], total.holds)}")


# --------------------------------------------------------------------------- #
# fetch
# --------------------------------------------------------------------------- #


def _remove(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()


def _write_fetch_record(export_dir: Path, export_id: str, source: str, files: int, now: datetime) -> None:
    record = {
        "exportId": export_id,
        "schemaVersion": SCHEMA_VERSION,
        "fetched_at": now.isoformat(),
        "source": source,
        "files": files,
    }
    (export_dir / FETCH_RECORD_FILENAME).write_text(json.dumps(record, indent=2) + "\n")


def _belongs_to(name: str, current: set[str]) -> bool:
    """An export dir, or a cache train.py derived from one (`<id>-cap400`, `<id>-tiles-…`)."""
    if name == ROOT_MARKER_FILENAME:
        return True
    return name in current or any(name.startswith(f"{export_id}-") for export_id in current)


def claim_root(root: Path) -> None:
    """Create `root` as a managed directory, or refuse one that holds anything else."""
    if root.is_dir() and any(root.iterdir()) and not (root / ROOT_MARKER_FILENAME).is_file():
        raise UserWallsError(
            f"refusing to manage {root}: it is not empty and has no {ROOT_MARKER_FILENAME}, and fetch "
            "deletes everything in its root that is not a current export. Point --root at an empty "
            f"directory (default {DEFAULT_ROOT})."
        )
    root.mkdir(parents=True, exist_ok=True)
    (root / ROOT_MARKER_FILENAME).write_text("managed by ml/holds/data/user_walls.py fetch\n")


def delete_retired(root: Path, current: set[str]) -> list[str]:
    """Delete everything under `root` that is not a current export or a cache of one."""
    removed: list[str] = []
    if not root.is_dir():
        return removed
    for child in sorted(root.iterdir()):
        if _belongs_to(child.name, current):
            continue
        _remove(child)
        removed.append(child.name)
    return removed


def _download(store: ExportStore, export_id: str, manifest_bytes: bytes, manifest: dict[str, Any], staging: Path) -> None:
    if staging.exists():
        _remove(staging)
    staging.mkdir(parents=True)
    try:
        for relpath, expected in sorted(manifest["files"].items()):
            actual = store.download(export_id, relpath, staging / relpath)
            if actual != expected:
                raise UserWallsError(
                    f"export {export_id}: {relpath} sha256 {actual} does not match the manifest's {expected}. "
                    "Nothing was kept; re-run fetch, and if it repeats the export is corrupt."
                )
        (staging / MANIFEST_FILENAME).write_bytes(manifest_bytes)
        missing = missing_image_files(staging)
        if missing:
            raise UserWallsError(
                f"export {export_id}: COCO names {len(missing)} photos the manifest does not list, e.g. "
                + ", ".join(missing[:3])
            )
        problems = eval_isolation_problems(staging)
        if problems:
            raise UserWallsError(
                f"export {export_id}: the eval split overlaps training, refusing it:\n  - " + "\n  - ".join(problems)
            )
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def fetch(store: ExportStore, root: Path = DEFAULT_ROOT, now: datetime | None = None) -> Path | None:
    """Mirror the newest export into `root`, verify it, and delete retired ones.

    Returns the local export directory, or None when the bucket holds no export
    (in which case every local export is deleted).
    """
    now = now or datetime.now(timezone.utc)
    # Listing first, and failing loudly: a listing error must never read as "the
    # bucket is empty" and wipe, or keep, the wrong things.
    export_ids = store.list_export_ids()
    for export_id in export_ids:
        if not EXPORT_ID_PATTERN.match(export_id):
            raise UserWallsError(f"bucket holds an export with an unusable id {export_id!r}")
    current = set(export_ids)
    claim_root(root)

    if not export_ids:
        removed = delete_retired(root, current)
        print(f"no export with a manifest in {store.describe()}")
        if removed:
            print(f"deleted {len(removed)} local exports the bucket no longer holds: {', '.join(removed)}")
        return None

    newest = max(export_ids)
    manifest_bytes = store.read_bytes(newest, MANIFEST_FILENAME)
    manifest = parse_manifest(manifest_bytes, newest)
    export_dir = root / newest

    if local_copy_matches(export_dir, manifest_bytes, manifest):
        print(f"{export_dir} already matches the bucket; every sha256 re-verified")
    else:
        staging = root / f".{newest}.partial"
        _download(store, newest, manifest_bytes, manifest, staging)
        if export_dir.exists():
            _remove(export_dir)
        staging.rename(export_dir)
        print(f"fetched {len(manifest['files'])} files from {store.describe()}; every sha256 verified")
    _write_fetch_record(export_dir, newest, store.describe(), len(manifest["files"]), now)

    # An older export the bucket still holds is still eligible (the backend retires
    # an export the moment any of its walls is not), so it may stay, and its
    # fetched_at is refreshed, but only when its local copy is byte-identical.
    for export_id in sorted(current - {newest}):
        older_dir = root / export_id
        if not older_dir.is_dir():
            continue
        older_bytes = store.read_bytes(export_id, MANIFEST_FILENAME)
        if local_copy_matches(older_dir, older_bytes, parse_manifest(older_bytes, export_id)):
            _write_fetch_record(older_dir, export_id, store.describe(), len(json.loads(older_bytes)["files"]), now)
        else:
            _remove(older_dir)
            print(f"deleted {older_dir}: it no longer matches the bucket's copy")

    removed = delete_retired(root, current)
    if removed:
        print(f"deleted {len(removed)} local entries the bucket no longer holds: {', '.join(removed)}")

    print_summary(newest, export_dir, summarise(export_dir))
    if isinstance(manifest.get("counts"), dict):
        print(f"  manifest counts: {json.dumps(manifest['counts'], sort_keys=True)}")
    print(f"\ntrain with: python train.py --config <config> --dataset {export_dir}")
    print(f"record with: python publish_model.py ... --user-walls-export {newest}")
    return export_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    fetch_parser = commands.add_parser("fetch", help="mirror the newest export and delete retired ones")
    fetch_parser.add_argument("--from-dir", help="read exports from this local directory instead of the bucket")
    fetch_parser.add_argument("--root", default=str(DEFAULT_ROOT), help=f"local export directory (default {DEFAULT_ROOT})")
    args = parser.parse_args(argv)

    if args.command == "fetch":
        store: ExportStore = DirStore(Path(args.from_dir)) if args.from_dir else BucketStore(read_private_bucket_config())
        fetch(store, Path(args.root))
    return 0


if __name__ == "__main__":
    sys.exit(main())

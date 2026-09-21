#!/usr/bin/env python3
"""Publish a hold-detector export to Cloudflare R2 (epic #5346, SW-01, issue #5434).

Nothing in ml/holds/ ships to the app on its own - the mobile loader (issue #5435)
and a possible server-side inference container (issue #5451) both fetch a version
from `models/hold-detector/<version>/` in the PUBLIC `media` R2 bucket at runtime:

    models/hold-detector/<version>/manifest.json
    models/hold-detector/<version>/model-int8.onnx
    models/hold-detector/<version>/model.onnx          (only with --include-fp32)

The manifest is the contract a consumer validates against
`ml/holds/model-manifest.schema.json` before trusting anything else in it. Build
one, validate it, then either upload it (real R2 credentials present) or write the
same tree to a local directory with --dry-run - the default whenever the MEDIA_*
R2 variables are absent, so this script is safe to run with no credentials at all.

Weights are content-addressed by version and therefore immutable: once
`models/hold-detector/1.2.0/model-int8.onnx` exists, it is never rewritten. Only
the manifest at that version may be intentionally replaced (with --force), which
is why the weight files upload first and the manifest uploads last - a reader can
never observe a manifest pointing at a weight file that hasn't landed yet.
--force does NOT extend to the weights: a published weight file with the same
sha256 is skipped, and one with different bytes stops the publish, because those
objects are served with a one-year immutable cache and a client holding the old
bytes would fail the new manifest's checksum.

Env vars (mirrors packages/backend/src/storage/bucket-config.ts's MEDIA_* prefix;
see docs/user-media-storage.md):

    MEDIA_S3_BUCKET_NAME          selects real-upload mode
    MEDIA_AWS_ENDPOINT_URL        (or MEDIA_AWS_ENDPOINT_URL_S3)
    MEDIA_AWS_REGION              (or MEDIA_AWS_DEFAULT_REGION; defaults to 'auto')
    MEDIA_AWS_ACCESS_KEY_ID
    MEDIA_AWS_SECRET_ACCESS_KEY
    MEDIA_S3_FORCE_PATH_STYLE     optional, defaults false (virtual-hosted)
    MEDIA_PUBLIC_BASE_URL         optional; only used to print the public manifest URL
    MEDIA_DISABLE_ACL             optional; defaults true for an R2 endpoint

This script never falls back to the bare legacy AWS_* variables - the media bucket
is the only thing it ever writes to, and a typo'd MEDIA_ prefix should fail loudly
rather than silently publish a model export into some other bucket.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

HOLDS_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIGS_PATH = HOLDS_DIR / "configs.json"
SCHEMA_PATH = HOLDS_DIR / "model-manifest.schema.json"

MODEL_KEY_PREFIX = "models/hold-detector"
INT8_FILENAME = "model-int8.onnx"
FP32_FILENAME = "model.onnx"
MANIFEST_FILENAME = "manifest.json"

# --version is a path segment in two places: the R2 key prefix and the dry-run
# output directory. Keep it to one boring segment so neither can escape.
VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

# RF-DETR is pretrained on ImageNet-normalised inputs; eval.py's OnnxDetector
# uses these exact constants (ml/holds/eval.py, OnnxDetector.__init__).
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]

EVAL_KEYS = ("sprayEvalF1", "weightedCorrectionsPerHold", "gestureSavings")

# eval.py writes its own vocabulary, not the manifest's: box F1 lives at
# `box.f1` and the weighted correction rate at `correction_rate_micro` (see
# ml/holds/eval.py's results dict). --eval-json is normally handed exactly that
# file, so each manifest key also knows the dotted path to read it from.
EVAL_SOURCE_PATHS: dict[str, tuple[str, ...]] = {
    "sprayEvalF1": ("box", "f1"),
    "weightedCorrectionsPerHold": ("correction_rate_micro",),
}


# --------------------------------------------------------------------------- #
# configs.json
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ConfigInfo:
    name: str
    family: str
    resolution: int
    score_threshold: float
    # Whether the export carries a third, mask tensor. Read straight from
    # configs.json rather than through common.py, which would drag torch in.
    produces_masks: bool = False
    mask_source: str = "none"
    long_side: int = 0
    tile_rows: int = 1
    tile_cols: int = 1
    tile_overlap: float = 0.0
    nms_iou: float = 0.5


def load_config_info(name: str, path: Path = DEFAULT_CONFIGS_PATH) -> ConfigInfo:
    raw = json.loads(Path(path).read_text())
    configs = raw.get("configs", {})
    if name not in configs:
        raise SystemExit(f"unknown config {name!r} in {path}; known: {', '.join(sorted(configs))}")
    entry = configs[name]
    return ConfigInfo(
        name=name,
        family=str(entry["family"]),
        resolution=int(entry["resolution"]),
        score_threshold=float(entry.get("score_threshold", 0.3)),
        produces_masks=bool(entry.get("produces_masks", False)),
        mask_source=str(entry.get("mask_source", "none")),
        long_side=int(entry.get("long_side", entry["resolution"])),
        tile_rows=int(entry.get("tiles", {}).get("rows", 1)),
        tile_cols=int(entry.get("tiles", {}).get("cols", 1)),
        tile_overlap=float(entry.get("tiles", {}).get("overlap", 0.0)),
        nms_iou=float(entry.get("nms_iou", 0.5)),
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --------------------------------------------------------------------------- #
# Media bucket configuration (env only - no SDK construction, no network)
# --------------------------------------------------------------------------- #


def _read_trimmed(env: dict[str, str], name: str) -> str | None:
    raw = env.get(name)
    if raw is None:
        return None
    trimmed = raw.strip()
    return trimmed or None


def _read_bool(env: dict[str, str], name: str, default: bool) -> bool:
    raw = _read_trimmed(env, name)
    if raw is None:
        return default
    normalized = raw.lower()
    if normalized in ("true", "1"):
        return True
    if normalized in ("false", "0"):
        return False
    raise SystemExit(f"{name} must be 'true' or 'false' (got {raw!r})")


def _is_r2_endpoint(endpoint_url: str | None) -> bool:
    if not endpoint_url:
        return False
    try:
        host = urlparse(endpoint_url).hostname or ""
    except ValueError:
        return False
    return host.endswith(".r2.cloudflarestorage.com")


@dataclass(frozen=True)
class MediaBucketConfig:
    bucket_name: str
    endpoint_url: str | None
    region: str
    access_key_id: str
    secret_access_key: str
    force_path_style: bool
    public_base_url: str | None
    disable_acl: bool


def read_media_bucket_config(env: dict[str, str] | None = None) -> MediaBucketConfig | None:
    """Resolve the `media` bucket's config from MEDIA_* env vars, or None if unset.

    Returns None (rather than raising) only when MEDIA_S3_BUCKET_NAME itself is
    absent - that's the "no credentials, dry run" case. A bucket name set with
    missing credentials is a half-finished deploy, so that raises immediately
    rather than failing later as an opaque 403 (same contract as bucket-config.ts).
    """
    env = dict(os.environ) if env is None else env
    bucket_name = _read_trimmed(env, "MEDIA_S3_BUCKET_NAME")
    if bucket_name is None:
        return None

    access_key_id = _read_trimmed(env, "MEDIA_AWS_ACCESS_KEY_ID")
    secret_access_key = _read_trimmed(env, "MEDIA_AWS_SECRET_ACCESS_KEY")
    if not access_key_id or not secret_access_key:
        missing = [
            name
            for name, value in (
                ("MEDIA_AWS_ACCESS_KEY_ID", access_key_id),
                ("MEDIA_AWS_SECRET_ACCESS_KEY", secret_access_key),
            )
            if not value
        ]
        raise SystemExit(
            "MEDIA_S3_BUCKET_NAME is set but " + " and ".join(missing) + " "
            + ("is" if len(missing) == 1 else "are")
            + " missing. Set every MEDIA_* variable together (docs/user-media-storage.md)."
        )

    endpoint_url = _read_trimmed(env, "MEDIA_AWS_ENDPOINT_URL") or _read_trimmed(env, "MEDIA_AWS_ENDPOINT_URL_S3")
    region = _read_trimmed(env, "MEDIA_AWS_REGION") or _read_trimmed(env, "MEDIA_AWS_DEFAULT_REGION") or "auto"
    force_path_style = _read_bool(env, "MEDIA_S3_FORCE_PATH_STYLE", False)
    public_base_url = _read_trimmed(env, "MEDIA_PUBLIC_BASE_URL")
    disable_acl = _read_bool(env, "MEDIA_DISABLE_ACL", _is_r2_endpoint(endpoint_url))

    return MediaBucketConfig(
        bucket_name=bucket_name,
        endpoint_url=endpoint_url,
        region=region,
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        force_path_style=force_path_style,
        public_base_url=public_base_url,
        disable_acl=disable_acl,
    )


def describe_bucket_config(bucket: MediaBucketConfig) -> str:
    """One-line summary for the log, same shape as bucket-config.ts's line. Never
    includes credentials."""
    endpoint = bucket.endpoint_url or "aws"
    public_base = bucket.public_base_url or "none"
    return (
        f"storage[media] bucket={bucket.bucket_name} endpoint={endpoint} region={bucket.region} "
        f"pathStyle={bucket.force_path_style} acl={'none' if bucket.disable_acl else 'public-read'} public={public_base}"
    )


# --------------------------------------------------------------------------- #
# Manifest
# --------------------------------------------------------------------------- #


def build_manifest(
    *,
    config: ConfigInfo,
    version: str,
    files: list[dict[str, Any]],
    threshold: float,
    sweep: list[float],
    training: dict[str, Any],
    eval_metrics: dict[str, Any] | None,
) -> dict[str, Any]:
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "version": version,
        "family": config.family,
        "config": config.name,
        "input": {
            "width": config.resolution,
            "height": config.resolution,
            "layout": "NCHW",
            "dtype": "float32",
            # eval.py's OnnxDetector.preprocess resizes each tile directly to
            # (resolution, resolution) with no aspect-preserving padding.
            "letterbox": "stretch",
            "normalization": {"mean": IMAGENET_MEAN, "std": IMAGENET_STD},
        },
        "outputs": {
            # RF-DETR's exporter doesn't name outputs consistently across
            # versions; eval.py identifies boxes/logits by shape instead, so
            # `name` stays null - a consumer must do the same.
            "boxes": {"name": None, "format": "cxcywh-normalized"},
            "logits": {"name": None, "activation": "sigmoid", "classes": 1},
        },
        "inference": {
            "longSide": config.long_side,
            "tiles": {"rows": config.tile_rows, "cols": config.tile_cols, "overlap": config.tile_overlap},
            "nmsIou": config.nms_iou,
        },
        "thresholds": {"default": threshold, "sweep": sweep},
        "files": files,
        "training": training,
        "licence": "Apache-2.0",
    }
    if config.produces_masks and config.mask_source == "model":
        # A segmentation export carries a third tensor. Without this entry a
        # consumer reading the manifest sees two outputs and silently falls back
        # to circles, which is the whole thing the seg model exists to avoid.
        manifest["outputs"]["masks"] = {
            "name": None,
            "activation": "sigmoid",
            "layout": "queries-hw",
            "decode": "interpolate-then-threshold",
        }
    if eval_metrics:
        manifest["eval"] = eval_metrics
    return manifest


def validate_manifest(manifest: dict[str, Any]) -> None:
    import jsonschema

    schema = json.loads(SCHEMA_PATH.read_text())
    # Keep schema-v1 readers compatible with legacy manifests. New exports
    # always need an explicit plan, including an untiled full-frame pass.
    schema["required"] = [*schema["required"], "inference"]
    jsonschema.validate(instance=manifest, schema=schema)


def resolve_training(args: argparse.Namespace) -> dict[str, Any]:
    training: dict[str, Any] = {}
    if args.training_json:
        loaded = json.loads(Path(args.training_json).read_text())
        if not isinstance(loaded, dict):
            raise SystemExit(f"--training-json {args.training_json} must contain a JSON object")
        training.update(loaded)

    overrides = {
        "dataset": args.dataset,
        "licence": args.training_licence,
        "epochs": args.epochs,
        "trainedOn": args.trained_on,
        "date": args.date,
    }
    for key, value in overrides.items():
        if value is not None:
            training[key] = value

    required = ["dataset", "licence", "epochs", "trainedOn", "date"]
    # A real 0 (or 0.0) stays acceptable, so this cannot be a plain falsy test.
    # It cannot be `not value` on booleans either: `True`/`False` compare equal to
    # 1/0, so a JSON `"epochs": false` would slip through and fail much later as an
    # opaque jsonschema type error instead of the friendly message below.
    missing = [
        key
        for key in required
        if training.get(key) is None or isinstance(training.get(key), bool) or training.get(key) == ""
    ]
    if missing:
        raise SystemExit(
            "missing training metadata: "
            + ", ".join(missing)
            + " - pass --dataset/--training-licence/--epochs/--trained-on/--date, or --training-json"
        )
    return training


# A distinct "the file does not have this key at all", so a key present with a null
# value (which eval.py does write) is never confused with a missing one.
_ABSENT = object()


def _dig(payload: dict[str, Any], dotted_path: tuple[str, ...]) -> Any:
    """Read a nested value out of an eval.py results dict, or _ABSENT if it has none."""
    current: Any = payload
    for segment in dotted_path:
        if not isinstance(current, dict) or segment not in current:
            return _ABSENT
        current = current[segment]
    return current


def check_eval_provenance(
    loaded: dict[str, Any],
    eval_json_path: str,
    *,
    config_name: str,
    threshold: float,
    published_filenames: set[str],
) -> None:
    """Refuse an eval.py results file that measured something other than this export.

    eval.py records which config, which ONNX file and which score threshold produced
    its numbers. Publishing a tune-sweep run, another config's run, or a run at a
    different threshold would present those numbers as this export's held-out result
    at the shipped default - an easy file-selection mistake that silently corrupts
    published experiment results, so each recorded field must match.
    """
    recorded_config = loaded.get("config", _ABSENT)
    recorded_model = loaded.get("model", _ABSENT)
    recorded_threshold = loaded.get("score_threshold", _ABSENT)

    recorded_fields = (
        ("config", recorded_config),
        ("model", recorded_model),
        ("score_threshold", recorded_threshold),
    )
    # A key that is there but null is a different failure from a key that is not
    # there at all: the first is a run that recorded nothing for it, the second an
    # older or hand-made file. Say which.
    absent = [name for name, value in recorded_fields if value is _ABSENT]
    null = [name for name, value in recorded_fields if value is None]
    if absent or null:
        problems: list[str] = []
        if absent:
            problems.append(f"does not record {', '.join(absent)}")
        if null:
            problems.append(f"has {', '.join(null)} set to null")
        raise SystemExit(
            f"--eval-json {eval_json_path} looks like an eval.py results file but "
            + " and ".join(problems)
            + ". Re-run eval.py to regenerate it, or pass a manifest-shaped eval JSON instead."
        )

    if recorded_config != config_name:
        raise SystemExit(
            f"--eval-json {eval_json_path} was measured on config {recorded_config!r}, "
            f"but this publish is --config {config_name!r}. Score the config being published."
        )

    # eval.py writes the model path relative to ml/holds (or its bare filename), so
    # compare the filename against the artifacts this publish actually uploads.
    recorded_filename = Path(str(recorded_model)).name
    if recorded_filename not in published_filenames:
        raise SystemExit(
            f"--eval-json {eval_json_path} was measured on {recorded_model!r}, which is not one of "
            f"the files being published ({', '.join(sorted(published_filenames))}). Quantization "
            "shifts score calibration, so the numbers must come from the artifact that ships."
        )

    try:
        recorded_threshold_value = float(recorded_threshold)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise SystemExit(
            f"--eval-json {eval_json_path} records score_threshold {recorded_threshold!r}, which is "
            "not a number. eval.py writes the float it scored at; re-run it to regenerate the file."
        ) from None

    if recorded_threshold_value != float(threshold):
        raise SystemExit(
            f"--eval-json {eval_json_path} was measured at score threshold {recorded_threshold}, "
            f"but this manifest ships {threshold} as its default. Re-score at the shipped threshold, "
            "or publish the threshold that was scored."
        )


def resolve_eval(
    args: argparse.Namespace,
    *,
    config_name: str,
    threshold: float,
    published_filenames: set[str],
) -> dict[str, Any] | None:
    """Pick the manifest's eval numbers out of --eval-json.

    Accepts a manifest-shaped file (the keys already named as EVAL_KEYS) or, more
    usually, an eval.py results file, whose own key names are mapped through
    EVAL_SOURCE_PATHS. An eval.py-shaped file also has its provenance checked
    against this publish (see check_eval_provenance) and contributes its `split` to
    the manifest, so a reader can tell a held-out number from a tune-sweep one.
    Matching nothing is an error rather than a manifest that quietly ships with no
    `eval` section at all.
    """
    if not args.eval_json:
        return None
    loaded = json.loads(Path(args.eval_json).read_text())
    if not isinstance(loaded, dict):
        raise SystemExit(f"--eval-json {args.eval_json} must contain a JSON object")

    picked: dict[str, Any] = {}
    mapped_from_eval_py = False
    for key in EVAL_KEYS:
        if key in loaded:
            picked[key] = loaded[key]
            continue
        if key not in EVAL_SOURCE_PATHS:
            continue
        dotted_path = EVAL_SOURCE_PATHS[key]
        from_eval_py = _dig(loaded, dotted_path)
        if from_eval_py is _ABSENT:
            continue
        mapped_from_eval_py = True
        if from_eval_py is None:
            # eval.py writes null for a rate it could not compute (no holds in the
            # split). Publishing that as a number, or silently dropping it, would
            # both misrepresent the run - so say which key and why.
            raise SystemExit(
                f"--eval-json {args.eval_json} has {'.'.join(dotted_path)} set to null, which eval.py "
                f"writes when it had no holds to score. Re-score on a split with labelled holds, or "
                f"drop --eval-json rather than publish {key} as unknown."
            )
        picked[key] = from_eval_py

    if not picked:
        readable = ", ".join(
            f"{key} (or {'.'.join(EVAL_SOURCE_PATHS[key])})" if key in EVAL_SOURCE_PATHS else key
            for key in EVAL_KEYS
        )
        raise SystemExit(
            f"--eval-json {args.eval_json} has none of the keys the manifest can carry: {readable}. "
            "Pass an eval.py results file (.data/artifacts/<config>/eval.json), or drop --eval-json."
        )

    if mapped_from_eval_py:
        check_eval_provenance(
            loaded,
            args.eval_json,
            config_name=config_name,
            threshold=threshold,
            published_filenames=published_filenames,
        )
        picked["split"] = str(loaded["split"]) if loaded.get("split") else "unknown"
    return picked


def resolve_files(config: ConfigInfo, args: argparse.Namespace) -> tuple[list[dict[str, Any]], dict[str, Path]]:
    model_dir = Path(args.model_dir) if args.model_dir else (HOLDS_DIR / ".data" / "artifacts" / config.name)

    int8_path = Path(args.int8_model) if args.int8_model else (model_dir / INT8_FILENAME)
    if not int8_path.exists():
        raise SystemExit(f"no int8 export at {int8_path}; run export.py --shrink int8 first (or pass --int8-model)")

    files: list[dict[str, Any]] = [
        {
            "path": INT8_FILENAME,
            "bytes": int8_path.stat().st_size,
            "sha256": sha256_file(int8_path),
            "dtype": "int8",
        }
    ]
    sources: dict[str, Path] = {INT8_FILENAME: int8_path}

    if args.include_fp32:
        fp32_path = Path(args.fp32_model) if args.fp32_model else (model_dir / FP32_FILENAME)
        if not fp32_path.exists():
            raise SystemExit(f"no fp32 export at {fp32_path}; run export.py first (or pass --fp32-model)")
        files.append(
            {
                "path": FP32_FILENAME,
                "bytes": fp32_path.stat().st_size,
                "sha256": sha256_file(fp32_path),
                "dtype": "fp32",
            }
        )
        sources[FP32_FILENAME] = fp32_path

    return files, sources


# --------------------------------------------------------------------------- #
# Dry run (local filesystem)
# --------------------------------------------------------------------------- #


def write_dry_run(out_dir: Path, manifest: dict[str, Any], sources: dict[str, Path], force: bool) -> None:
    existing = [path for path in (out_dir / MANIFEST_FILENAME, *(out_dir / name for name in sources)) if path.exists()]
    if existing and not force:
        raise SystemExit(
            f"refusing to overwrite existing dry-run output (use --force): " + ", ".join(str(path) for path in existing)
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    for name, source in sources.items():
        shutil.copy2(source, out_dir / name)
    (out_dir / MANIFEST_FILENAME).write_text(json.dumps(manifest, indent=2) + "\n")


# --------------------------------------------------------------------------- #
# Real upload (boto3 - imported lazily so dry runs never need it installed)
# --------------------------------------------------------------------------- #


def build_s3_client(bucket: MediaBucketConfig) -> Any:
    """Construct the S3 client for the media bucket. boto3 is imported lazily so a
    dry run never needs it installed, and so tests can inject a fake instead."""
    import boto3
    from botocore.client import Config as BotoConfig

    client_kwargs: dict[str, Any] = {
        "region_name": bucket.region,
        "aws_access_key_id": bucket.access_key_id,
        "aws_secret_access_key": bucket.secret_access_key,
    }
    if bucket.endpoint_url:
        client_kwargs["endpoint_url"] = bucket.endpoint_url
    if bucket.force_path_style:
        client_kwargs["config"] = BotoConfig(s3={"addressing_style": "path"})

    return boto3.client("s3", **client_kwargs)


def head_object_or_none(client: Any, bucket_name: str, key: str) -> dict[str, Any] | None:
    """The object's head, or None when it does not exist. Any other error raises:
    a 403 from a bad credential must not read as "nothing published here yet"."""
    from botocore.exceptions import ClientError

    try:
        return client.head_object(Bucket=bucket_name, Key=key)
    except ClientError as error:
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if status == 404:
            return None
        raise


WEIGHT_CACHE_CONTROL = "public, max-age=31536000, immutable"
WEIGHT_CONTENT_TYPE = "application/octet-stream"


def remote_sha256(client: Any, bucket_name: str, key: str) -> str:
    """Hash a published object by downloading it to a temp file.

    Only reached for weights uploaded before this script stamped a sha256 on them.
    The bytes go to a temp file rather than memory because an fp32 export is over
    100 MB.
    """
    print(f"no sha256 metadata on {key} - hashing the published bytes", file=sys.stderr)
    with tempfile.NamedTemporaryFile(prefix="published-weight-", suffix=".onnx") as handle:
        client.download_file(bucket_name, key, handle.name)
        return sha256_file(Path(handle.name))


def stamp_weight_checksum(client: Any, bucket: MediaBucketConfig, key: str, sha256: str) -> None:
    """Record a sha256 on an already-published weight object without changing its bytes.

    A same-key copy with MetadataDirective=REPLACE rewrites only the metadata, so the
    object keeps serving the identical bytes (and the identical immutable cache
    headers, which must be restated because REPLACE drops anything not resent).
    """
    copy_kwargs: dict[str, Any] = {
        "Bucket": bucket.bucket_name,
        "Key": key,
        "CopySource": {"Bucket": bucket.bucket_name, "Key": key},
        "MetadataDirective": "REPLACE",
        "Metadata": {"sha256": sha256},
        "ContentType": WEIGHT_CONTENT_TYPE,
        "CacheControl": WEIGHT_CACHE_CONTROL,
    }
    if not bucket.disable_acl:
        copy_kwargs["ACL"] = "public-read"
    client.copy_object(**copy_kwargs)
    print(f"stamped sha256 metadata on {key} (bytes unchanged)", file=sys.stderr)


def upload(
    bucket: MediaBucketConfig,
    version: str,
    manifest: dict[str, Any],
    sources: dict[str, Path],
    force: bool,
    client: Any | None = None,
) -> None:
    """Publish the weights and then the manifest for one version.

    `--force` (the `force` argument) applies to the MANIFEST ONLY. Weight files are
    served `public, max-age=31536000, immutable`, so a CDN or a phone that already
    has `models/hold-detector/<version>/model-int8.onnx` will keep serving those
    bytes for a year no matter what we re-upload - and the new manifest's sha256
    would no longer match them. So the weight check runs whether or not --force was
    passed: an already-published file with the same sha256 is skipped, and one with
    different bytes is a hard error telling the publisher to bump --version.
    """
    if client is None:
        client = build_s3_client(bucket)

    prefix = f"{MODEL_KEY_PREFIX}/{version}"
    weight_keys = {name: f"{prefix}/{name}" for name in sources}
    manifest_key = f"{prefix}/{MANIFEST_FILENAME}"
    checksums = {entry["path"]: str(entry["sha256"]) for entry in manifest["files"]}

    already_published: set[str] = set()
    for name, key in weight_keys.items():
        head = head_object_or_none(client, bucket.bucket_name, key)
        if head is None:
            continue
        published_sha256 = (head.get("Metadata") or {}).get("sha256")
        if published_sha256 is None:
            # Uploaded before this script stamped a checksum: hash the remote bytes
            # once rather than refuse. Identical bytes get the metadata stamped in
            # place (a same-key copy, so the published bytes never change), which
            # keeps the manifest-repair path open for those older versions.
            published_sha256 = remote_sha256(client, bucket.bucket_name, key)
            if published_sha256 == checksums[name]:
                stamp_weight_checksum(client, bucket, key, published_sha256)
        if published_sha256 == checksums[name]:
            already_published.add(name)
            print(f"already published, identical bytes - skipping {key}", file=sys.stderr)
            continue
        raise SystemExit(
            f"s3://{bucket.bucket_name}/{key} already exists and is not the file being published "
            f"(published sha256 {published_sha256 or 'unknown'}, local {checksums[name]}). "
            "Weights are immutable per version - they are served with a one-year immutable "
            "cache, so replacing them would leave cached clients checksumming against the new "
            "manifest and failing. Publish under a new --version instead; --force only replaces "
            "the manifest."
        )

    if not force and head_object_or_none(client, bucket.bucket_name, manifest_key) is not None:
        raise SystemExit(f"refusing to overwrite existing s3://{bucket.bucket_name}/{manifest_key} (use --force)")

    acl_kwargs: dict[str, str] = {} if bucket.disable_acl else {"ACL": "public-read"}

    # Weights first, manifest last - a reader can never see a manifest pointing
    # at a weight file that hasn't landed yet, and weights are immutable per
    # version so re-running after a partial failure is always safe.
    for name, source in sources.items():
        if name in already_published:
            continue
        client.upload_file(
            str(source),
            bucket.bucket_name,
            weight_keys[name],
            ExtraArgs={
                "ContentType": WEIGHT_CONTENT_TYPE,
                "CacheControl": WEIGHT_CACHE_CONTROL,
                # The checksum the next publish compares against, so an identical
                # re-run can skip the upload and a differing one can refuse it.
                "Metadata": {"sha256": checksums[name]},
                **acl_kwargs,
            },
        )

    manifest_body = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    client.put_object(
        Bucket=bucket.bucket_name,
        Key=manifest_key,
        Body=manifest_body,
        ContentType="application/json",
        CacheControl="public, max-age=300",
        **acl_kwargs,
    )


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", required=True, help="config name from configs.json, e.g. nano-tiled-1024")
    parser.add_argument(
        "--version", required=True, help="the R2 prefix models/hold-detector/<version>/ - semver or a date tag"
    )

    parser.add_argument("--model-dir", help="directory holding the exported ONNX files (default: .data/artifacts/<config>)")
    parser.add_argument("--int8-model", help="explicit path to the int8 ONNX (default: <model-dir>/model-int8.onnx)")
    parser.add_argument("--fp32-model", help="explicit path to the fp32 ONNX (default: <model-dir>/model.onnx)")
    parser.add_argument("--include-fp32", action="store_true", help="also publish the fp32 weights")

    parser.add_argument(
        "--threshold", type=float, help="default score threshold shipped in the manifest (default: the config's own score_threshold)"
    )
    parser.add_argument("--sweep", default="", help="comma-separated thresholds tried during calibration, e.g. 0.05,0.08,0.12,0.2")

    parser.add_argument("--dataset", help="training dataset description")
    parser.add_argument("--training-licence", help="licence of the training data, e.g. 'CC BY 4.0'")
    parser.add_argument("--epochs", type=float, help="epochs actually trained")
    parser.add_argument("--trained-on", choices=["m5-max-mps", "cpu"], help="hardware the training run used")
    parser.add_argument("--date", help="ISO date the export was trained/produced, e.g. 2026-09-15")
    parser.add_argument(
        "--training-json", help="JSON file with the whole 'training' object; the flags above override its keys when also given"
    )
    parser.add_argument(
        "--eval-json",
        help=f"JSON file supplying any of {', '.join(EVAL_KEYS)}; omitted keys are left out of the manifest",
    )

    parser.add_argument("--out-dir", help="local directory the dry run writes to (default: .data/publish/<config>/<version>)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=None,
        help="write locally instead of uploading; on by default when the MEDIA_* R2 env vars are absent",
    )
    parser.add_argument("--force", action="store_true", help="overwrite an existing published/written version")

    # Test seam - not documented in --help output above the parser's own listing.
    parser.add_argument("--configs-path", default=str(DEFAULT_CONFIGS_PATH), help=argparse.SUPPRESS)

    args = parser.parse_args(argv)
    # --version becomes both an R2 key prefix and a local directory name, so
    # anything with a slash or a leading dot could publish outside
    # models/hold-detector/ or, in dry-run mode, write outside .data/publish/.
    if not VERSION_PATTERN.match(args.version):
        parser.error(
            f"--version {args.version!r} must match {VERSION_PATTERN.pattern} - it is a path segment "
            "(the R2 prefix models/hold-detector/<version>/ and the dry-run directory name), "
            "e.g. 1.2.0 or 2026.09.15"
        )
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    config = load_config_info(args.config, Path(args.configs_path))
    threshold = args.threshold if args.threshold is not None else config.score_threshold
    sweep = [float(value) for value in args.sweep.split(",") if value.strip()]

    training = resolve_training(args)
    files, sources = resolve_files(config, args)
    eval_metrics = resolve_eval(
        args,
        config_name=config.name,
        threshold=threshold,
        published_filenames=set(sources),
    )

    manifest = build_manifest(
        config=config,
        version=args.version,
        files=files,
        threshold=threshold,
        sweep=sweep,
        training=training,
        eval_metrics=eval_metrics,
    )
    validate_manifest(manifest)

    bucket = read_media_bucket_config()
    dry_run = args.dry_run if args.dry_run is not None else bucket is None
    if not dry_run and bucket is None:
        raise SystemExit(
            "no MEDIA_* R2 env vars found; pass --dry-run explicitly, or set MEDIA_S3_BUCKET_NAME / "
            "MEDIA_AWS_ACCESS_KEY_ID / MEDIA_AWS_SECRET_ACCESS_KEY (docs/user-media-storage.md)"
        )

    print(json.dumps(manifest, indent=2))

    if dry_run:
        out_dir = Path(args.out_dir) if args.out_dir else (HOLDS_DIR / ".data" / "publish" / config.name / args.version)
        write_dry_run(out_dir, manifest, sources, args.force)
        print(f"\n[dry-run] wrote {out_dir}", file=sys.stderr)
        print(f"[dry-run] would publish to {MODEL_KEY_PREFIX}/{args.version}/ in the media bucket", file=sys.stderr)
        return 0

    assert bucket is not None  # narrowed by the check above
    print(describe_bucket_config(bucket), file=sys.stderr)
    upload(bucket, args.version, manifest, sources, args.force)
    print(f"\npublished s3://{bucket.bucket_name}/{MODEL_KEY_PREFIX}/{args.version}/", file=sys.stderr)
    if bucket.public_base_url:
        print(f"manifest: {bucket.public_base_url}/{MODEL_KEY_PREFIX}/{args.version}/{MANIFEST_FILENAME}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

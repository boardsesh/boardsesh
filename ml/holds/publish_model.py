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
import shutil
import sys
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

# RF-DETR is pretrained on ImageNet-normalised inputs; eval.py's OnnxDetector
# uses these exact constants (ml/holds/eval.py, OnnxDetector.__init__).
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]

EVAL_KEYS = ("sprayEvalF1", "weightedCorrectionsPerHold", "gestureSavings")


# --------------------------------------------------------------------------- #
# configs.json
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ConfigInfo:
    name: str
    family: str
    resolution: int
    score_threshold: float


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
        "thresholds": {"default": threshold, "sweep": sweep},
        "files": files,
        "training": training,
        "licence": "Apache-2.0",
    }
    if eval_metrics:
        manifest["eval"] = eval_metrics
    return manifest


def validate_manifest(manifest: dict[str, Any]) -> None:
    import jsonschema

    schema = json.loads(SCHEMA_PATH.read_text())
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
    missing = [key for key in required if not training.get(key) and training.get(key) != 0]
    if missing:
        raise SystemExit(
            "missing training metadata: "
            + ", ".join(missing)
            + " - pass --dataset/--training-licence/--epochs/--trained-on/--date, or --training-json"
        )
    return training


def resolve_eval(args: argparse.Namespace) -> dict[str, Any] | None:
    if not args.eval_json:
        return None
    loaded = json.loads(Path(args.eval_json).read_text())
    if not isinstance(loaded, dict):
        raise SystemExit(f"--eval-json {args.eval_json} must contain a JSON object")
    picked = {key: loaded[key] for key in EVAL_KEYS if key in loaded}
    return picked or None


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


def upload(bucket: MediaBucketConfig, version: str, manifest: dict[str, Any], sources: dict[str, Path], force: bool) -> None:
    import boto3
    from botocore.client import Config as BotoConfig
    from botocore.exceptions import ClientError

    client_kwargs: dict[str, Any] = {
        "region_name": bucket.region,
        "aws_access_key_id": bucket.access_key_id,
        "aws_secret_access_key": bucket.secret_access_key,
    }
    if bucket.endpoint_url:
        client_kwargs["endpoint_url"] = bucket.endpoint_url
    if bucket.force_path_style:
        client_kwargs["config"] = BotoConfig(s3={"addressing_style": "path"})

    client = boto3.client("s3", **client_kwargs)
    prefix = f"{MODEL_KEY_PREFIX}/{version}"
    weight_keys = {name: f"{prefix}/{name}" for name in sources}
    manifest_key = f"{prefix}/{MANIFEST_FILENAME}"

    if not force:
        for key in (*weight_keys.values(), manifest_key):
            try:
                client.head_object(Bucket=bucket.bucket_name, Key=key)
            except ClientError as error:
                status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
                if status == 404:
                    continue
                raise
            else:
                raise SystemExit(f"refusing to overwrite existing s3://{bucket.bucket_name}/{key} (use --force)")

    acl_kwargs: dict[str, str] = {} if bucket.disable_acl else {"ACL": "public-read"}

    # Weights first, manifest last - a reader can never see a manifest pointing
    # at a weight file that hasn't landed yet, and weights are immutable per
    # version so re-running after a partial failure is always safe.
    for name, source in sources.items():
        client.upload_file(
            str(source),
            bucket.bucket_name,
            weight_keys[name],
            ExtraArgs={
                "ContentType": "application/octet-stream",
                "CacheControl": "public, max-age=31536000, immutable",
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

    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    config = load_config_info(args.config, Path(args.configs_path))
    threshold = args.threshold if args.threshold is not None else config.score_threshold
    sweep = [float(value) for value in args.sweep.split(",") if value.strip()]

    training = resolve_training(args)
    eval_metrics = resolve_eval(args)
    files, sources = resolve_files(config, args)

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

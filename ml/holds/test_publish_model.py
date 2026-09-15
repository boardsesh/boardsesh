"""Tests for publish_model.py (SW-01, issue #5434).

Runs entirely with --dry-run against the real spike int8 ONNX export, so it
never needs R2 credentials, boto3, torch, or onnxruntime. Covers the tree layout
a consumer downloads, sha256 correctness, schema validity, and the
refuse-to-overwrite behaviour.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import jsonschema
import pytest

import publish_model

# A real exported int8 model, produced by a prior harness run in a sibling
# worktree. Read-only: tests never write here, only copy from it.
SAMPLE_MODEL_ENV = "PUBLISH_MODEL_TEST_ONNX"
DEFAULT_SAMPLE_MODEL = Path(
    "/home/developer/projects/boardsesh/.bare/.claude/worktrees/sw01-spike/ml/holds/.data/artifacts/nano-tiled-1024/model-int8.onnx"
)


def _sample_model_path() -> Path:
    override = os.environ.get(SAMPLE_MODEL_ENV)
    return Path(override) if override else DEFAULT_SAMPLE_MODEL


SAMPLE_MODEL = _sample_model_path()
requires_sample_model = pytest.mark.skipif(
    not SAMPLE_MODEL.exists(), reason=f"no sample ONNX at {SAMPLE_MODEL} (set {SAMPLE_MODEL_ENV} to override)"
)

CONFIG_NAME = "nano-tiled-1024"


def _run_publish(
    tmp_path: Path,
    *,
    version: str = "2026.09.15",
    extra_args: list[str] | None = None,
    out_dir: Path | None = None,
) -> Path:
    """Invoke publish_model.main() in --dry-run mode; returns the out_dir used."""
    resolved_out_dir = out_dir or (tmp_path / "publish-out")
    args = [
        "--config",
        CONFIG_NAME,
        "--version",
        version,
        "--int8-model",
        str(SAMPLE_MODEL),
        "--dry-run",
        "--out-dir",
        str(resolved_out_dir),
        "--dataset",
        "Roboflow climbing-holds-and-volumes v14, 600 photos",
        "--training-licence",
        "CC BY 4.0",
        "--epochs",
        "1",
        "--trained-on",
        "cpu",
        "--date",
        "2026-09-14",
        "--threshold",
        "0.2",
        "--sweep",
        "0.05,0.08,0.12,0.2",
    ]
    if extra_args:
        args.extend(extra_args)

    exit_code = publish_model.main(args)
    assert exit_code == 0
    return resolved_out_dir


@requires_sample_model
def test_dry_run_writes_expected_tree(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out_dir = _run_publish(tmp_path)

    manifest_path = out_dir / "manifest.json"
    weights_path = out_dir / "model-int8.onnx"
    assert manifest_path.exists()
    assert weights_path.exists()
    # Nothing else should have been written - this is exactly the tree a real
    # upload would produce under models/hold-detector/<version>/.
    assert sorted(path.name for path in out_dir.iterdir()) == ["manifest.json", "model-int8.onnx"]

    printed = capsys.readouterr().out
    manifest = json.loads(printed)
    assert manifest["version"] == "2026.09.15"
    assert manifest["config"] == CONFIG_NAME


@requires_sample_model
def test_weights_copy_is_byte_identical(tmp_path: Path) -> None:
    out_dir = _run_publish(tmp_path)
    assert (out_dir / "model-int8.onnx").read_bytes() == SAMPLE_MODEL.read_bytes()


@requires_sample_model
def test_manifest_sha256_matches_the_file_on_disk(tmp_path: Path) -> None:
    out_dir = _run_publish(tmp_path)
    manifest = json.loads((out_dir / "manifest.json").read_text())

    files_by_path = {entry["path"]: entry for entry in manifest["files"]}
    assert set(files_by_path) == {"model-int8.onnx"}

    entry = files_by_path["model-int8.onnx"]
    assert entry["dtype"] == "int8"
    assert entry["bytes"] == (out_dir / "model-int8.onnx").stat().st_size

    hasher = hashlib.sha256()
    hasher.update((out_dir / "model-int8.onnx").read_bytes())
    assert entry["sha256"] == hasher.hexdigest()


@requires_sample_model
def test_manifest_contents_match_the_contract(tmp_path: Path) -> None:
    out_dir = _run_publish(tmp_path)
    manifest = json.loads((out_dir / "manifest.json").read_text())

    assert manifest["schemaVersion"] == 1
    assert manifest["family"] == "rfdetr"
    assert manifest["licence"] == "Apache-2.0"

    assert manifest["input"]["width"] == 384
    assert manifest["input"]["height"] == 384
    assert manifest["input"]["layout"] == "NCHW"
    assert manifest["input"]["dtype"] == "float32"
    assert manifest["input"]["letterbox"] == "stretch"
    assert manifest["input"]["normalization"]["mean"] == [0.485, 0.456, 0.406]
    assert manifest["input"]["normalization"]["std"] == [0.229, 0.224, 0.225]

    assert manifest["outputs"]["boxes"]["format"] == "cxcywh-normalized"
    assert manifest["outputs"]["boxes"]["name"] is None
    assert manifest["outputs"]["logits"]["activation"] == "sigmoid"
    assert manifest["outputs"]["logits"]["classes"] == 1

    assert manifest["thresholds"]["default"] == 0.2
    assert manifest["thresholds"]["sweep"] == [0.05, 0.08, 0.12, 0.2]

    assert manifest["training"] == {
        "dataset": "Roboflow climbing-holds-and-volumes v14, 600 photos",
        "licence": "CC BY 4.0",
        "epochs": 1.0,
        "trainedOn": "cpu",
        "date": "2026-09-14",
    }


@requires_sample_model
def test_manifest_validates_against_the_schema(tmp_path: Path) -> None:
    out_dir = _run_publish(tmp_path)
    manifest = json.loads((out_dir / "manifest.json").read_text())
    schema = json.loads(publish_model.SCHEMA_PATH.read_text())
    jsonschema.validate(instance=manifest, schema=schema)  # raises on failure


@requires_sample_model
def test_include_fp32_adds_a_second_file(tmp_path: Path) -> None:
    # No real fp32 export is available in the dry-run fixture; point --fp32-model
    # at the same sample file to exercise the two-file path without needing a
    # second 100+ MB artifact checked into a fixture.
    out_dir = _run_publish(
        tmp_path,
        extra_args=["--include-fp32", "--fp32-model", str(SAMPLE_MODEL)],
    )
    manifest = json.loads((out_dir / "manifest.json").read_text())
    paths = {entry["path"]: entry["dtype"] for entry in manifest["files"]}
    assert paths == {"model-int8.onnx": "int8", "model.onnx": "fp32"}
    assert (out_dir / "model.onnx").exists()


@requires_sample_model
def test_eval_json_is_picked_by_known_keys_only(tmp_path: Path) -> None:
    eval_json_path = tmp_path / "eval.json"
    eval_json_path.write_text(
        json.dumps({"sprayEvalF1": 0.559, "weightedCorrectionsPerHold": 0.97, "someOtherThing": "ignored"})
    )
    out_dir = _run_publish(tmp_path, extra_args=["--eval-json", str(eval_json_path)])
    manifest = json.loads((out_dir / "manifest.json").read_text())
    assert manifest["eval"] == {"sprayEvalF1": 0.559, "weightedCorrectionsPerHold": 0.97}


@requires_sample_model
def test_second_publish_refuses_to_overwrite(tmp_path: Path) -> None:
    out_dir = tmp_path / "publish-out"
    _run_publish(tmp_path, out_dir=out_dir)

    with pytest.raises(SystemExit, match="refusing to overwrite"):
        _run_publish(tmp_path, out_dir=out_dir)


@requires_sample_model
def test_force_allows_overwrite(tmp_path: Path) -> None:
    out_dir = tmp_path / "publish-out"
    _run_publish(tmp_path, out_dir=out_dir)
    # Should not raise the second time with --force.
    _run_publish(tmp_path, out_dir=out_dir, extra_args=["--force"])
    assert (out_dir / "manifest.json").exists()


@requires_sample_model
def test_missing_training_metadata_is_a_clear_error(tmp_path: Path) -> None:
    args = [
        "--config",
        CONFIG_NAME,
        "--version",
        "2026.09.15",
        "--int8-model",
        str(SAMPLE_MODEL),
        "--dry-run",
        "--out-dir",
        str(tmp_path / "publish-out"),
    ]
    with pytest.raises(SystemExit, match="missing training metadata"):
        publish_model.main(args)


def test_load_config_info_rejects_unknown_config() -> None:
    with pytest.raises(SystemExit, match="unknown config"):
        publish_model.load_config_info("not-a-real-config")


def test_read_media_bucket_config_is_none_without_env() -> None:
    assert publish_model.read_media_bucket_config({}) is None


def test_read_media_bucket_config_requires_credentials_together() -> None:
    with pytest.raises(SystemExit, match="MEDIA_AWS_ACCESS_KEY_ID"):
        publish_model.read_media_bucket_config({"MEDIA_S3_BUCKET_NAME": "boardsesh-user-media"})


def test_read_media_bucket_config_defaults_r2_to_no_acl() -> None:
    bucket = publish_model.read_media_bucket_config(
        {
            "MEDIA_S3_BUCKET_NAME": "boardsesh-user-media",
            "MEDIA_AWS_ACCESS_KEY_ID": "key",
            "MEDIA_AWS_SECRET_ACCESS_KEY": "secret",
            "MEDIA_AWS_ENDPOINT_URL": "https://abc123.r2.cloudflarestorage.com",
        }
    )
    assert bucket is not None
    assert bucket.disable_acl is True


def test_describe_bucket_config_never_includes_credentials() -> None:
    bucket = publish_model.read_media_bucket_config(
        {
            "MEDIA_S3_BUCKET_NAME": "boardsesh-user-media",
            "MEDIA_AWS_ACCESS_KEY_ID": "super-secret-key-id",
            "MEDIA_AWS_SECRET_ACCESS_KEY": "super-secret-access-key",
            "MEDIA_PUBLIC_BASE_URL": "https://media.boardsesh.com",
        }
    )
    assert bucket is not None
    description = publish_model.describe_bucket_config(bucket)
    assert "super-secret-key-id" not in description
    assert "super-secret-access-key" not in description

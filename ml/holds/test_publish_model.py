"""Tests for publish_model.py (SW-01, issue #5434).

The dry-run tests run against a synthesized stand-in for the int8 export: nothing
here parses the ONNX, only copies and hashes it, so a few KB of bytes in `tmp_path`
exercise exactly the same code a 30 MB export does — and every test runs on any
machine, which a path into one developer's `.data/artifacts/` did not. Point
`PUBLISH_MODEL_TEST_ONNX` at a real export to run them against one.

The upload tests inject a recording fake S3 client, so they never need R2
credentials or a network — only botocore's ClientError type.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from botocore.exceptions import ClientError

import publish_model

SAMPLE_MODEL_ENV = "PUBLISH_MODEL_TEST_ONNX"

CONFIG_NAME = "nano-tiled-1024"
VERSION = "2026.09.15"


@pytest.fixture
def sample_model(tmp_path: Path) -> Path:
    """A stand-in for an exported int8 ONNX file.

    publish_model.py treats the weights as opaque bytes — it stats them, hashes
    them and copies/uploads them — so the contents only have to be deterministic
    and non-empty, not a valid ONNX graph.
    """
    override = os.environ.get(SAMPLE_MODEL_ENV)
    if override:
        return Path(override)
    path = tmp_path / "sample" / "model-int8.onnx"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"not-a-real-onnx-graph\n" + bytes(range(256)) * 16)
    return path


def _run_publish(
    tmp_path: Path,
    sample_model: Path,
    *,
    version: str = VERSION,
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
        str(sample_model),
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


def test_the_sample_model_is_not_a_machine_specific_path() -> None:
    """The fixture must synthesize its input, not read one developer's worktree.

    A hardcoded absolute path made 10 of these tests skip — with pytest still
    exiting 0 — the moment that worktree was disposed of.
    """
    source = Path(__file__).read_text()
    # Split so the needles are not themselves matched in this file's own source.
    assert "/home" + "/" not in source
    assert "/User" + "s/" not in source  # the macOS spelling of the same mistake
    assert "skip" + "if" not in source


def test_dry_run_writes_expected_tree(
    tmp_path: Path, sample_model: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out_dir = _run_publish(tmp_path, sample_model)

    manifest_path = out_dir / "manifest.json"
    weights_path = out_dir / "model-int8.onnx"
    assert manifest_path.exists()
    assert weights_path.exists()
    # Nothing else should have been written - this is exactly the tree a real
    # upload would produce under models/hold-detector/<version>/.
    assert sorted(path.name for path in out_dir.iterdir()) == ["manifest.json", "model-int8.onnx"]

    printed = capsys.readouterr().out
    manifest = json.loads(printed)
    assert manifest["version"] == VERSION
    assert manifest["config"] == CONFIG_NAME


def test_weights_copy_is_byte_identical(tmp_path: Path, sample_model: Path) -> None:
    out_dir = _run_publish(tmp_path, sample_model)
    assert (out_dir / "model-int8.onnx").read_bytes() == sample_model.read_bytes()


def test_manifest_sha256_matches_the_file_on_disk(tmp_path: Path, sample_model: Path) -> None:
    out_dir = _run_publish(tmp_path, sample_model)
    manifest = json.loads((out_dir / "manifest.json").read_text())

    files_by_path = {entry["path"]: entry for entry in manifest["files"]}
    assert set(files_by_path) == {"model-int8.onnx"}

    entry = files_by_path["model-int8.onnx"]
    assert entry["dtype"] == "int8"
    assert entry["bytes"] == (out_dir / "model-int8.onnx").stat().st_size

    hasher = hashlib.sha256()
    hasher.update((out_dir / "model-int8.onnx").read_bytes())
    assert entry["sha256"] == hasher.hexdigest()


def test_manifest_contents_match_the_contract(tmp_path: Path, sample_model: Path) -> None:
    out_dir = _run_publish(tmp_path, sample_model)
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


def test_manifest_validates_against_the_schema(tmp_path: Path, sample_model: Path) -> None:
    out_dir = _run_publish(tmp_path, sample_model)
    manifest = json.loads((out_dir / "manifest.json").read_text())
    schema = json.loads(publish_model.SCHEMA_PATH.read_text())
    jsonschema.validate(instance=manifest, schema=schema)  # raises on failure


def test_schema_rejects_an_unknown_input_or_file_key(tmp_path: Path, sample_model: Path) -> None:
    """`input` and each `files` entry are closed: a typo'd key must not pass."""
    out_dir = _run_publish(tmp_path, sample_model)
    manifest = json.loads((out_dir / "manifest.json").read_text())
    schema = json.loads(publish_model.SCHEMA_PATH.read_text())

    manifest["input"]["letterboxing"] = "stretch"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=manifest, schema=schema)

    del manifest["input"]["letterboxing"]
    manifest["files"][0]["checksum"] = "deadbeef"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=manifest, schema=schema)


def test_include_fp32_adds_a_second_file(tmp_path: Path, sample_model: Path) -> None:
    # Point --fp32-model at the same sample file to exercise the two-file path
    # without a second fixture; publish_model.py never inspects the contents.
    out_dir = _run_publish(
        tmp_path,
        sample_model,
        extra_args=["--include-fp32", "--fp32-model", str(sample_model)],
    )
    manifest = json.loads((out_dir / "manifest.json").read_text())
    paths = {entry["path"]: entry["dtype"] for entry in manifest["files"]}
    assert paths == {"model-int8.onnx": "int8", "model.onnx": "fp32"}
    assert (out_dir / "model.onnx").exists()


def test_eval_json_is_picked_by_known_keys_only(tmp_path: Path, sample_model: Path) -> None:
    eval_json_path = tmp_path / "eval.json"
    eval_json_path.write_text(
        json.dumps({"sprayEvalF1": 0.559, "weightedCorrectionsPerHold": 0.97, "someOtherThing": "ignored"})
    )
    out_dir = _run_publish(tmp_path, sample_model, extra_args=["--eval-json", str(eval_json_path)])
    manifest = json.loads((out_dir / "manifest.json").read_text())
    assert manifest["eval"] == {"sprayEvalF1": 0.559, "weightedCorrectionsPerHold": 0.97}


def _eval_py_results(**overrides: Any) -> dict[str, Any]:
    """An eval.py results file matching what _run_publish publishes."""
    results: dict[str, Any] = {
        "config": CONFIG_NAME,
        "model": f".data/artifacts/{CONFIG_NAME}/model-int8.onnx",
        "split": "eval",
        "score_threshold": 0.2,
        "box": {"precision": 0.514, "recall": 0.612, "f1": 0.559, "tp": 590},
        "correction_rate_micro": 0.97,
        "correction_rate_macro": 1.04,
    }
    results.update(overrides)
    return results


def test_an_eval_py_results_file_populates_the_manifest(tmp_path: Path, sample_model: Path) -> None:
    """eval.py writes box.f1 / correction_rate_micro, not the manifest's own names."""
    eval_json_path = tmp_path / "eval.json"
    eval_json_path.write_text(json.dumps(_eval_py_results()))
    out_dir = _run_publish(tmp_path, sample_model, extra_args=["--eval-json", str(eval_json_path)])
    manifest = json.loads((out_dir / "manifest.json").read_text())
    assert manifest["eval"] == {
        "sprayEvalF1": 0.559,
        "weightedCorrectionsPerHold": 0.97,
        # Which half the numbers came from: `eval` is held out, `tune` is where the
        # threshold was chosen.
        "split": "eval",
    }
    schema = json.loads(publish_model.SCHEMA_PATH.read_text())
    jsonschema.validate(instance=manifest, schema=schema)


def test_an_eval_json_for_another_config_is_refused(tmp_path: Path, sample_model: Path) -> None:
    eval_json_path = tmp_path / "eval.json"
    eval_json_path.write_text(json.dumps(_eval_py_results(config="medium-untiled-1280")))
    with pytest.raises(SystemExit, match="medium-untiled-1280"):
        _run_publish(tmp_path, sample_model, extra_args=["--eval-json", str(eval_json_path)])


def test_an_eval_json_at_another_threshold_is_refused(tmp_path: Path, sample_model: Path) -> None:
    """A tune-sweep run must not be published as the shipped default's result."""
    eval_json_path = tmp_path / "eval.json"
    eval_json_path.write_text(json.dumps(_eval_py_results(score_threshold=0.05, split="tune")))
    with pytest.raises(SystemExit, match="score threshold 0.05"):
        _run_publish(tmp_path, sample_model, extra_args=["--eval-json", str(eval_json_path)])


def test_an_eval_json_scored_on_another_artifact_is_refused(tmp_path: Path, sample_model: Path) -> None:
    eval_json_path = tmp_path / "eval.json"
    eval_json_path.write_text(json.dumps(_eval_py_results(model=f".data/artifacts/{CONFIG_NAME}/model-fp16.onnx")))
    with pytest.raises(SystemExit, match="not one of"):
        _run_publish(tmp_path, sample_model, extra_args=["--eval-json", str(eval_json_path)])


def test_an_eval_py_file_missing_its_provenance_is_refused(tmp_path: Path, sample_model: Path) -> None:
    results = _eval_py_results()
    del results["model"]
    del results["score_threshold"]
    eval_json_path = tmp_path / "eval.json"
    eval_json_path.write_text(json.dumps(results))
    with pytest.raises(SystemExit, match="does not record model, score_threshold"):
        _run_publish(tmp_path, sample_model, extra_args=["--eval-json", str(eval_json_path)])


def test_a_null_provenance_field_says_null_not_missing(tmp_path: Path, sample_model: Path) -> None:
    eval_json_path = tmp_path / "eval.json"
    eval_json_path.write_text(json.dumps(_eval_py_results(config=None)))
    with pytest.raises(SystemExit, match="has config set to null"):
        _run_publish(tmp_path, sample_model, extra_args=["--eval-json", str(eval_json_path)])


def test_a_non_numeric_score_threshold_is_a_clear_error(tmp_path: Path, sample_model: Path) -> None:
    eval_json_path = tmp_path / "eval.json"
    eval_json_path.write_text(json.dumps(_eval_py_results(score_threshold="low")))
    with pytest.raises(SystemExit, match="score_threshold 'low', which is not a number"):
        _run_publish(tmp_path, sample_model, extra_args=["--eval-json", str(eval_json_path)])


def test_a_null_correction_rate_is_refused_rather_than_dropped(tmp_path: Path, sample_model: Path) -> None:
    """eval.py writes null when it had no holds to score; publishing that is a lie."""
    eval_json_path = tmp_path / "eval.json"
    eval_json_path.write_text(json.dumps(_eval_py_results(correction_rate_micro=None)))
    with pytest.raises(SystemExit, match="correction_rate_micro set to null"):
        _run_publish(tmp_path, sample_model, extra_args=["--eval-json", str(eval_json_path)])


def test_an_eval_json_with_no_usable_keys_is_an_error(tmp_path: Path, sample_model: Path) -> None:
    """Silently publishing a manifest with no `eval` section is the bug being fixed."""
    eval_json_path = tmp_path / "eval.json"
    eval_json_path.write_text(json.dumps({"latency_seconds": {"p50": 0.5}, "photos": 10}))
    with pytest.raises(SystemExit, match="none of the keys the manifest can carry"):
        _run_publish(tmp_path, sample_model, extra_args=["--eval-json", str(eval_json_path)])


def test_second_publish_refuses_to_overwrite(tmp_path: Path, sample_model: Path) -> None:
    out_dir = tmp_path / "publish-out"
    _run_publish(tmp_path, sample_model, out_dir=out_dir)

    with pytest.raises(SystemExit, match="refusing to overwrite"):
        _run_publish(tmp_path, sample_model, out_dir=out_dir)


def test_force_allows_overwrite(tmp_path: Path, sample_model: Path) -> None:
    out_dir = tmp_path / "publish-out"
    _run_publish(tmp_path, sample_model, out_dir=out_dir)
    # Should not raise the second time with --force.
    _run_publish(tmp_path, sample_model, out_dir=out_dir, extra_args=["--force"])
    assert (out_dir / "manifest.json").exists()


def test_missing_training_metadata_is_a_clear_error(tmp_path: Path, sample_model: Path) -> None:
    args = [
        "--config",
        CONFIG_NAME,
        "--version",
        VERSION,
        "--int8-model",
        str(sample_model),
        "--dry-run",
        "--out-dir",
        str(tmp_path / "publish-out"),
    ]
    with pytest.raises(SystemExit, match="missing training metadata"):
        publish_model.main(args)


def test_a_boolean_epoch_count_is_a_clear_error(tmp_path: Path, sample_model: Path) -> None:
    """`False` == 0, so a falsy-but-not-zero test used to let it reach jsonschema."""
    training_json = tmp_path / "training.json"
    training_json.write_text(
        json.dumps(
            {
                "dataset": "Roboflow climbing-holds-and-volumes v14",
                "licence": "CC BY 4.0",
                "epochs": False,
                "trainedOn": "cpu",
                "date": "2026-09-14",
            }
        )
    )
    args = [
        "--config",
        CONFIG_NAME,
        "--version",
        VERSION,
        "--int8-model",
        str(sample_model),
        "--dry-run",
        "--out-dir",
        str(tmp_path / "publish-out"),
        "--training-json",
        str(training_json),
    ]
    with pytest.raises(SystemExit, match="missing training metadata: epochs"):
        publish_model.main(args)


def test_a_zero_epoch_count_is_still_accepted_as_present() -> None:
    """The 0 the old falsy test was written to allow keeps working."""
    namespace = publish_model.parse_args(
        [
            "--config",
            CONFIG_NAME,
            "--version",
            VERSION,
            "--dataset",
            "Roboflow climbing-holds-and-volumes v14",
            "--training-licence",
            "CC BY 4.0",
            "--epochs",
            "0",
            "--trained-on",
            "cpu",
            "--date",
            "2026-09-14",
        ]
    )
    assert publish_model.resolve_training(namespace)["epochs"] == 0


@pytest.mark.parametrize("bad_version", ["../evil", "a/b", "", ".hidden", "with space"])
def test_version_must_be_one_plain_path_segment(bad_version: str) -> None:
    with pytest.raises(SystemExit):
        publish_model.parse_args(["--config", CONFIG_NAME, "--version", bad_version])


@pytest.mark.parametrize("good_version", ["1.2.0", "2026.09.15", "2026.09.15-test", "v2_final"])
def test_version_accepts_the_documented_tags(good_version: str) -> None:
    parsed = publish_model.parse_args(["--config", CONFIG_NAME, "--version", good_version])
    assert parsed.version == good_version


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


# --------------------------------------------------------------------------- #
# upload() - against an injected recording client, never a real bucket
# --------------------------------------------------------------------------- #

BUCKET_ENV = {
    "MEDIA_S3_BUCKET_NAME": "boardsesh-user-media",
    "MEDIA_AWS_ACCESS_KEY_ID": "key",
    "MEDIA_AWS_SECRET_ACCESS_KEY": "secret",
    "MEDIA_AWS_ENDPOINT_URL": "https://abc123.r2.cloudflarestorage.com",
}
WEIGHT_KEY = f"{publish_model.MODEL_KEY_PREFIX}/{VERSION}/model-int8.onnx"
MANIFEST_KEY = f"{publish_model.MODEL_KEY_PREFIX}/{VERSION}/manifest.json"


class RecordingS3Client:
    """Fake s3 client: records every call, 404s anything not seeded as existing."""

    def __init__(
        self,
        existing: dict[str, dict[str, Any]] | None = None,
        head_status: int | None = None,
        bodies: dict[str, bytes] | None = None,
    ) -> None:
        self.existing = existing or {}
        self.head_status = head_status
        self.bodies = bodies or {}
        self.calls: list[tuple[str, str]] = []
        self.uploads: list[dict[str, Any]] = []
        self.puts: list[dict[str, Any]] = []
        self.copies: list[dict[str, Any]] = []

    def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803 - boto3's own kwarg names
        self.calls.append(("head_object", Key))
        if self.head_status is not None:
            raise ClientError(
                {
                    "Error": {"Code": str(self.head_status)},
                    "ResponseMetadata": {"HTTPStatusCode": self.head_status},
                },
                "HeadObject",
            )
        if Key in self.existing:
            return self.existing[Key]
        raise ClientError(
            {"Error": {"Code": "404"}, "ResponseMetadata": {"HTTPStatusCode": 404}},
            "HeadObject",
        )

    def upload_file(  # noqa: N803 - boto3's own kwarg names
        self, Filename: str, Bucket: str, Key: str, ExtraArgs: dict[str, Any] | None = None
    ) -> None:
        self.calls.append(("upload_file", Key))
        self.uploads.append({"filename": Filename, "key": Key, "extra_args": ExtraArgs or {}})

    def put_object(self, Bucket: str, Key: str, Body: bytes, **kwargs: Any) -> None:  # noqa: N803
        self.calls.append(("put_object", Key))
        self.puts.append({"key": Key, "body": Body, **kwargs})

    def download_file(self, Bucket: str, Key: str, Filename: str) -> None:  # noqa: N803
        self.calls.append(("download_file", Key))
        Path(Filename).write_bytes(self.bodies.get(Key, b"some other bytes entirely"))

    def copy_object(self, **kwargs: Any) -> None:
        self.calls.append(("copy_object", str(kwargs["Key"])))
        self.copies.append(kwargs)


@pytest.fixture
def publishable(tmp_path: Path, sample_model: Path) -> tuple[Any, dict[str, Any], dict[str, Path]]:
    """A validated manifest plus its sources, ready to hand to upload()."""
    out_dir = _run_publish(tmp_path, sample_model)
    manifest = json.loads((out_dir / "manifest.json").read_text())
    bucket = publish_model.read_media_bucket_config(dict(BUCKET_ENV))
    assert bucket is not None
    return bucket, manifest, {"model-int8.onnx": sample_model}


def test_upload_writes_weights_before_the_manifest(publishable: tuple[Any, dict[str, Any], dict[str, Path]]) -> None:
    bucket, manifest, sources = publishable
    client = RecordingS3Client()

    publish_model.upload(bucket, VERSION, manifest, sources, force=False, client=client)

    operations = [call for call in client.calls if call[0] != "head_object"]
    assert operations == [("upload_file", WEIGHT_KEY), ("put_object", MANIFEST_KEY)]


def test_upload_sets_immutable_weights_and_a_short_lived_manifest(
    publishable: tuple[Any, dict[str, Any], dict[str, Path]],
) -> None:
    bucket, manifest, sources = publishable
    client = RecordingS3Client()

    publish_model.upload(bucket, VERSION, manifest, sources, force=False, client=client)

    weight_args = client.uploads[0]["extra_args"]
    assert weight_args["CacheControl"] == "public, max-age=31536000, immutable"
    assert weight_args["ContentType"] == "application/octet-stream"
    # The sha256 the next publish compares against, so it can tell identical bytes
    # from different ones rather than blindly re-uploading.
    assert weight_args["Metadata"] == {"sha256": manifest["files"][0]["sha256"]}
    # R2 endpoint: no ACL header (docs/user-media-storage.md - R2 rejects them).
    assert "ACL" not in weight_args

    manifest_put = client.puts[0]
    assert manifest_put["CacheControl"] == "public, max-age=300"
    assert manifest_put["ContentType"] == "application/json"
    assert json.loads(manifest_put["body"]) == manifest


def test_upload_refuses_an_existing_manifest_without_force(
    publishable: tuple[Any, dict[str, Any], dict[str, Path]],
) -> None:
    bucket, manifest, sources = publishable
    client = RecordingS3Client(existing={MANIFEST_KEY: {"ContentLength": 10}})

    with pytest.raises(SystemExit, match="refusing to overwrite"):
        publish_model.upload(bucket, VERSION, manifest, sources, force=False, client=client)
    assert client.puts == []


def test_force_replaces_only_the_manifest(publishable: tuple[Any, dict[str, Any], dict[str, Path]]) -> None:
    """The immutability contract: --force never re-uploads weights.

    They are served `immutable, max-age=31536000`, so cached clients would keep the
    old bytes anyway - and the head check has already proved the published bytes
    match the manifest's sha256.
    """
    bucket, manifest, sources = publishable
    client = RecordingS3Client(
        existing={
            WEIGHT_KEY: {"Metadata": {"sha256": manifest["files"][0]["sha256"]}, "ContentLength": 1},
            MANIFEST_KEY: {"ContentLength": 10},
        }
    )

    publish_model.upload(bucket, VERSION, manifest, sources, force=True, client=client)

    assert client.uploads == []
    assert [put["key"] for put in client.puts] == [MANIFEST_KEY]


def test_force_still_refuses_to_replace_differing_weights(
    publishable: tuple[Any, dict[str, Any], dict[str, Path]],
) -> None:
    bucket, manifest, sources = publishable
    client = RecordingS3Client(
        existing={
            WEIGHT_KEY: {"Metadata": {"sha256": "0" * 64}, "ContentLength": 1},
            MANIFEST_KEY: {"ContentLength": 10},
        }
    )

    with pytest.raises(SystemExit, match="immutable per version"):
        publish_model.upload(bucket, VERSION, manifest, sources, force=True, client=client)
    assert client.uploads == []
    assert client.puts == []


def test_a_legacy_weight_with_identical_bytes_is_stamped_not_re_uploaded(
    publishable: tuple[Any, dict[str, Any], dict[str, Path]],
) -> None:
    """Weights from the previous publisher carry no sha256, so hash them instead of
    refusing - otherwise the manifest-repair path is closed for those versions."""
    bucket, manifest, sources = publishable
    source = sources["model-int8.onnx"]
    client = RecordingS3Client(
        existing={
            WEIGHT_KEY: {"ContentLength": source.stat().st_size},
            MANIFEST_KEY: {"ContentLength": 10},
        },
        bodies={WEIGHT_KEY: source.read_bytes()},
    )

    publish_model.upload(bucket, VERSION, manifest, sources, force=True, client=client)

    # Bytes untouched: one same-key metadata copy, no re-upload, manifest replaced.
    assert client.uploads == []
    assert [copy["Key"] for copy in client.copies] == [WEIGHT_KEY]
    stamped = client.copies[0]
    assert stamped["CopySource"] == {"Bucket": bucket.bucket_name, "Key": WEIGHT_KEY}
    assert stamped["MetadataDirective"] == "REPLACE"
    assert stamped["Metadata"] == {"sha256": manifest["files"][0]["sha256"]}
    # REPLACE drops anything not resent, so the immutable headers are restated.
    assert stamped["CacheControl"] == "public, max-age=31536000, immutable"
    assert stamped["ContentType"] == "application/octet-stream"
    assert [put["key"] for put in client.puts] == [MANIFEST_KEY]


def test_a_legacy_weight_with_different_bytes_is_still_refused(
    publishable: tuple[Any, dict[str, Any], dict[str, Path]],
) -> None:
    bucket, manifest, sources = publishable
    client = RecordingS3Client(
        existing={WEIGHT_KEY: {"ContentLength": 1}},
        bodies={WEIGHT_KEY: b"an older, different export"},
    )

    with pytest.raises(SystemExit, match="immutable per version"):
        publish_model.upload(bucket, VERSION, manifest, sources, force=True, client=client)
    assert client.uploads == []
    assert client.copies == []
    assert client.puts == []


def test_a_head_error_that_is_not_404_is_never_read_as_missing(
    publishable: tuple[Any, dict[str, Any], dict[str, Path]],
) -> None:
    """A 403 from a bad credential must not look like an empty prefix."""
    bucket, manifest, sources = publishable
    client = RecordingS3Client(head_status=403)

    with pytest.raises(ClientError):
        publish_model.upload(bucket, VERSION, manifest, sources, force=False, client=client)
    assert client.uploads == []
    assert client.puts == []


def test_a_brand_new_version_publishes_everything(
    publishable: tuple[Any, dict[str, Any], dict[str, Path]],
) -> None:
    """The documented flow: nothing published yet, no --force, both objects land."""
    bucket, manifest, sources = publishable
    client = RecordingS3Client()

    publish_model.upload(bucket, VERSION, manifest, sources, force=False, client=client)

    assert [upload["key"] for upload in client.uploads] == [WEIGHT_KEY]
    assert [put["key"] for put in client.puts] == [MANIFEST_KEY]

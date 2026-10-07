"""Tests for data/fetch.py (SW-01 follow-up, issue #5434).

Nothing here downloads anything: the one behaviour under test is what the
documented first command does when the optional Roboflow SDK is not installed.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

FETCH_PATH = Path(__file__).resolve().parent / "data" / "fetch.py"


def _load_fetch() -> ModuleType:
    spec = importlib.util.spec_from_file_location("holds_data_fetch", FETCH_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_a_missing_roboflow_sdk_names_the_install_command(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fetch = _load_fetch()
    # None in sys.modules is the documented way to make `from roboflow import ...`
    # raise ImportError without uninstalling anything.
    monkeypatch.setitem(sys.modules, "roboflow", None)

    entry = {"workspace": "w", "project": "p", "version": 14, "licence": "CC BY 4.0"}
    with pytest.raises(SystemExit) as raised:
        fetch.fetch_roboflow(entry, tmp_path / "roboflow-climbing-holds-and-volumes")

    message = str(raised.value)
    assert "pip install roboflow" in message
    assert "not installed" in message


def test_the_user_walls_corpus_is_registered_as_private_and_usable(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The licence passes the NC / unstated filter, and fetch.py never downloads it itself."""
    import json

    fetch = _load_fetch()
    entry = json.loads(fetch.SOURCES_PATH.read_text())["sources"]["boardsesh-user-walls"]
    assert entry["kind"] == "private"
    assert entry["redistributable"] is False
    assert fetch.licence_is_acceptable(entry["licence"]) == (True, entry["licence"])

    def no_network(*args: object, **kwargs: object) -> None:
        raise AssertionError("fetch.py tried to download a private corpus")

    monkeypatch.setattr(fetch, "download", no_network)
    monkeypatch.setattr(fetch, "fetch_git", no_network)
    fetch.fetch_source("boardsesh-user-walls", entry)
    out = capsys.readouterr().out
    assert "private corpus" in out
    assert "python data/user_walls.py fetch" in out

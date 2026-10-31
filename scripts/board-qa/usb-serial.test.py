# /// script
# requires-python = ">=3.10"
# dependencies = ["pyserial==3.5"]
# ///
"""Wire tracing must preserve malformed evidence without publishing it."""
import base64
import importlib.util
import json
import os
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stderr

specification = importlib.util.spec_from_file_location("usb_serial", Path(__file__).with_name("usb-serial.py"))
transport = importlib.util.module_from_spec(specification)
specification.loader.exec_module(transport)


class UsbTraceTests(unittest.TestCase):
    def test_exact_binary_chunks_and_direction_are_private(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "wire.jsonl"
            trace = transport.UsbTrace(filename)
            trace.record("tx", b'\nfixture-qa {"action":"status"}\n')
            trace.record("rx", b'BOARDSESH_QA {"broken":\xff\r\n')
            trace.close()
            records = [json.loads(line) for line in filename.read_text().splitlines()]
            self.assertEqual([record["direction"] for record in records], ["tx", "rx"])
            self.assertEqual(base64.b64decode(records[1]["base64"]), b'BOARDSESH_QA {"broken":\xff\r\n')
            self.assertEqual(os.stat(filename).st_mode & 0o777, 0o600)

    def test_trace_is_opt_in_and_bounded(self):
        disabled = transport.UsbTrace(None)
        disabled.record("rx", b"ignored")
        disabled.close()
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "wire.jsonl"
            trace = transport.UsbTrace(filename)
            trace.MAX_BYTES = 160
            trace.record("rx", b"valid")
            warning = io.StringIO()
            with redirect_stderr(warning):
                trace.record("rx", b"oversized" * 100)
                trace.record("rx", b"must not continue a truncated capture")
            trace.record("rx", b"")
            trace.close()
            self.assertLessEqual(filename.stat().st_size, 160)
            self.assertEqual(len(filename.read_text().splitlines()), 1)
            self.assertEqual(warning.getvalue().count("capture incomplete"), 1)

    def test_short_writes_preserve_complete_jsonl_records(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "wire.jsonl"
            trace = transport.UsbTrace(filename)
            original_write = os.write
            with patch.object(transport.os, "write", side_effect=lambda descriptor, payload: original_write(descriptor, payload[:3])):
                trace.record("rx", b"binary\x00\xff\n")
            trace.close()
            record = json.loads(filename.read_text())
            self.assertEqual(base64.b64decode(record["base64"]), b"binary\x00\xff\n")

    def test_trace_io_error_warns_once_without_stopping_transport_or_echoing_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "wire.jsonl"
            trace = transport.UsbTrace(filename)
            warning = io.StringIO()
            with redirect_stderr(warning), patch.object(transport.os, "write", side_effect=OSError("private path secret")):
                trace.record("rx", b"private-payload-secret")
                trace.record("rx", b"private-payload-secret")
            trace.close()
            self.assertEqual(warning.getvalue(), "USB trace disabled: write failed; capture incomplete\n")
            self.assertIsNone(trace.descriptor)

    def test_existing_evidence_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "wire.jsonl"
            filename.write_text("keep previous evidence")
            with self.assertRaises(FileExistsError):
                transport.UsbTrace(filename)
            self.assertEqual(filename.read_text(), "keep previous evidence")

    def test_leaf_symlinks_cannot_redirect_private_wire_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target"
            target.write_text("unchanged")
            filename = Path(directory) / "wire.jsonl"
            filename.symlink_to(target)
            with self.assertRaises(FileExistsError):
                transport.UsbTrace(filename)
            self.assertEqual(target.read_text(), "unchanged")


if __name__ == "__main__":
    unittest.main()

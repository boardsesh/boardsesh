#!/usr/bin/env python3
"""Host-side checks for USB framebuffer capture and the generated PNG format."""

import binascii
import importlib.util
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import zlib


MODULE_PATH = Path(__file__).with_name("capture-display.py")
MODULE_SPEC = importlib.util.spec_from_file_location("capture_display", MODULE_PATH)
capture_display = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(capture_display)


class FrameCaptureTests(unittest.TestCase):
    def test_primary_colors_survive_rgb565_conversion_in_a_valid_png(self):
        frame = capture_display.FrameCapture()
        frame.feed(b"BOARDSESH_SCREENSHOT_BEGIN 5 1 RGB565LE")
        frame.feed(b"BOARDSESH_SCREENSHOT_ROW 0 00f8e0071f00ffff0000")
        self.assertTrue(frame.feed(b"BOARDSESH_SCREENSHOT_END"))

        png = frame.png()
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        offset = 8
        chunks = []
        while offset < len(png):
            length = struct.unpack_from(">I", png, offset)[0]
            kind = png[offset + 4 : offset + 8]
            payload = png[offset + 8 : offset + 8 + length]
            checksum = struct.unpack_from(">I", png, offset + 8 + length)[0]
            self.assertEqual(checksum, binascii.crc32(kind + payload) & 0xFFFFFFFF)
            chunks.append((kind, payload))
            offset += length + 12

        self.assertEqual(offset, len(png))
        self.assertEqual([kind for kind, _ in chunks], [b"IHDR", b"IDAT", b"IEND"])
        self.assertEqual(struct.unpack(">IIBBBBB", chunks[0][1]), (5, 1, 8, 2, 0, 0, 0))
        self.assertEqual(
            zlib.decompress(chunks[1][1]),
            bytes([0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0]),
        )
        self.assertEqual(chunks[2][1], b"")

    def test_interleaved_logs_and_crlf_do_not_change_captured_rows(self):
        frame = capture_display.FrameCapture()
        for line in (
            b"WiFi connected\r\n",
            b"\r\n",
            b"BOARDSESH_SCREENSHOT_BEGIN 1 2 RGB565LE\r\n",
            b"BLE client disconnected\r\n",
            b"BOARDSESH_SCREENSHOT_ROW 0 00f8\r\n",
            b"Main: preview matched=7\r\n",
            b"BOARDSESH_SCREENSHOT_ROW 1 e007\r\n",
        ):
            self.assertFalse(frame.feed(line))
        self.assertTrue(frame.feed(b"BOARDSESH_SCREENSHOT_END\r\n"))
        self.assertEqual(frame.rows, [b"\x00\xf8", b"\xe0\x07"])

    def test_rejects_unsupported_or_malformed_headers(self):
        for header in (
            b"1 1 RGB565BE",
            b"1 RGB565LE",
            b"1 1 RGB565LE extra",
            b"wide 1 RGB565LE",
            b"1 tall RGB565LE",
        ):
            with self.subTest(header=header), self.assertRaises(ValueError):
                capture_display.FrameCapture().feed(b"BOARDSESH_SCREENSHOT_BEGIN " + header)

    def test_rejects_nonpositive_and_oversized_dimensions(self):
        for width, height in ((0, 1), (1, 0), (-1, 1), (1, -1), (1025, 1), (1, 1025)):
            with self.subTest(width=width, height=height), self.assertRaises(ValueError):
                capture_display.FrameCapture().feed(
                    f"BOARDSESH_SCREENSHOT_BEGIN {width} {height} RGB565LE".encode()
                )

    def test_rejects_a_second_header_during_capture(self):
        frame = capture_display.FrameCapture()
        frame.feed(b"BOARDSESH_SCREENSHOT_BEGIN 1 1 RGB565LE")
        with self.assertRaises(ValueError):
            frame.feed(b"BOARDSESH_SCREENSHOT_BEGIN 1 1 RGB565LE")

    def test_rejects_missing_duplicate_or_out_of_order_rows(self):
        for rows in (
            [b"1 0000"],
            [b"0 0000", b"0 0000"],
            [b"0 0000", b"2 0000"],
        ):
            with self.subTest(rows=rows):
                frame = capture_display.FrameCapture()
                frame.feed(b"BOARDSESH_SCREENSHOT_BEGIN 1 3 RGB565LE")
                with self.assertRaises(ValueError):
                    for row in rows:
                        frame.feed(b"BOARDSESH_SCREENSHOT_ROW " + row)

    def test_rejects_incorrect_row_lengths_nonhex_and_extra_rows(self):
        for row in (b"0 000", b"0 000000", b"0 zzzz", b"0 0000 extra", b"unknown 0000"):
            with self.subTest(row=row), self.assertRaises(ValueError):
                frame = capture_display.FrameCapture()
                frame.feed(b"BOARDSESH_SCREENSHOT_BEGIN 1 1 RGB565LE")
                frame.feed(b"BOARDSESH_SCREENSHOT_ROW " + row)

        frame = capture_display.FrameCapture()
        frame.feed(b"BOARDSESH_SCREENSHOT_BEGIN 1 1 RGB565LE")
        frame.feed(b"BOARDSESH_SCREENSHOT_ROW 0 0000")
        with self.assertRaises(ValueError):
            frame.feed(b"BOARDSESH_SCREENSHOT_ROW 1 0000")

    def test_truncated_frames_cannot_be_exported(self):
        for lines in (
            [],
            [b"BOARDSESH_SCREENSHOT_BEGIN 1 1 RGB565LE"],
            [b"BOARDSESH_SCREENSHOT_BEGIN 1 1 RGB565LE", b"BOARDSESH_SCREENSHOT_ROW 0 0000"],
        ):
            with self.subTest(lines=lines):
                frame = capture_display.FrameCapture()
                for line in lines:
                    frame.feed(line)
                with self.assertRaises(ValueError):
                    frame.png()

        frame = capture_display.FrameCapture()
        frame.feed(b"BOARDSESH_SCREENSHOT_BEGIN 1 2 RGB565LE")
        frame.feed(b"BOARDSESH_SCREENSHOT_ROW 0 0000")
        with self.assertRaises(ValueError):
            frame.feed(b"BOARDSESH_SCREENSHOT_END")

    def test_device_errors_fail_capture(self):
        with self.assertRaisesRegex(ValueError, "BOARDSESH_SCREENSHOT_ERROR"):
            capture_display.FrameCapture().feed(b"BOARDSESH_SCREENSHOT_ERROR unavailable")


class FakeSerial:
    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.opened = False
        self.closed = False
        self.writes = []

    def __setattr__(self, name, setting):
        if name in ("dtr", "rts") and getattr(self, "opened", False) and getattr(self, name) != setting:
            raise AssertionError("Capture must not toggle reset/control lines after opening")
        object.__setattr__(self, name, setting)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True

    def open(self):
        if self.dtr is not True or self.rts is not False:
            raise AssertionError("Capture must assert DTR and release RTS before opening")
        self.opened = True

    def reset_input_buffer(self):
        if not self.opened:
            raise AssertionError("Serial port must be open before discarding stale logs")

    @property
    def in_waiting(self):
        return len(self.chunks[0]) if self.chunks else 0

    def write(self, command):
        self.writes.append(command)
        return len(command)

    def read(self, _):
        return self.chunks.pop(0) if self.chunks else b""


class CaptureStreamTests(unittest.TestCase):
    def test_fragmented_usb_stream_writes_png_without_resetting_the_board(self):
        connection = FakeSerial(
            [
                b"Boot log\nBOARDSESH_SCREEN",
                b"SHOT_BEGIN 1 1 RGB565LE\nBOARDSESH_SCREENSHOT_ROW 0 00",
                b"f8\nBLE connected\nBOARDSESH_SCREENSHOT_END\n",
            ]
        )
        serial_factory = mock.Mock(return_value=connection)
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "screenshots" / "device.png"
            with mock.patch.dict(sys.modules, {"serial": SimpleNamespace(Serial=serial_factory)}):
                dimensions = capture_display.capture("/dev/test-board", destination, 5)
            self.assertEqual(dimensions, (1, 1))
            self.assertTrue(destination.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
        serial_factory.assert_called_once_with(port=None, baudrate=115200, timeout=0.25, write_timeout=3)
        self.assertEqual(connection.port, "/dev/test-board")
        self.assertEqual(connection.writes, [b"\nscreenshot\n"])
        self.assertTrue(connection.closed)

    def test_timeout_closes_serial_without_saving_an_incomplete_png(self):
        connection = FakeSerial([b"BOARDSESH_SCREENSHOT_BEGIN 1 2 RGB565LE\nBOARDSESH_SCREENSHOT_ROW 0 0000\n"])
        serial_module = SimpleNamespace(Serial=mock.Mock(return_value=connection))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "device.png"
            with (
                mock.patch.dict(sys.modules, {"serial": serial_module}),
                mock.patch.object(capture_display.time, "monotonic", side_effect=[0, 0, 6]),
                self.assertRaisesRegex(TimeoutError, "1 rows received"),
            ):
                capture_display.capture("/dev/test-board", destination, 5)
            self.assertFalse(destination.exists())
        self.assertTrue(connection.closed)

    def test_serial_open_failure_does_not_create_an_output_file(self):
        connection = FakeSerial([])
        serial_module = SimpleNamespace(Serial=mock.Mock(return_value=connection))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "device.png"
            with (
                mock.patch.dict(sys.modules, {"serial": serial_module}),
                mock.patch.object(connection, "open", side_effect=OSError("port busy")),
                self.assertRaisesRegex(OSError, "port busy"),
            ):
                capture_display.capture("/dev/test-board", destination, 5)
            self.assertFalse(destination.exists())
        self.assertTrue(connection.closed)

    def test_oversized_serial_record_is_rejected_without_saving(self):
        connection = FakeSerial([b"x" * (1024 * 4 + 257)])
        serial_module = SimpleNamespace(Serial=mock.Mock(return_value=connection))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "device.png"
            with (
                mock.patch.dict(sys.modules, {"serial": serial_module}),
                self.assertRaisesRegex(ValueError, "oversized line"),
            ):
                capture_display.capture("/dev/test-board", destination, 5)
            self.assertFalse(destination.exists())
        self.assertTrue(connection.closed)


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyserial==3.5"]
# ///
"""Capture the Waveshare's rendered RGB565 framebuffer over USB as a PNG."""

import argparse
import binascii
from pathlib import Path
import struct
import time
import zlib


BEGIN = b"BOARDSESH_SCREENSHOT_BEGIN "
ROW = b"BOARDSESH_SCREENSHOT_ROW "
END = b"BOARDSESH_SCREENSHOT_END"
ERROR = b"BOARDSESH_SCREENSHOT_ERROR"
MAX_DIMENSION = 1024


class FrameCapture:
    """Accept tagged rows while ignoring ordinary interleaved device logs."""

    def __init__(self):
        self.width = 0
        self.height = 0
        self.rows = []
        self.complete = False

    def feed(self, line):
        line = line.rstrip(b"\r\n")
        if line.startswith(ERROR):
            raise ValueError(line.decode("ascii", errors="replace"))
        if line.startswith(BEGIN):
            if self.width:
                raise ValueError("Device started another capture before finishing")
            fields = line[len(BEGIN) :].split()
            if len(fields) != 3 or fields[2] != b"RGB565LE":
                raise ValueError("Unsupported screenshot header")
            self.width, self.height = int(fields[0]), int(fields[1])
            if not (0 < self.width <= MAX_DIMENSION and 0 < self.height <= MAX_DIMENSION):
                raise ValueError("Screenshot dimensions exceed capture limits")
        elif line.startswith(ROW) and self.width:
            fields = line[len(ROW) :].split()
            if len(fields) != 2 or int(fields[0]) != len(self.rows):
                raise ValueError("Screenshot rows are missing, repeated, or out of order")
            if len(self.rows) >= self.height or len(fields[1]) != self.width * 4:
                raise ValueError("Screenshot row has an unexpected length")
            self.rows.append(binascii.unhexlify(fields[1]))
        elif line == END and self.width:
            if len(self.rows) != self.height:
                raise ValueError("Device ended screenshot before all rows arrived")
            self.complete = True
        return self.complete

    def png(self):
        if not self.complete:
            raise ValueError("Screenshot is incomplete")

        scanlines = bytearray()
        for row in self.rows:
            scanlines.append(0)  # PNG filter: none
            for (pixel,) in struct.iter_unpack("<H", row):
                red = (pixel >> 11) & 31
                green = (pixel >> 5) & 63
                blue = pixel & 31
                scanlines.extend(((red << 3) | (red >> 2), (green << 2) | (green >> 4), (blue << 3) | (blue >> 2)))

        def chunk(kind, payload):
            checksum = binascii.crc32(kind + payload) & 0xFFFFFFFF
            return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

        header = struct.pack(">IIBBBBB", self.width, self.height, 8, 2, 0, 0, 0)
        return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b"")


def capture(port, output, timeout):
    import serial

    frame = FrameCapture()
    # Native USB Serial/JTAG resets this board when DTR is deasserted. Keep
    # host-ready asserted and RTS released so capture preserves the live climb.
    with serial.Serial(port=None, baudrate=115200, timeout=0.25, write_timeout=3) as connection:
        connection.dtr = True
        connection.rts = False
        connection.port = port
        connection.open()
        connection.reset_input_buffer()
        connection.write(b"\nscreenshot\n")
        deadline = time.monotonic() + timeout
        pending = bytearray()
        while time.monotonic() < deadline:
            pending.extend(connection.read(connection.in_waiting or 1))
            while b"\n" in pending:
                line, _, rest = pending.partition(b"\n")
                pending = bytearray(rest)
                if frame.feed(line):
                    output.parent.mkdir(parents=True, exist_ok=True)
                    output.write_bytes(frame.png())
                    return frame.width, frame.height
            if len(pending) > MAX_DIMENSION * 4 + 256:
                raise ValueError("Screenshot stream contains an oversized line")
    raise TimeoutError(f"Capture timed out after {timeout:g}s ({len(frame.rows)} rows received)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="USB serial device, e.g. /dev/cu.usbmodem101")
    parser.add_argument("--output", type=Path, required=True, help="Destination PNG")
    parser.add_argument("--timeout", type=float, default=30, help="Capture timeout in seconds")
    arguments = parser.parse_args()
    if arguments.timeout <= 0:
        parser.error("--timeout must be positive")
    try:
        width, height = capture(arguments.port, arguments.output, arguments.timeout)
    except (OSError, ValueError, TimeoutError) as error:
        parser.exit(1, f"Capture failed: {error}\n")
    print(f"Saved {width}x{height} device framebuffer to {arguments.output}")


if __name__ == "__main__":
    main()

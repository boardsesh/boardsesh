# /// script
# requires-python = ">=3.10"
# dependencies = ["pyserial==3.5"]
# ///
"""One USB owner. Keep this filename distinct from the pyserial module."""
import argparse
import base64
import json
import os
import sys
import threading
import time
import serial


class UsbTrace:
    """Opt-in bounded private wire evidence; never print raw bytes to stdout."""

    MAX_BYTES = 16 * 1024 * 1024

    def __init__(self, filename):
        self.descriptor = None
        self.lock = threading.Lock()
        self.size = 0
        if filename:
            self.descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)

    def record(self, direction, payload):
        if self.descriptor is None or not payload:
            return
        encoded = (
            json.dumps(
                {
                    "atNs": time.time_ns(),
                    "direction": direction,
                    "base64": base64.b64encode(payload).decode("ascii"),
                },
                separators=(",", ":"),
            )
            + "\n"
        ).encode("ascii")
        with self.lock:
            if self.descriptor is None:
                return
            if self.size + len(encoded) > self.MAX_BYTES:
                self._disable_locked("size limit reached")
                return
            try:
                offset = 0
                while offset < len(encoded):
                    written = os.write(self.descriptor, encoded[offset:])
                    if written <= 0:
                        raise OSError("Trace write made no progress")
                    offset += written
                    self.size += written
            except OSError:
                self._disable_locked("write failed")

    def _disable_locked(self, reason):
        print(f"USB trace disabled: {reason}; capture incomplete", file=sys.stderr, flush=True)
        descriptor = self.descriptor
        self.descriptor = None
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass

    def close(self):
        with self.lock:
            if self.descriptor is not None:
                descriptor = self.descriptor
                self.descriptor = None
                try:
                    os.close(descriptor)
                except OSError:
                    print("USB trace close failed; capture incomplete", file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True)
    arguments = parser.parse_args()
    trace = UsbTrace(os.environ.get("BOARDSESH_QA_USB_TRACE"))
    try:
        run_transport(arguments.port, trace)
    finally:
        trace.close()


def run_transport(port, trace):
    with serial.Serial(port=None, baudrate=115200, timeout=0.25, write_timeout=3) as connection:
        # Preserve native USB state: deasserting DTR can reset this board.
        connection.dtr = True
        connection.rts = False
        connection.port = port
        connection.open()

        def receive():
            pending = bytearray()
            while connection.is_open:
                received = connection.read(connection.in_waiting or 1)
                trace.record("rx", received)
                pending.extend(received)
                while b"\n" in pending:
                    line, _, rest = pending.partition(b"\n")
                    pending[:] = rest
                    if line.startswith(b"BOARDSESH_QA "):
                        print(line[13:].decode("utf-8"), flush=True)
                if len(pending) > 512_000:
                    pending.clear()

        threading.Thread(target=receive, daemon=True).start()
        print(json.dumps({"transportReady": True}), flush=True)
        for line in sys.stdin:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Expected a QA request object")
            encoded = json.dumps(request, separators=(",", ":"))
            if len(encoded) > 512:
                raise ValueError("QA request too large")
            wire_request = ("\nfixture-qa " + encoded + "\n").encode("utf-8")
            trace.record("tx", wire_request)
            connection.write(wire_request)


if __name__ == "__main__":
    main()

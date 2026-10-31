# /// script
# requires-python = ">=3.10"
# dependencies = ["pyserial==3.5"]
# ///
"""One USB owner. Keep this filename distinct from the pyserial module."""
import argparse
import json
import sys
import threading
import serial


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True)
    arguments = parser.parse_args()
    with serial.Serial(port=None, baudrate=115200, timeout=0.25, write_timeout=3) as connection:
        # Preserve native USB state: deasserting DTR can reset this board.
        connection.dtr = True
        connection.rts = False
        connection.port = arguments.port
        connection.open()

        def receive():
            pending = bytearray()
            while connection.is_open:
                pending.extend(connection.read(connection.in_waiting or 1))
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
            connection.write(("\nfixture-qa " + encoded + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()

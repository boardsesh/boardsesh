#!/usr/bin/env python3
"""Forward loopback WDA HTTP to one USB iPhone using macOS usbmuxd."""
import argparse
import plistlib
import select
import signal
import socket
import struct
import sys
import threading
import time

HEADER = struct.Struct("<IIII")
MAX_PACKET = 1024 * 1024


def receive_exact(connection, length):
    received = bytearray()
    while len(received) < length:
        chunk = connection.recv(length - len(received))
        if not chunk:
            raise ConnectionError("usbmuxd closed during handshake")
        received.extend(chunk)
    return bytes(received)


def request(connection, message, tag):
    payload = plistlib.dumps({"ClientVersionString": "BoardseshBoardQA", "ProgName": "boardsesh-board-qa", **message})
    connection.sendall(HEADER.pack(HEADER.size + len(payload), 1, 8, tag) + payload)
    length, version, kind, response_tag = HEADER.unpack(receive_exact(connection, HEADER.size))
    if not HEADER.size <= length <= MAX_PACKET or (version, kind, response_tag) != (1, 8, tag):
        raise ConnectionError("Unexpected usbmuxd handshake packet")
    response = plistlib.loads(receive_exact(connection, length - HEADER.size))
    if not isinstance(response, dict):
        raise ConnectionError("Unexpected usbmuxd handshake contents")
    return response


def connect_device(device, port):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(10)
    try:
        connection.connect("/var/run/usbmuxd")
        inventory = request(connection, {"MessageType": "ListDevices"}, 1)
        devices = inventory.get("DeviceList", [])
        if not isinstance(devices, list):
            raise ConnectionError("Unexpected usbmuxd device inventory")
        matches = [entry for entry in devices if isinstance(entry, dict)
                   and isinstance(entry.get("Properties"), dict)
                   and entry["Properties"].get("SerialNumber") == device
                   and entry["Properties"].get("ConnectionType") == "USB"]
        if len(matches) != 1 or type(matches[0].get("DeviceID")) is not int:
            raise ConnectionError("Selected iPhone is not uniquely connected over USB")
        response = request(connection, {"MessageType": "Connect", "DeviceID": matches[0]["DeviceID"], "PortNumber": socket.htons(port)}, 2)
        if type(response.get("Number")) is not int or response["Number"] != 0:
            raise ConnectionError("usbmuxd rejected the selected device port")
        return connection
    except BaseException:
        connection.close()
        raise


def bridge(client, upstream, stopping):
    readers = [client, upstream]
    while readers and not stopping.is_set():
        ready, _, _ = select.select(readers, [], [], 0.5)
        for source in ready:
            destination = upstream if source is client else client
            chunk = source.recv(65536)
            if chunk:
                destination.sendall(chunk)
            else:
                readers.remove(source)
                destination.shutdown(socket.SHUT_WR)


def serve(device, port):
    stopping = threading.Event()
    active = set()
    lock = threading.Lock()
    slots = threading.BoundedSemaphore(8)
    threads = []

    def forward(client):
        upstream = None
        try:
            client.settimeout(10)
            upstream = connect_device(device, port)
            with lock:
                active.add(upstream)
            if not stopping.is_set():
                bridge(client, upstream, stopping)
        except (OSError, ValueError, plistlib.InvalidFileException) as error:
            if not stopping.is_set():
                print("Board QA USB connection failed: " + str(error), file=sys.stderr)
        finally:
            with lock:
                for connection in (client, upstream):
                    if connection is not None:
                        active.discard(connection)
                        connection.close()
            slots.release()

    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda _signal, _frame: stopping.set())
    probe = connect_device(device, port)
    probe.close()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", port))
        listener.listen(8)
        listener.settimeout(0.5)
        print(f"Board QA USB forward ready on 127.0.0.1:{port}", flush=True)
        try:
            while not stopping.is_set():
                try:
                    client, _ = listener.accept()
                except socket.timeout:
                    continue
                if not slots.acquire(blocking=False):
                    client.close()
                    continue
                with lock:
                    active.add(client)
                thread = threading.Thread(target=forward, args=(client,), daemon=True)
                threads = [worker for worker in threads if worker.is_alive()]
                threads.append(thread)
                thread.start()
        finally:
            stopping.set()
            with lock:
                for connection in active:
                    connection.close()
            deadline = time.monotonic() + 2
            for thread in threads:
                thread.join(timeout=max(0, deadline - time.monotonic()))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", required=True, help="Exact USB iPhone UDID")
    parser.add_argument("--port", type=int, default=8211)
    options = parser.parse_args()
    if not 1 <= options.port <= 65535:
        parser.error("port must be between 1 and 65535")
    serve(options.device, options.port)

"""Shared plumbing for the scenarios: where a run's files go, and the host-side marks that split it into phases."""
import json, os, time


def run_directory(name):
    root = os.environ.get("BOARDSESH_PROBE_RUNS", os.path.join(os.getcwd(), ".boardsesh", "probe-runs"))
    directory = os.path.join(root, name)
    os.makedirs(directory, exist_ok=True)
    return directory


class Marks:
    """Host wall-clock marks. The probe events carry the phone's wall clock (`wallMs`), so the two line up to within clock drift."""

    def __init__(self):
        self.marks = []

    def mark(self, label):
        self.marks.append({"wall": int(time.time() * 1000), "event": label})

    def save(self, directory):
        json.dump(self.marks, open(os.path.join(directory, "events.json"), "w"), indent=1)

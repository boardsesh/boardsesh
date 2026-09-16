/**
 * Partial benchmark results, written to disk as each size finishes.
 *
 * The sweep's largest input is the one most likely to get the process killed —
 * SW-01 measured `nano-untiled-1024` at 987 MB for a 768 px pass against a
 * 500 MB phone budget, and an iPhone 17 Pro confirmed it: 512 completes, 768
 * takes the app down. A watchdog termination is not an exception, so no
 * `catch`, no `finally` and no React state survives it. Holding the results in
 * memory until the sweep returns means the sizes that DID fit die with the
 * ones that did not, and the tester is left with nothing to report.
 *
 * So each size is flushed here the moment it completes. The screen reloads
 * whatever is on disk when it mounts, which turns a kill from "lost the run"
 * into "the run says 768 does not fit on this device" — which is the finding
 * #5451 is waiting for, not a failure to obtain it.
 *
 * Deliberately plain JSON in the document directory rather than a database:
 * one small file, written a handful of times per run, read once per mount.
 */

import { Directory, File, Paths } from 'expo-file-system';
import type { BenchmarkReport } from './benchmark';

const STORE_DIR = 'hold-detection';
const STORE_FILE = 'last-benchmark.json';

/** How a stored run ended, so the screen can say so rather than imply success. */
export type StoredBenchmarkStatus = 'complete' | 'partial';

export interface StoredBenchmark {
  status: StoredBenchmarkStatus;
  /** Sizes the sweep intended to run, so a reader can see what is missing. */
  plannedSizes: number[];
  report: BenchmarkReport;
}

function storeFile(): File {
  return new File(new Directory(Paths.document, STORE_DIR), STORE_FILE);
}

/**
 * Write the run so far. Never throws.
 *
 * Called between sizes, on the path to a possible process kill, so a failure
 * here must not be what ends the sweep — a lost partial is strictly better
 * than turning a survivable run into a crash. The caller gets a boolean so the
 * screen can avoid promising a recovery it cannot deliver.
 */
export function saveBenchmark(stored: StoredBenchmark): boolean {
  try {
    const directory = new Directory(Paths.document, STORE_DIR);
    if (!directory.exists) directory.create({ intermediates: true });
    storeFile().write(JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the last run, or null when there is none or it cannot be parsed.
 *
 * A half-written file is possible: the process can die mid-`write`. That reads
 * back as invalid JSON and is treated as "no stored run" rather than being
 * surfaced as an error — the tester's next action is the same either way.
 */
export function loadBenchmark(): StoredBenchmark | null {
  try {
    const file = storeFile();
    if (!file.exists) return null;
    // textSync, not text(): this runs once during the screen's initial state
    // and an async read would render an empty screen before the recovered run
    // appeared. The file is a few KB.
    const parsed = JSON.parse(file.textSync()) as StoredBenchmark;
    // Shape check rather than trust: this file outlives app versions, and a
    // report from an older schema should read as absent, not crash the screen.
    if (!parsed?.report?.sizes || !Array.isArray(parsed.report.sizes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Drop the stored run. Used when a fresh sweep starts. Never throws. */
export function clearBenchmark(): void {
  try {
    const file = storeFile();
    if (file.exists) file.delete();
  } catch {
    // A store we cannot clear is not worth failing a run over; the next
    // successful save overwrites it anyway.
  }
}

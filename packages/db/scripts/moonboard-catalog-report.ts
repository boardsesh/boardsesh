import fs from 'fs';
import path from 'path';

// =============================================================================
// MoonBoard catalog import — machine-readable run report
// =============================================================================
// import-moonboard-catalog.ts is meant to also run unattended: a scheduler
// invokes it with --report-json <path>, discards stdout/stderr, and reads this
// file back afterward to decide whether the run did what was asked — in
// particular, that `dryRun` in the report matches the --dry-run flag it
// passed. A rehearsal that silently committed for real (or a real run that
// silently rolled back) would be worse than a crash, so that field is not
// derived — it is the literal flag value the run was invoked with.
//
// Written once per run, atomically (temp file + rename, same directory as the
// target path), so a scheduler polling the path only ever sees the previous
// file or the fully-written new one, never a half-written one. Any stale
// report already at the target path is deleted up front, before the run
// touches the database, so a crash before this run gets to write its own
// report can never leave a PREVIOUS run's report looking like this run's
// result — see clearExistingCatalogReport.
//
// A report is written on every failure once argv parsing has succeeded and
// --report-json points somewhere writable, not only on success or a dry-run
// rollback: a bad catalog directory, an empty catalog directory, the run lock
// already being held, and the database being unreachable all still produce a
// `version: 1` report with `error` set. `failedFile` additionally names the
// board file that was being imported when the failure happened, when there
// was one.
// =============================================================================

/**
 * Every counter the importer accumulates, named exactly as the console
 * output and the `totals` object in import-moonboard-catalog.ts already name
 * them. This report is a machine-readable mirror of that printout, not a new
 * vocabulary — do not add or rename fields here without doing the same there.
 */
export type CatalogRunCounters = {
  problems: number;
  matched: number;
  inserted: number;
  climbs: number;
  stats: number;
  holds: number;
  skippedProblems: number;
  skippedAmbiguous: number;
  skippedDrifted: number;
  skippedHijacked: number;
  foldedInBatch: number;
  sharedClimbInBatch: number;
  withdrawn: number;
  withdrawnWithClimbs: number;
  unlisted: number;
};

export function zeroCatalogRunCounters(): CatalogRunCounters {
  return {
    problems: 0,
    matched: 0,
    inserted: 0,
    climbs: 0,
    stats: 0,
    holds: 0,
    skippedProblems: 0,
    skippedAmbiguous: 0,
    skippedDrifted: 0,
    skippedHijacked: 0,
    foldedInBatch: 0,
    sharedClimbInBatch: 0,
    withdrawn: 0,
    withdrawnWithClimbs: 0,
    unlisted: 0,
  };
}

/** One board file's counters, plus which file/board they belong to. */
export type CatalogBoardRunReport = CatalogRunCounters & {
  holdsetup: number;
  layoutId: number;
  file: string;
};

export type CatalogRunReport = {
  version: 1;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  boards: CatalogBoardRunReport[];
  totals: CatalogRunCounters;
  /** Present only when the run failed after doing at least some work. */
  error?: string;
  /** The board file being imported when `error` happened, if the failure occurred during a specific file. */
  failedFile?: string;
};

export type BuildCatalogRunReportParams = {
  dryRun: boolean;
  startedAt: Date;
  finishedAt: Date;
  boards: CatalogBoardRunReport[];
  totals: CatalogRunCounters;
  error?: string;
  failedFile?: string;
};

/** Pure — assembles the report object. No I/O, so it is cheap to unit test. */
export function buildCatalogRunReport(params: BuildCatalogRunReportParams): CatalogRunReport {
  const report: CatalogRunReport = {
    version: 1,
    dryRun: params.dryRun,
    startedAt: params.startedAt.toISOString(),
    finishedAt: params.finishedAt.toISOString(),
    boards: params.boards,
    totals: params.totals,
  };
  if (params.error !== undefined) report.error = params.error;
  if (params.failedFile !== undefined) report.failedFile = params.failedFile;
  return report;
}

/**
 * True when `reportPath`'s parent directory exists. Checked up front, before
 * the import touches any data, so a typo'd --report-json path fails the run
 * before real work starts instead of after, when the final write throws.
 */
export function reportJsonParentDirExists(reportPath: string): boolean {
  const parentDir = path.dirname(reportPath);
  try {
    return fs.statSync(parentDir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True when something already exists AT `reportPath` itself and it's a
 * directory — writing there would collide with the rename step below instead
 * of producing a report. Checked up front, alongside
 * `reportJsonParentDirExists`, so this fails the run before real work starts.
 */
export function reportJsonTargetIsDirectory(reportPath: string): boolean {
  try {
    return fs.statSync(reportPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True when the directory `reportPath` lives in actually accepts a write.
 * Probes by creating and immediately removing a small file there, rather than
 * just checking that the directory exists: a directory can exist and still be
 * read-only (wrong permissions, a read-only bind mount, a full disk on some
 * filesystems), and without this check that isn't discovered until AFTER
 * every board has already committed, when the final `writeCatalogRunReportAtomic`
 * call throws with nothing left to do about it. Checked up front, alongside
 * `reportJsonParentDirExists` and `reportJsonTargetIsDirectory`, so it fails
 * the run before real work starts instead of after.
 */
export function reportJsonDirectoryIsWritable(reportPath: string): boolean {
  const parentDir = path.dirname(reportPath);
  const probePath = path.join(parentDir, `.${path.basename(reportPath)}.${process.pid}.writable-probe`);
  try {
    fs.writeFileSync(probePath, '');
    fs.rmSync(probePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes any report already sitting at `reportPath`. Called once, right
 * after the path is validated and before the run touches the database, so a
 * STALE report from a previous run (still showing `version: 1` and a clean
 * exit) can never be mistaken for this run's result if this run dies before
 * it gets a chance to write its own. A missing file is not an error.
 */
export function clearExistingCatalogReport(reportPath: string): void {
  fs.rmSync(reportPath, { force: true });
}

/**
 * Writes the report as temp-file-then-rename, both in the same directory as
 * `reportPath` so the rename is same-filesystem and therefore atomic on
 * POSIX. A reader polling `reportPath` never observes a partially-written
 * file, only the previous version or the complete new one.
 *
 * On failure the temp file is removed rather than left behind — a write or
 * rename that fails partway (disk full, permissions, a concurrent directory
 * removal) should not litter the report directory with a `.report.json.<pid>.
 * <ts>.tmp` file for someone to find later and wonder about.
 */
export function writeCatalogRunReportAtomic(reportPath: string, report: CatalogRunReport): void {
  const parentDir = path.dirname(reportPath);
  const tempPath = path.join(parentDir, `.${path.basename(reportPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.renameSync(tempPath, reportPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

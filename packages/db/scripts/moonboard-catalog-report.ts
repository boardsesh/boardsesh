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
// file or the fully-written new one, never a half-written one.
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
};

export type BuildCatalogRunReportParams = {
  dryRun: boolean;
  startedAt: Date;
  finishedAt: Date;
  boards: CatalogBoardRunReport[];
  totals: CatalogRunCounters;
  error?: string;
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
 * Writes the report as temp-file-then-rename, both in the same directory as
 * `reportPath` so the rename is same-filesystem and therefore atomic on
 * POSIX. A reader polling `reportPath` never observes a partially-written
 * file, only the previous version or the complete new one.
 */
export function writeCatalogRunReportAtomic(reportPath: string, report: CatalogRunReport): void {
  const parentDir = path.dirname(reportPath);
  const tempPath = path.join(parentDir, `.${path.basename(reportPath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(tempPath, reportPath);
}

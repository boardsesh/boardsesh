import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildCatalogRunReport,
  writeCatalogRunReportAtomic,
  reportJsonParentDirExists,
  reportJsonTargetIsDirectory,
  clearExistingCatalogReport,
  zeroCatalogRunCounters,
  type CatalogBoardRunReport,
} from './moonboard-catalog-report.js';

// The report is the ONLY thing an unattended scheduler reads back after a run
// with stdout/stderr discarded, so every case here guards a claim the
// scheduler actually relies on: version pinning, dryRun mirroring the flag it
// was invoked with (never a derived guess), and an atomic write so a poller
// never observes a half-written file.

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moonboard-catalog-report-test-'));
}

const SAMPLE_BOARD: CatalogBoardRunReport = {
  ...zeroCatalogRunCounters(),
  holdsetup: 21,
  layoutId: 3,
  file: 'moonboard-2024.json',
  problems: 10,
  matched: 7,
  inserted: 3,
  climbs: 10,
};

void test('buildCatalogRunReport always sets version 1', () => {
  const report = buildCatalogRunReport({
    dryRun: false,
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    finishedAt: new Date('2026-01-01T00:05:00.000Z'),
    boards: [],
    totals: zeroCatalogRunCounters(),
  });
  assert.equal(report.version, 1);
});

void test('dryRun in the report mirrors the flag the run was invoked with, not a derived value', () => {
  const dryRunTrue = buildCatalogRunReport({
    dryRun: true,
    startedAt: new Date(),
    finishedAt: new Date(),
    boards: [],
    totals: zeroCatalogRunCounters(),
  });
  const dryRunFalse = buildCatalogRunReport({
    dryRun: false,
    startedAt: new Date(),
    finishedAt: new Date(),
    boards: [],
    totals: zeroCatalogRunCounters(),
  });
  assert.equal(dryRunTrue.dryRun, true);
  assert.equal(dryRunFalse.dryRun, false);
});

void test('startedAt/finishedAt are ISO strings', () => {
  const startedAt = new Date('2026-03-14T09:26:00.000Z');
  const finishedAt = new Date('2026-03-14T09:31:00.000Z');
  const report = buildCatalogRunReport({
    dryRun: false,
    startedAt,
    finishedAt,
    boards: [],
    totals: zeroCatalogRunCounters(),
  });
  assert.equal(report.startedAt, startedAt.toISOString());
  assert.equal(report.finishedAt, finishedAt.toISOString());
});

void test('boards and totals pass through unchanged', () => {
  const totals = { ...zeroCatalogRunCounters(), problems: 10, matched: 7, inserted: 3, climbs: 10 };
  const report = buildCatalogRunReport({
    dryRun: false,
    startedAt: new Date(),
    finishedAt: new Date(),
    boards: [SAMPLE_BOARD],
    totals,
  });
  assert.deepEqual(report.boards, [SAMPLE_BOARD]);
  assert.deepEqual(report.totals, totals);
});

void test('error is omitted on a clean run, present on a failed one', () => {
  const clean = buildCatalogRunReport({
    dryRun: false,
    startedAt: new Date(),
    finishedAt: new Date(),
    boards: [],
    totals: zeroCatalogRunCounters(),
  });
  assert.equal('error' in clean, false);

  const failed = buildCatalogRunReport({
    dryRun: false,
    startedAt: new Date(),
    finishedAt: new Date(),
    boards: [SAMPLE_BOARD],
    totals: zeroCatalogRunCounters(),
    error: 'connection reset mid-file',
  });
  assert.equal(failed.error, 'connection reset mid-file');
});

void test('error is omitted on a clean run, present when failedFile is set', () => {
  const clean = buildCatalogRunReport({
    dryRun: false,
    startedAt: new Date(),
    finishedAt: new Date(),
    boards: [],
    totals: zeroCatalogRunCounters(),
  });
  assert.equal('failedFile' in clean, false);

  const failed = buildCatalogRunReport({
    dryRun: false,
    startedAt: new Date(),
    finishedAt: new Date(),
    boards: [SAMPLE_BOARD],
    totals: zeroCatalogRunCounters(),
    error: 'connection reset mid-file',
    failedFile: 'moonboard-2024.json',
  });
  assert.equal(failed.failedFile, 'moonboard-2024.json');
});

void test('reportJsonParentDirExists is true for an existing directory, false otherwise', () => {
  const tempDir = makeTempDir();
  try {
    assert.equal(reportJsonParentDirExists(path.join(tempDir, 'report.json')), true);
    assert.equal(reportJsonParentDirExists(path.join(tempDir, 'nope', 'report.json')), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test('reportJsonTargetIsDirectory is true only when a directory already sits at the path', () => {
  const tempDir = makeTempDir();
  try {
    const dirPath = path.join(tempDir, 'a-directory');
    fs.mkdirSync(dirPath);
    assert.equal(reportJsonTargetIsDirectory(dirPath), true);
    assert.equal(reportJsonTargetIsDirectory(path.join(tempDir, 'report.json')), false);

    const filePath = path.join(tempDir, 'report.json');
    fs.writeFileSync(filePath, '{}');
    assert.equal(reportJsonTargetIsDirectory(filePath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test('clearExistingCatalogReport removes a report left by a previous run', () => {
  const tempDir = makeTempDir();
  try {
    const reportPath = path.join(tempDir, 'report.json');
    fs.writeFileSync(reportPath, '{"version":1,"stale":true}');

    clearExistingCatalogReport(reportPath);

    assert.equal(fs.existsSync(reportPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test('clearExistingCatalogReport does not throw when there is nothing to remove', () => {
  const tempDir = makeTempDir();
  try {
    assert.doesNotThrow(() => clearExistingCatalogReport(path.join(tempDir, 'never-existed.json')));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test('writeCatalogRunReportAtomic writes valid JSON matching the report object', () => {
  const tempDir = makeTempDir();
  try {
    const reportPath = path.join(tempDir, 'report.json');
    const report = buildCatalogRunReport({
      dryRun: true,
      startedAt: new Date('2026-05-01T00:00:00.000Z'),
      finishedAt: new Date('2026-05-01T00:10:00.000Z'),
      boards: [SAMPLE_BOARD],
      totals: { ...zeroCatalogRunCounters(), problems: 10 },
    });

    writeCatalogRunReportAtomic(reportPath, report);

    const written = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    assert.deepEqual(written, report);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test('writeCatalogRunReportAtomic leaves no temp file behind', () => {
  const tempDir = makeTempDir();
  try {
    const reportPath = path.join(tempDir, 'report.json');
    writeCatalogRunReportAtomic(
      reportPath,
      buildCatalogRunReport({
        dryRun: false,
        startedAt: new Date(),
        finishedAt: new Date(),
        boards: [],
        totals: zeroCatalogRunCounters(),
      }),
    );

    const entries = fs.readdirSync(tempDir);
    assert.deepEqual(entries, ['report.json']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test('writeCatalogRunReportAtomic removes the temp file when the rename fails', () => {
  const tempDir = makeTempDir();
  try {
    const reportPath = path.join(tempDir, 'report.json');
    // Occupy the target with a directory: renaming a plain file onto it fails
    // (EISDIR), which is what should trigger the temp-file cleanup.
    fs.mkdirSync(reportPath);
    const report = buildCatalogRunReport({
      dryRun: false,
      startedAt: new Date(),
      finishedAt: new Date(),
      boards: [],
      totals: zeroCatalogRunCounters(),
    });

    assert.throws(() => writeCatalogRunReportAtomic(reportPath, report));

    // Only the pre-existing directory should remain — no leftover .tmp file.
    assert.deepEqual(fs.readdirSync(tempDir), ['report.json']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test('writeCatalogRunReportAtomic overwrites a previous report at the same path', () => {
  const tempDir = makeTempDir();
  try {
    const reportPath = path.join(tempDir, 'report.json');
    writeCatalogRunReportAtomic(
      reportPath,
      buildCatalogRunReport({
        dryRun: true,
        startedAt: new Date(),
        finishedAt: new Date(),
        boards: [],
        totals: zeroCatalogRunCounters(),
      }),
    );
    writeCatalogRunReportAtomic(
      reportPath,
      buildCatalogRunReport({
        dryRun: false,
        startedAt: new Date(),
        finishedAt: new Date(),
        boards: [],
        totals: zeroCatalogRunCounters(),
      }),
    );

    const written = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    assert.equal(written.dryRun, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

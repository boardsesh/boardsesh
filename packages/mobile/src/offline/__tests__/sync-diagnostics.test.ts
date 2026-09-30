import { afterEach, expect, it } from 'vitest';
import type { SyncProgress } from '@boardsesh/offline-sync';
import { createSyncDiagnostics } from '../sync-diagnostics';
import { getDiagnosticSnapshot, setDiagnosticSink, type DiagnosticBreadcrumb } from '../../lib/mobile-diagnostics';

afterEach(() => setDiagnosticSink(undefined));

it('records phases and snapshot stages, not per-row or per-byte progress', () => {
  const emitted: DiagnosticBreadcrumb[] = [];
  setDiagnosticSink((_snapshot, breadcrumb) => {
    if (breadcrumb) emitted.push(breadcrumb);
  });
  const cycle = createSyncDiagnostics('test.sync');
  cycle.begin();
  for (let count = 0; count < 1000; count++) {
    cycle.progress({
      phase: 'bootstrap',
      currentTable: 'kilter:8:25',
      documentsProcessed: count,
      snapshot: {
        scopeKey: 'kilter:8:25',
        stage: 'download',
        fraction: count / 1000,
        wireBytes: 1000,
        wireBytesDone: count,
      },
    });
  }
  cycle.progress({
    phase: 'bootstrap',
    currentTable: 'kilter:8:25',
    documentsProcessed: 1000,
    snapshot: { scopeKey: 'kilter:8:25', stage: 'import', fraction: null, wireBytes: 1000, wireBytesDone: 1000 },
  });
  cycle.progress({ phase: 'deletions', currentTable: null, documentsProcessed: 1000 });
  cycle.progress({ phase: 'idle', currentTable: null, documentsProcessed: 1000 });
  expect(emitted.map((breadcrumb) => breadcrumb.message)).toEqual([
    'test.sync.begin',
    'test.sync.outbox',
    'test.sync.snapshot_download',
    'test.sync.snapshot_import',
    'test.sync.deletions',
    'test.sync.finish',
  ]);
  expect(getDiagnosticSnapshot().completed.data?.outcome).toBe('success');
});

it.each([
  [{ failed: true }, 'failure'],
  [{ interrupted: true }, 'cancelled'],
] as const)('classifies terminal idle %j as %s', (attributes, outcome) => {
  const cycle = createSyncDiagnostics('test.sync');
  cycle.begin();
  cycle.progress({ phase: 'idle', currentTable: null, documentsProcessed: 0, ...attributes });
  cycle.complete();
  expect(getDiagnosticSnapshot().completed.data?.outcome).toBe(outcome);
});

it('cancels cleanup and ignores late callbacks or starts', () => {
  const cycle = createSyncDiagnostics('test.sync');
  cycle.begin();
  cycle.dispose();
  const snapshot = getDiagnosticSnapshot();
  cycle.progress({ phase: 'user_data', currentTable: null, documentsProcessed: 1 });
  cycle.progress({ phase: 'idle', currentTable: null, documentsProcessed: 1 });
  cycle.begin();
  expect(getDiagnosticSnapshot()).toEqual(snapshot);
  expect(snapshot.completed.data?.outcome).toBe('cancelled');
});

it('finishes a drain failure before any pull frame and keeps the error payload private', () => {
  const cycle = createSyncDiagnostics('test.sync');
  cycle.begin();
  cycle.error(new Error('secret server response'));
  cycle.progress({ phase: 'idle', currentTable: null, documentsProcessed: 0, failed: true } satisfies SyncProgress);
  expect(getDiagnosticSnapshot().completed.data?.outcome).toBe('failure');
  expect(JSON.stringify(getDiagnosticSnapshot())).not.toContain('secret server response');
});

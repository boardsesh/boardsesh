import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseReconciliationArgs, readReconciliationCatalog } from './report-moonboard-reconciliation.js';

void test('CLI rejects mistyped, missing, repeated and extra arguments', () => {
  const valid = ['catalog', '--previous', 'older', '--out', 'report.json'];
  assert.deepEqual(parseReconciliationArgs(['--', ...valid]), {
    catalog: 'catalog',
    previous: 'older',
    out: 'report.json',
  });
  for (const invalid of [
    [],
    ['catalog'],
    [...valid, '--dryrun'],
    ['catalog', '--previous', '--out', 'report'],
    [...valid, 'extra'],
    [...valid, '--previous', 'other'],
    [...valid, '--out', 'other'],
  ])
    assert.throws(() => parseReconciliationArgs(invalid));
});

void test('reader ignores sidecars, validates counts and board ids, and refuses duplicate problems', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'moonboard-report-'));
  try {
    const filename = path.join(directory, 'board.json');
    const problem = { id: 1, name: 'One', moves: 's~A1~|e~B2~', configurations: [] };
    const capture = { holdsetup: 1, count: 1, problems: [problem] };
    fs.writeFileSync(path.join(directory, 'beta.json'), JSON.stringify({ schemaVersion: 1, problems: { 1: [] } }));
    fs.writeFileSync(filename, JSON.stringify(capture));
    assert.equal(readReconciliationCatalog(directory)[0].layoutId, 2);
    for (const invalid of [
      { ...capture, count: 2 },
      { ...capture, holdsetup: 99 },
      { ...capture, problems: null },
      { count: 1, problems: [problem] },
      { ...capture, count: 2, problems: [problem, problem] },
    ]) {
      fs.writeFileSync(filename, JSON.stringify(invalid));
      assert.throws(() => readReconciliationCatalog(directory));
    }
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

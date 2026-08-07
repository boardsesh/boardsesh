import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRepairManifest,
  classifyFingerprint,
  digestRepairManifest,
  fingerprintFromLegacyFrameTokens,
  fingerprintFromRepairRows,
  placementKey,
  strictlyProjectStoredRows,
  type RepairClimbInput,
  type RepairHoldRow,
} from './repair-board-climb-holds-helpers.js';

const placements = new Set([
  placementKey('tension', 1, 1),
  placementKey('tension', 1, 2),
  placementKey('tension', 1, 3),
]);

function climb(overrides: Partial<RepairClimbInput> = {}): RepairClimbInput {
  return {
    boardType: 'tension',
    uuid: 'climb-1',
    layoutId: 1,
    frames: 'p1r1,"p2r2',
    framesCount: 2,
    holdFingerprint: null,
    multiFrameTarget: true,
    rows: [],
    ...overrides,
  };
}

void test('strict projection accepts deltas, quoted hold frames, and later absolute frames', () => {
  const result = strictlyProjectStoredRows('tension', 'p1r1,",p2r2', 3);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.rows, [
    { holdId: 1, frameNumber: 0, holdState: 'STARTING' },
    { holdId: 2, frameNumber: 2, holdState: 'HAND' },
  ]);
});

void test('strict projection rejects incomplete tokens, empty absolute frames, and frame-count drift', () => {
  const malformed = strictlyProjectStoredRows('tension', 'p1r1junk,"p2r2', 2);
  assert.equal(malformed.ok, false);
  const emptyAbsolute = strictlyProjectStoredRows('tension', 'p1r1,,p2r2', 3);
  assert.equal(emptyAbsolute.ok, false);
  const countDrift = strictlyProjectStoredRows('tension', 'p1r1,"p2r2', 3);
  assert.equal(countDrift.ok, false);
});

void test('strict projection accepts the delayed-start encoding our own catalog writer emits', () => {
  // `decodeGripsClimbConcat('h10p13s2', …, 2)` writes exactly this pair, and
  // catalog-sync stores frames_count 2 alongside it.
  const result = strictlyProjectStoredRows('kilter', ',"p100r13', 2);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.rows, [{ holdId: 100, frameNumber: 0, holdState: 'HAND' }]);
});

void test('a delayed-start climb whose rows are already canonical plans no mutation', () => {
  const manifest = buildRepairManifest(
    [
      {
        boardType: 'kilter',
        uuid: 'delayed-start',
        layoutId: 1,
        frames: ',"p100r13',
        framesCount: 2,
        holdFingerprint: fingerprintFromRepairRows([{ holdId: 100, frameNumber: 0, holdState: 'HAND' }]),
        multiFrameTarget: true,
        rows: [{ holdId: 100, frameNumber: 0, holdState: 'HAND' }],
      },
    ],
    new Set([placementKey('kilter', 1, 100)]),
  );

  assert.equal(manifest.counts.blockers, 0);
  assert.equal(manifest.counts.changedMultiFrameClimbs, 0);
  assert.equal(manifest.counts.affectedClimbs, 0);
  assert.equal(manifest.entries[0]?.fingerprint.classification, 'already-current');
});

void test('strict projection still blocks an empty absolute frame after frame 0', () => {
  const trailing = strictlyProjectStoredRows('kilter', 'p1r13,', 2);
  assert.equal(trailing.ok, false);
  if (!trailing.ok) assert.match(trailing.errors.join('\n'), /frame 1 is an empty unquoted absolute frame/);
});

void test('strict projection blocks hold IDs that cannot enter an integer recordset', () => {
  const result = strictlyProjectStoredRows('tension', 'p2147483648r2', 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join('\n'), /outside the PostgreSQL integer range/);
});

void test('strict projection rejects unsupported boards and accepts an empty valid projection for cleanup', () => {
  assert.equal(strictlyProjectStoredRows('moonboard', 'p1r42,p2r43', 2).ok, false);
  const emptyProjection = strictlyProjectStoredRows('tension', 'p0r1,"p1r999', 2);
  assert.equal(emptyProjection.ok, true);
  if (!emptyProjection.ok) return;
  assert.deepEqual(emptyProjection.rows, []);
  assert.equal(emptyProjection.skippedNonpositiveHoldIdTokens, 1);
  assert.equal(emptyProjection.skippedUnknownRoleTokens, 1);
});

void test('manifest deletes stale rows when valid multi-frame input projects to no canonical holds', () => {
  const manifest = buildRepairManifest(
    [
      climb({
        frames: 'p0r1,"p1r999',
        rows: [
          { holdId: 0, frameNumber: 0, holdState: 'STARTING' },
          { holdId: 1, frameNumber: 1, holdState: '1=999' },
        ],
      }),
    ],
    placements,
  );
  assert.equal(manifest.counts.blockers, 0);
  assert.equal(manifest.counts.changedMultiFrameClimbs, 1);
  assert.equal(manifest.counts.deleteRows, 2);
  assert.equal(manifest.counts.insertRows, 0);
  assert.deepEqual(manifest.entries[0]?.projectedRows, []);
});

void test('manifest repairs stale multi-frame rows even when no sentinel is present', () => {
  const manifest = buildRepairManifest(
    [
      climb({
        rows: [
          { holdId: 1, frameNumber: 0, holdState: 'STARTING' },
          { holdId: 2, frameNumber: 0, holdState: 'HAND' },
        ],
      }),
    ],
    placements,
  );
  assert.equal(manifest.counts.changedMultiFrameClimbs, 1);
  assert.deepEqual(manifest.entries[0].projectedRows, [
    { holdId: 1, frameNumber: 0, holdState: 'STARTING' },
    { holdId: 2, frameNumber: 1, holdState: 'HAND' },
  ]);
});

void test('manifest sorts and deduplicates missing placement blockers without hiding the mutation plan', () => {
  const projectedRows = [
    { holdId: 1, frameNumber: 0, holdState: 'STARTING' },
    { holdId: 2, frameNumber: 1, holdState: 'HAND' },
    { holdId: 3, frameNumber: 0, holdState: 'HAND' },
  ];
  const manifest = buildRepairManifest(
    [
      climb({
        frames: 'p3r2p1r1,"p2r2p3r3',
        rows: [],
      }),
    ],
    new Set([placementKey('tension', 1, 1)]),
  );

  assert.deepEqual(manifest.entries[0]?.diagnostics.missingPlacementHoldIds, [2, 3]);
  assert.deepEqual(manifest.entries[0]?.blockers, ['missing board placements: 2,3']);
  assert.equal(manifest.entries[0]?.changed, true);
  assert.deepEqual(manifest.entries[0]?.projectedRows, projectedRows);
  assert.equal(manifest.entries[0]?.rowHashes.projected, fingerprintFromRepairRows(projectedRows));
  assert.equal(manifest.counts.missingPlacements, 2);
  assert.equal(manifest.counts.blockers, 1);
  assert.equal(manifest.counts.changedMultiFrameClimbs, 1);
  assert.equal(manifest.counts.affectedClimbs, 1);
  assert.equal(manifest.counts.insertRows, 3);
});

void test('manifest deletes only invalid rows from a non-target single-frame climb', () => {
  const manifest = buildRepairManifest(
    [
      climb({
        uuid: 'single',
        frames: 'p1r1p2r2',
        framesCount: 1,
        multiFrameTarget: false,
        rows: [
          { holdId: 0, frameNumber: 0, holdState: '0=undefined' },
          { holdId: 1, frameNumber: 0, holdState: 'STARTING' },
        ],
      }),
    ],
    placements,
  );
  assert.equal(manifest.counts.changedMultiFrameClimbs, 0);
  assert.equal(manifest.counts.invalidRows, 1);
  assert.equal(manifest.counts.deleteRows, 1);
  assert.equal(manifest.counts.insertRows, 0);
});

void test('globally invalid cleanup includes negative hold IDs', () => {
  const manifest = buildRepairManifest(
    [
      climb({
        uuid: 'negative',
        multiFrameTarget: false,
        rows: [
          { holdId: -7, frameNumber: 0, holdState: 'HAND' },
          { holdId: 1, frameNumber: 0, holdState: 'STARTING' },
        ],
      }),
    ],
    placements,
  );
  assert.equal(manifest.counts.invalidRows, 1);
  assert.equal(manifest.counts.deleteRows, 1);
  assert.deepEqual(manifest.entries[0]?.invalidRows, [{ holdId: -7, frameNumber: 0, holdState: 'HAND' }]);
});

void test('invalid-only cleanup clears a proven row-derived fingerprint instead of hashing an empty hold set', () => {
  const invalidRows = [{ holdId: 0, frameNumber: 0, holdState: 'HAND' }];
  const manifest = buildRepairManifest(
    [
      {
        boardType: 'kilter',
        uuid: 'invalid-only',
        layoutId: 1,
        frames: 'p0r13',
        framesCount: 1,
        holdFingerprint: fingerprintFromRepairRows(invalidRows),
        multiFrameTarget: false,
        rows: invalidRows,
      },
    ],
    new Set(),
  );

  assert.deepEqual(manifest.entries[0]?.fingerprint, {
    classification: 'row-derived',
    old: fingerprintFromRepairRows(invalidRows),
    projected: null,
    shouldUpdate: true,
  });
  assert.equal(manifest.counts.affectedClimbs, 1);
  assert.equal(manifest.counts.deleteRows, 1);
  assert.equal(manifest.counts.insertRows, 0);
  assert.equal(manifest.counts.fingerprintUpdates, 1);
});

void test('malformed and frame-count mismatches are blockers and have no mutation plan', () => {
  const manifest = buildRepairManifest(
    [climb({ frames: 'p1r1bad,"p2r2' }), climb({ uuid: 'count', framesCount: 3 })],
    placements,
  );
  assert.equal(manifest.counts.blockers, 2);
  assert.equal(manifest.counts.affectedClimbs, 0);
});

void test('digest is stable across input and row order and changes on drift', () => {
  const firstRows: RepairHoldRow[] = [
    { holdId: 2, frameNumber: 1, holdState: 'HAND' },
    { holdId: 1, frameNumber: 0, holdState: 'STARTING' },
  ];
  const first = buildRepairManifest(
    [climb({ uuid: 'b', rows: firstRows }), climb({ uuid: 'a', rows: [] })],
    placements,
  );
  const reordered = buildRepairManifest(
    [climb({ uuid: 'a', rows: [] }), climb({ uuid: 'b', rows: [...firstRows].reverse() })],
    placements,
  );
  assert.equal(digestRepairManifest(first), digestRepairManifest(reordered));
  const drifted = buildRepairManifest([climb({ uuid: 'b', rows: firstRows.slice(1) })], placements);
  assert.notEqual(digestRepairManifest(first), digestRepairManifest(drifted));
});

void test('fingerprints update only when the current value proves it came from exact old rows', () => {
  const oldRows = [{ holdId: 1, frameNumber: 1, holdState: 'STARTING' }];
  const projectedRows = [{ holdId: 1, frameNumber: 0, holdState: 'STARTING' }];
  assert.equal(classifyFingerprint(null, oldRows, projectedRows), 'null');
  assert.equal(
    classifyFingerprint(fingerprintFromRepairRows(projectedRows), oldRows, projectedRows),
    'already-current',
  );
  assert.equal(classifyFingerprint(fingerprintFromRepairRows(oldRows), oldRows, projectedRows), 'row-derived');
  assert.equal(classifyFingerprint('independent-source-fingerprint', oldRows, projectedRows), 'independent');
});

void test('historical relight fingerprints are proven from frame tokens and migrated to projected rows', () => {
  const frames = 'p1r1,"x1p1r2';
  const oldRows = [{ holdId: 1, frameNumber: 0, holdState: 'STARTING' }];
  const projectedRows = [{ holdId: 1, frameNumber: 0, holdState: 'STARTING' }];
  const legacyFingerprint = fingerprintFromLegacyFrameTokens('tension', frames);
  assert.equal(
    legacyFingerprint,
    fingerprintFromRepairRows([
      { holdId: 1, frameNumber: 0, holdState: 'STARTING' },
      { holdId: 1, frameNumber: 1, holdState: 'HAND' },
    ]),
  );
  assert.equal(
    classifyFingerprint(legacyFingerprint, oldRows, projectedRows, legacyFingerprint),
    'legacy-frame-derived',
  );

  const manifest = buildRepairManifest(
    [climb({ frames, holdFingerprint: legacyFingerprint, rows: oldRows })],
    placements,
  );
  assert.equal(manifest.counts.changedMultiFrameClimbs, 0);
  assert.equal(manifest.counts.fingerprintUpdates, 1);
  assert.equal(manifest.counts.affectedClimbs, 1);
  assert.deepEqual(manifest.entries[0]?.fingerprint, {
    classification: 'legacy-frame-derived',
    old: legacyFingerprint,
    projected: fingerprintFromRepairRows(projectedRows),
    shouldUpdate: true,
  });
});

void test('an authoritative empty projection clears SHA256(empty) without touching independent fingerprints', () => {
  const emptyFingerprint = fingerprintFromRepairRows([]);
  const emptyManifest = buildRepairManifest(
    [
      climb({
        frames: 'x1,"',
        framesCount: 2,
        holdFingerprint: emptyFingerprint,
        rows: [{ holdId: 1, frameNumber: 0, holdState: 'STARTING' }],
      }),
    ],
    placements,
  );
  assert.deepEqual(emptyManifest.entries[0]?.fingerprint, {
    classification: 'row-derived',
    old: emptyFingerprint,
    projected: null,
    shouldUpdate: true,
  });
  assert.equal(emptyManifest.counts.affectedClimbs, 1);

  const independentManifest = buildRepairManifest(
    [climb({ holdFingerprint: 'independent-source-fingerprint' })],
    placements,
  );
  assert.equal(independentManifest.entries[0]?.fingerprint.classification, 'independent');
  assert.equal(independentManifest.entries[0]?.fingerprint.shouldUpdate, false);
});

void test('an unchanged authoritative empty projection still clears its row-derived empty fingerprint', () => {
  const emptyFingerprint = fingerprintFromRepairRows([]);
  const manifest = buildRepairManifest(
    [climb({ frames: 'x1,"', framesCount: 2, holdFingerprint: emptyFingerprint, rows: [] })],
    placements,
  );

  assert.equal(manifest.counts.changedMultiFrameClimbs, 0);
  assert.equal(manifest.counts.deleteRows, 0);
  assert.equal(manifest.counts.fingerprintUpdates, 1);
  assert.equal(manifest.counts.affectedClimbs, 1);
  assert.deepEqual(manifest.entries[0]?.fingerprint, {
    classification: 'row-derived',
    old: emptyFingerprint,
    projected: null,
    shouldUpdate: true,
  });
});

void test('blocked multi-frame input never plans a fingerprint-only mutation', () => {
  const invalidRows = [{ holdId: 0, frameNumber: 0, holdState: '0=999' }];
  const manifest = buildRepairManifest(
    [climb({ frames: 'malformed', holdFingerprint: fingerprintFromRepairRows(invalidRows), rows: invalidRows })],
    placements,
  );
  assert.ok(manifest.counts.blockers > 0);
  assert.equal(manifest.counts.affectedClimbs, 0);
  assert.equal(manifest.counts.fingerprintUpdates, 0);
  assert.equal(manifest.entries[0]?.fingerprint.shouldUpdate, false);
});

void test('a logically repaired manifest is idempotent', () => {
  const first = buildRepairManifest([climb()], placements);
  const projectedRows = first.entries[0].projectedRows;
  assert.ok(projectedRows);
  const second = buildRepairManifest([climb({ rows: projectedRows })], placements);
  assert.equal(second.counts.changedMultiFrameClimbs, 0);
  assert.equal(second.counts.invalidRows, 0);
});

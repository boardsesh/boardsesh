import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogProblemIndex, classifyWithdrawnClimbs, type ListedClimb } from './moonboard-withdrawn-report.js';
import { catalogClimbUuid } from './moonboard-catalog-helpers.js';

const LIVE_ID = 100;
const DELETED_ID = 200;
const VANISHED_ID = 300;
const NEVER_IMPORTED_ID = 400;

const LIVE_UUID = catalogClimbUuid({ id: LIVE_ID });
const DELETED_UUID = catalogClimbUuid({ id: DELETED_ID });
const VANISHED_UUID = catalogClimbUuid({ id: VANISHED_ID });

/** Self-aliases, which is what the catalog importer writes for an unmerged climb. */
function selfAliases(...uuids: string[]) {
  return new Map(uuids.map((uuid) => [uuid, uuid]));
}

function climb(uuid: string, overrides: Partial<ListedClimb> = {}): ListedClimb {
  return { uuid, layoutId: 2, name: 'A Problem', setterUsername: 'someone', ...overrides };
}

void test('a live problem backs its climb, so it is not reported', () => {
  const index = buildCatalogProblemIndex({
    problems: [{ id: LIVE_ID, dateDeleted: null, Active: true }],
    canonicalByAlias: selfAliases(LIVE_UUID),
  });

  assert.deepEqual(classifyWithdrawnClimbs([climb(LIVE_UUID)], index), []);
});

void test('a soft-deleted problem is reported as withdrawn-upstream', () => {
  const index = buildCatalogProblemIndex({
    problems: [{ id: DELETED_ID, dateDeleted: '2026-03-01T10:00:00', Active: true }],
    canonicalByAlias: selfAliases(DELETED_UUID),
  });

  const [reported] = classifyWithdrawnClimbs([climb(DELETED_UUID)], index);
  assert.equal(reported.reason, 'withdrawn-upstream');
});

void test('a problem only in the previous capture is reported as vanished-from-capture', () => {
  const index = buildCatalogProblemIndex({
    problems: [{ id: LIVE_ID, dateDeleted: null, Active: true }],
    previousProblemIds: [LIVE_ID, VANISHED_ID],
    canonicalByAlias: selfAliases(LIVE_UUID, VANISHED_UUID),
  });

  const [reported] = classifyWithdrawnClimbs([climb(VANISHED_UUID)], index);
  assert.equal(reported.reason, 'vanished-from-capture');
});

void test('without --previous, a vanished problem falls into no-catalog-alias', () => {
  // The honest fallback: we cannot tell a vanished problem from a legacy row
  // without the earlier capture, so the report says so rather than guessing.
  const index = buildCatalogProblemIndex({
    problems: [{ id: LIVE_ID, dateDeleted: null, Active: true }],
    canonicalByAlias: selfAliases(LIVE_UUID, VANISHED_UUID),
  });

  const [reported] = classifyWithdrawnClimbs([climb(VANISHED_UUID)], index);
  assert.equal(reported.reason, 'no-catalog-alias');
});

void test('a climb no catalog problem resolves to is reported as no-catalog-alias', () => {
  const index = buildCatalogProblemIndex({
    problems: [{ id: LIVE_ID, dateDeleted: null, Active: true }],
    canonicalByAlias: selfAliases(LIVE_UUID),
  });

  const [reported] = classifyWithdrawnClimbs([climb('legacy-uuid')], index);
  assert.equal(reported.reason, 'no-catalog-alias');
});

void test('a climb a live problem shares with a deleted one is NOT reported', () => {
  // Two problems collapsing onto one climb is routine. One of them being
  // withdrawn says nothing about a climb the other still publishes.
  const shared = 'shared-climb-uuid';
  const index = buildCatalogProblemIndex({
    problems: [
      { id: LIVE_ID, dateDeleted: null, Active: true },
      { id: DELETED_ID, dateDeleted: '2026-03-01T10:00:00', Active: true },
    ],
    previousProblemIds: [VANISHED_ID],
    canonicalByAlias: new Map([
      [LIVE_UUID, shared],
      [DELETED_UUID, shared],
      [VANISHED_UUID, shared],
    ]),
  });

  assert.deepEqual(classifyWithdrawnClimbs([climb(shared)], index), []);
});

void test('an explicit dateDeleted outranks absence from the capture', () => {
  const shared = 'shared-climb-uuid';
  const index = buildCatalogProblemIndex({
    problems: [{ id: DELETED_ID, dateDeleted: '2026-03-01T10:00:00', Active: true }],
    previousProblemIds: [VANISHED_ID],
    canonicalByAlias: new Map([
      [DELETED_UUID, shared],
      [VANISHED_UUID, shared],
    ]),
  });

  const [reported] = classifyWithdrawnClimbs([climb(shared)], index);
  assert.equal(reported.reason, 'withdrawn-upstream');
});

void test('resolution follows the alias chain to its terminal canonical', () => {
  const merged = 'merge-target-uuid';
  const index = buildCatalogProblemIndex({
    problems: [{ id: LIVE_ID, dateDeleted: null, Active: true }],
    canonicalByAlias: new Map([
      [LIVE_UUID, 'intermediate-uuid'],
      ['intermediate-uuid', merged],
      [merged, merged],
    ]),
  });

  assert.deepEqual(classifyWithdrawnClimbs([climb(merged)], index), []);
});

void test('a problem that was never imported contributes nothing to the index', () => {
  const index = buildCatalogProblemIndex({
    problems: [{ id: NEVER_IMPORTED_ID, dateDeleted: '2026-03-01T10:00:00', Active: true }],
    canonicalByAlias: new Map(),
  });

  assert.equal(index.liveUuids.size, 0);
  assert.equal(index.withdrawnUuids.size, 0);
});

void test('Active=false counts as withdrawn, matching the importer', () => {
  const index = buildCatalogProblemIndex({
    problems: [{ id: DELETED_ID, dateDeleted: null, Active: false }],
    canonicalByAlias: selfAliases(DELETED_UUID),
  });

  const [reported] = classifyWithdrawnClimbs([climb(DELETED_UUID)], index);
  assert.equal(reported.reason, 'withdrawn-upstream');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv5 } from './moonboard-helpers.js';
import { fingerprintFromHolds } from './moonboard-2024-helpers.js';
import {
  WOODS_UUID_NAMESPACE,
  WOODS_LAYOUT_ID,
  WOODS_MAX_GRADE,
  WOODS_MIN_GRADE,
  woodsHoldState,
  parseHoldList,
  holdsToFrames,
  woodsClimbUuid,
  dimensionToSizeIds,
  mapWoodsProblemToClimb,
  woodsGradeRows,
  WOODS_REQUIRED_SET_IDS,
  type WoodsCatalogProblem,
} from './woods-catalog-helpers.js';
import { getWoodsBoardDetails } from '@boardsesh/board-config';

// "Impossible" — id 5228 from the real woodsboard_12x12.json catalog, with the
// holdList deliberately shuffled out of order and a "Clear" hold spliced in, to
// prove the mapper sorts ascending and drops Clear holds. The expected values
// below were cross-checked against the catalog's first problem.
const IMPOSSIBLE: WoodsCatalogProblem = {
  id: 5228,
  problemName: 'Impossible ',
  problemGrade: 0,
  proposedGrade: 0,
  communitySuggestedGrade: 0,
  author: '23chloec',
  angle: 20,
  boardDimension: '12x12',
  holdCount: 5,
  holdList: [
    { type: 'Start', baseHoldLocation: 793 },
    { type: 'Hand', baseHoldLocation: 464 },
    { type: 'Clear', baseHoldLocation: 999 }, // not a climb hold — dropped
    { type: 'Finish', baseHoldLocation: 273 },
    { type: 'Hand', baseHoldLocation: 664 },
    { type: 'Hand', baseHoldLocation: 337 },
  ],
  repeats: 0,
  totalLogLikes: 0,
  totalLogDislikes: 0,
  datePublished: '06/26/2026 01:28:10',
  notes: '',
  isProject: false,
  firstAscent: '',
};

// Sorted ascending by baseHoldLocation: 273(Finish→r3) 337(Hand→r2) 464(Hand→r2)
// 664(Hand→r2) 793(Start→r4). The Start is the highest location, so frames end r4.
const EXPECTED_FRAMES = 'p273r3p337r2p464r2p664r2p793r4';
const EXPECTED_FINGERPRINT = 'ca6d54ebabdfca1a95cf2b1c0f3a928e41f0da9dbe90bd03ccdab2d130c3568d';
const EXPECTED_UUID = 'ef9aa942-d3c1-59b3-8f57-b6169d2a3845';

void test('woodsHoldState maps the four states and drops Clear / unknown', () => {
  assert.equal(woodsHoldState('Start'), 'STARTING');
  assert.equal(woodsHoldState('Hand'), 'HAND');
  assert.equal(woodsHoldState('Finish'), 'FINISH');
  assert.equal(woodsHoldState('Foot'), 'FOOT');
  assert.equal(woodsHoldState('Clear'), null);
  assert.equal(woodsHoldState('Bogus'), null);
});

void test('parseHoldList drops Clear holds and sorts ascending by baseHoldLocation', () => {
  const holds = parseHoldList(IMPOSSIBLE.holdList);
  assert.equal(holds.length, 5); // the Clear hold is gone
  assert.deepEqual(
    holds.map((hold) => hold.holdId),
    [273, 337, 464, 664, 793],
  );
  assert.deepEqual(holds, [
    { holdId: 273, holdState: 'FINISH', roleCode: 3 },
    { holdId: 337, holdState: 'HAND', roleCode: 2 },
    { holdId: 464, holdState: 'HAND', roleCode: 2 },
    { holdId: 664, holdState: 'HAND', roleCode: 2 },
    { holdId: 793, holdState: 'STARTING', roleCode: 4 },
  ]);
});

void test('holdsToFrames encodes p{baseHoldLocation}r{roleCode}, Start ending in r4', () => {
  const frames = holdsToFrames(parseHoldList(IMPOSSIBLE.holdList));
  assert.equal(frames, EXPECTED_FRAMES);
  assert.ok(frames.endsWith('r4')); // the Start hold's role code is 4
});

void test('woodsClimbUuid is deterministic, namespace-keyed, and a valid v5 UUID', () => {
  const uuid = woodsClimbUuid({ name: 'Impossible ', author: '23chloec', frames: EXPECTED_FRAMES });
  assert.equal(uuid, uuidv5('Impossible |23chloec|' + EXPECTED_FRAMES, WOODS_UUID_NAMESPACE));
  assert.equal(uuid, EXPECTED_UUID);
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

void test('woodsClimbUuid changes when the frames (holds) change', () => {
  const base = woodsClimbUuid({ name: 'Impossible ', author: '23chloec', frames: EXPECTED_FRAMES });
  const differentFrames = woodsClimbUuid({
    name: 'Impossible ',
    author: '23chloec',
    frames: EXPECTED_FRAMES + 'p900r2',
  });
  const differentName = woodsClimbUuid({ name: 'Other', author: '23chloec', frames: EXPECTED_FRAMES });
  assert.notEqual(base, differentFrames);
  assert.notEqual(base, differentName);
});

void test('fingerprintFromHolds is stable for the same holds (copies the canonical algorithm)', () => {
  const holds = parseHoldList(IMPOSSIBLE.holdList).map((hold) => ({ holdId: hold.holdId, holdState: hold.holdState }));
  assert.equal(fingerprintFromHolds(holds), EXPECTED_FINGERPRINT);
  // Order-independent: shuffling the input still yields the same fingerprint.
  assert.equal(fingerprintFromHolds([...holds].reverse()), EXPECTED_FINGERPRINT);
});

void test('dimensionToSizeIds maps both board sizes', () => {
  assert.deepEqual(dimensionToSizeIds('8x10'), [1]);
  assert.deepEqual(dimensionToSizeIds('12x12'), [2]);
  assert.deepEqual(dimensionToSizeIds('bogus'), []);
});

void test('mapWoodsProblemToClimb fills the full climb payload', () => {
  const mapped = mapWoodsProblemToClimb(IMPOSSIBLE);
  assert.notEqual(mapped, null);
  assert.equal(mapped!.uuid, EXPECTED_UUID);
  assert.equal(mapped!.frames, EXPECTED_FRAMES);
  assert.equal(mapped!.holdFingerprint, EXPECTED_FINGERPRINT);
  assert.equal(mapped!.layoutId, WOODS_LAYOUT_ID);
  assert.equal(mapped!.angle, 20);
  assert.equal(mapped!.name, 'Impossible ');
  assert.equal(mapped!.setterUsername, '23chloec');
  assert.deepEqual(mapped!.compatibleSizeIds, [2]); // 12x12
  assert.equal(mapped!.difficulty, 0);
  assert.equal(mapped!.ascensionistCount, 0);
  assert.equal(mapped!.qualityAverage, null); // no 1-5 community rating in the API
  assert.equal(mapped!.createdAt, '06/26/2026 01:28:10');
  assert.equal(mapped!.holds.length, 5); // Clear hold dropped
});

void test('mapWoodsProblemToClimb keys the UUID off the trimmed author, matching setterUsername', () => {
  // A padded author must not mint a second climb for the same physical problem:
  // the stored setter_username is trimmed, so the UUID input has to be too.
  const padded = mapWoodsProblemToClimb({ ...IMPOSSIBLE, author: '  23chloec  ' });
  assert.equal(padded!.setterUsername, '23chloec');
  assert.equal(padded!.uuid, EXPECTED_UUID);
});

void test('mapWoodsProblemToClimb derives compatibleSizeIds from the 8x10 dimension', () => {
  const mapped = mapWoodsProblemToClimb({ ...IMPOSSIBLE, boardDimension: '8x10' });
  assert.deepEqual(mapped!.compatibleSizeIds, [1]);
});

void test('mapWoodsProblemToClimb returns null for empty or Clear-only holds', () => {
  assert.equal(mapWoodsProblemToClimb({ ...IMPOSSIBLE, holdList: [] }), null);
  assert.equal(mapWoodsProblemToClimb({ ...IMPOSSIBLE, holdList: [{ type: 'Clear', baseHoldLocation: 1 }] }), null);
});

void test('WOODS_REQUIRED_SET_IDS is empty and agrees with the board config exposing no sets', () => {
  // The Woods board has no add-on hold sets, so the board config hands out an
  // empty set_ids list. required_set_ids must agree: search and playlists filter
  // with `required_set_ids <@ ARRAY[selected]`, and `{} <@ anything` is true, so
  // an empty array can never hide a Woods climb. A placeholder `{1}` would fail
  // containment against the board's own (empty) set list.
  assert.deepEqual(WOODS_REQUIRED_SET_IDS, []);
  assert.deepEqual(getWoodsBoardDetails({ size_id: 1 }).set_ids, []);
  assert.deepEqual(getWoodsBoardDetails({ size_id: 2 }).set_ids, []);
});

void test('woodsGradeRows covers the full 0-17 scale with 0-based V labels', () => {
  const rows = woodsGradeRows();
  assert.equal(rows.length, WOODS_MAX_GRADE - WOODS_MIN_GRADE + 1); // 18 rows
  assert.deepEqual(
    rows.map((row) => row.difficulty),
    Array.from({ length: 18 }, (_unused, index) => index),
  );
  assert.deepEqual(rows[0], { boardType: 'woods', difficulty: 0, boulderName: 'V0', routeName: null, isListed: true });
  assert.deepEqual(rows[17], {
    boardType: 'woods',
    difficulty: 17,
    boulderName: 'V17',
    routeName: null,
    isListed: true,
  });
  assert.ok(rows.every((row) => row.routeName === null && row.isListed === true && row.boardType === 'woods'));
});

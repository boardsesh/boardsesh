import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv5 } from './moonboard-helpers.js';
import { fingerprintFromHolds } from './moonboard-2024-helpers.js';
import {
  WOODS_UUID_NAMESPACE,
  WOODS_LAYOUT_ID,
  WOODS_CLAMPED_GRADES,
  woodsHoldState,
  parseHoldList,
  holdsToFrames,
  woodsClimbUuid,
  dimensionToSizeIds,
  WOODS_DIMENSION_TO_SIZE_IDS,
  normalizeWoodsPublishedDate,
  mapWoodsProblemToClimb,
  parseWoodsCatalogFile,
  woodsGradeRows,
  WOODS_REQUIRED_SET_IDS,
  type WoodsCatalogProblem,
} from './woods-catalog-helpers.js';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';
import { WOODS_DIFFICULTY_IDS } from '@boardsesh/board-constants/woods';
import { getWoodsBoardDetails } from '@boardsesh/board-config';

// "Impossible" — id 5228 from the real woodsboard_12x12.json catalog, with the
// holdList deliberately shuffled out of order and a "Clear" hold spliced in, to
// prove the mapper sorts ascending and drops Clear holds. The expected values
// below were cross-checked against the catalog's first problem.
const IMPOSSIBLE: WoodsCatalogProblem = {
  id: 5228,
  matching: true,
  anyFeet: false,
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
const EXPECTED_UUID = '74350bc2-8cd6-5c42-9c8f-5c67c407135d';

void test('woodsHoldState maps the four states and drops Clear / unknown', () => {
  assert.equal(woodsHoldState('Start'), 'STARTING');
  assert.equal(woodsHoldState('Hand'), 'HAND');
  assert.equal(woodsHoldState('Finish'), 'FINISH');
  assert.equal(woodsHoldState('Foot'), 'FOOT');
  assert.equal(woodsHoldState('Clear'), null);
  assert.equal(woodsHoldState('Wat'), null);
});

void test('parseHoldList drops Clear holds and sorts ascending by baseHoldLocation', () => {
  const parsed = parseHoldList(IMPOSSIBLE.holdList);
  assert.deepEqual(
    parsed.map((hold) => hold.holdId),
    [273, 337, 464, 664, 793],
  );
  assert.deepEqual(
    parsed.map((hold) => hold.holdState),
    ['FINISH', 'HAND', 'HAND', 'HAND', 'STARTING'],
  );
  assert.deepEqual(
    parsed.map((hold) => hold.roleCode),
    [3, 2, 2, 2, 4],
  );
});

void test('parseHoldList collapses a hold the catalog lists twice (last wins)', () => {
  // 12x12 problem 81 ("The Motto") really does list hold 757 twice. One hold
  // list has to feed the frames string, the fingerprint and board_climb_holds —
  // and board_climb_holds is keyed on climb + hold, so a repeat that survives
  // here would leave the three disagreeing about the same climb.
  const parsed = parseHoldList([
    { type: 'Finish', baseHoldLocation: 10 },
    { type: 'Hand', baseHoldLocation: 236 },
    { type: 'Start', baseHoldLocation: 757 },
    { type: 'Hand', baseHoldLocation: 596 },
    { type: 'Start', baseHoldLocation: 757 },
  ]);
  assert.deepEqual(
    parsed.map((hold) => hold.holdId),
    [10, 236, 596, 757],
  );
  assert.equal(holdsToFrames(parsed), 'p10r3p236r2p596r2p757r4');
});

void test('parseHoldList keeps the LAST entry when a repeated hold changes role', () => {
  const parsed = parseHoldList([
    { type: 'Foot', baseHoldLocation: 757 },
    { type: 'Start', baseHoldLocation: 757 },
  ]);
  assert.deepEqual(parsed, [{ holdId: 757, holdState: 'STARTING', roleCode: 4 }]);
});

void test('mapWoodsProblemToClimb derives frames, fingerprint and holds from one deduped list', () => {
  const mapped = mapWoodsProblemToClimb({
    ...IMPOSSIBLE,
    holdList: [...IMPOSSIBLE.holdList, { type: 'Start', baseHoldLocation: 793 }],
  })!;
  // The repeat changes nothing: same frames, same fingerprint, same UUID, and
  // one board_climb_holds row per hold.
  assert.equal(mapped.frames, EXPECTED_FRAMES);
  assert.equal(mapped.holdFingerprint, EXPECTED_FINGERPRINT);
  assert.equal(mapped.uuid, EXPECTED_UUID);
  assert.equal(mapped.holds.length, 5);
  assert.equal(new Set(mapped.holds.map((hold) => hold.holdId)).size, 5);
});

void test('holdsToFrames encodes p{baseHoldLocation}r{roleCode}, Start ending in r4', () => {
  assert.equal(holdsToFrames(parseHoldList(IMPOSSIBLE.holdList)), EXPECTED_FRAMES);
});

void test('woodsClimbUuid is deterministic, namespace-keyed, and a valid v5 UUID', () => {
  const uuid = woodsClimbUuid({
    name: 'Impossible ',
    author: '23chloec',
    frames: EXPECTED_FRAMES,
    boardDimension: '12x12',
  });
  assert.equal(uuid, EXPECTED_UUID);
  assert.equal(uuid, uuidv5(`12x12|Impossible |23chloec|${EXPECTED_FRAMES}`, WOODS_UUID_NAMESPACE));
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

void test('woodsClimbUuid changes when the frames (holds) change', () => {
  assert.notEqual(
    woodsClimbUuid({ name: 'Impossible ', author: '23chloec', frames: EXPECTED_FRAMES, boardDimension: '12x12' }),
    woodsClimbUuid({
      name: 'Impossible ',
      author: '23chloec',
      frames: `${EXPECTED_FRAMES}p800r1`,
      boardDimension: '12x12',
    }),
  );
});

void test('woodsClimbUuid separates the two board sizes', () => {
  // 8x10 hold ids are a numeric subset of the 12x12 ids, but they are different
  // physical holds on a different wall. Two problems that agree on name, setter
  // and hold-id list across the two catalog files are two climbs — collapsing
  // them onto one row would let the second file overwrite the first's
  // compatible_size_ids and hide a whole size's climb.
  assert.notEqual(
    woodsClimbUuid({ name: 'Impossible ', author: '23chloec', frames: EXPECTED_FRAMES, boardDimension: '12x12' }),
    woodsClimbUuid({ name: 'Impossible ', author: '23chloec', frames: EXPECTED_FRAMES, boardDimension: '8x10' }),
  );
  assert.equal(
    mapWoodsProblemToClimb({ ...IMPOSSIBLE, boardDimension: '8x10' })!.uuid,
    woodsClimbUuid({ name: 'Impossible ', author: '23chloec', frames: EXPECTED_FRAMES, boardDimension: '8x10' }),
  );
});

void test('fingerprintFromHolds is stable for the same holds (copies the canonical algorithm)', () => {
  const holds = parseHoldList(IMPOSSIBLE.holdList).map((hold) => ({
    holdId: hold.holdId,
    holdState: hold.holdState,
  }));
  assert.equal(fingerprintFromHolds(holds), EXPECTED_FINGERPRINT);
});

void test('dimensionToSizeIds maps both board sizes', () => {
  assert.deepEqual(dimensionToSizeIds('8x10'), [1]);
  assert.deepEqual(dimensionToSizeIds('12x12'), [2]);
  assert.deepEqual(dimensionToSizeIds('bogus'), []);
});

void test('dimensionToSizeIds hands every caller its own array', () => {
  // Thousands of climb rows carry one of these. Sharing the lookup table's array
  // would mean a single mutation anywhere rewrites compatible_size_ids on every
  // climb of that size.
  const first = dimensionToSizeIds('12x12');
  first.push(99);
  assert.deepEqual(dimensionToSizeIds('12x12'), [2]);
  assert.notEqual(mapWoodsProblemToClimb(IMPOSSIBLE)!.compatibleSizeIds, WOODS_DIMENSION_TO_SIZE_IDS['12x12']);
});

void test('normalizeWoodsPublishedDate rewrites MM/DD/YYYY into lexically sortable ISO', () => {
  assert.equal(normalizeWoodsPublishedDate('12/31/2025 23:59:59'), '2025-12-31 23:59:59');
  // Single-digit month and day are zero-padded, which is the whole point: text
  // sorting must put 2026-01-02 before 2026-01-10, not after it.
  assert.equal(normalizeWoodsPublishedDate('1/2/2026 03:04:05'), '2026-01-02 03:04:05');
});

void test('normalizeWoodsPublishedDate reads the leading field as the month, not the day', () => {
  // The catalog's first field never exceeds 12 while the second reaches 31, so
  // 06/26 is 26 June — a DD/MM reading would produce an impossible month 26.
  assert.equal(normalizeWoodsPublishedDate('06/26/2026 01:28:10'), '2026-06-26 01:28:10');
});

void test('normalizeWoodsPublishedDate keeps the 29 comma-separated catalog rows', () => {
  // 29 of the 5,418 rows come back as "02/05/2023, 18:34:33" — the same format
  // with a locale separator. Rejecting them would silently null their created_at.
  assert.equal(normalizeWoodsPublishedDate('02/05/2023, 18:34:33'), '2023-02-05 18:34:33');
});

void test('normalizeWoodsPublishedDate rejects a value whose fields are out of range', () => {
  // The shape matches but the numbers are nonsense. Storing them verbatim would
  // put "2020-13-45 99:99:99" in created_at — a string that sorts after every
  // real December and that no date parser reads back.
  assert.equal(normalizeWoodsPublishedDate('13/45/2020 99:99:99'), null);
  assert.equal(normalizeWoodsPublishedDate('00/00/2020 00:00:00'), null);
  // A leading 31 is not a DD/MM row to rescue — the catalog is MM/DD throughout,
  // so re-reading it as a day would file the climb under the wrong month.
  assert.equal(normalizeWoodsPublishedDate('31/12/2025 10:00:00'), null);
  assert.equal(normalizeWoodsPublishedDate('12/31/2025 24:00:00'), null);
  assert.equal(normalizeWoodsPublishedDate('12/31/2025 23:60:00'), null);
  assert.equal(normalizeWoodsPublishedDate('12/31/2025 23:59:60'), null);
});

void test('normalizeWoodsPublishedDate keeps the boundary values that are real', () => {
  assert.equal(normalizeWoodsPublishedDate('01/01/2020 00:00:00'), '2020-01-01 00:00:00');
  assert.equal(normalizeWoodsPublishedDate('12/31/2025 23:59:59'), '2025-12-31 23:59:59');
});

void test('normalizeWoodsPublishedDate returns null for anything it cannot parse', () => {
  assert.equal(normalizeWoodsPublishedDate(''), null);
  assert.equal(normalizeWoodsPublishedDate('   '), null);
  assert.equal(normalizeWoodsPublishedDate(null), null);
  assert.equal(normalizeWoodsPublishedDate(undefined), null);
  assert.equal(normalizeWoodsPublishedDate('not a date'), null);
  assert.equal(normalizeWoodsPublishedDate('2025-12-31 23:59:59'), null); // already ISO — not this format
  assert.equal(normalizeWoodsPublishedDate('12/31/2025'), null); // no time part
  assert.equal(normalizeWoodsPublishedDate('12/31/25 23:59:59'), null); // two-digit year
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
  assert.equal(mapped!.difficulty, 10); // Woods V0 → shared 4a/V0
  assert.equal(mapped!.difficultyClamped, false);
  assert.equal(mapped!.ascensionistCount, 0);
  assert.equal(mapped!.qualityAverage, null); // no 1-5 community rating in the API
  assert.equal(mapped!.faUsername, null); // firstAscent is '' on this problem
  assert.equal(mapped!.createdAt, '2026-06-26 01:28:10');
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

void test('mapWoodsProblemToClimb carries firstAscent into faUsername, trimmed', () => {
  assert.equal(mapWoodsProblemToClimb({ ...IMPOSSIBLE, firstAscent: '  Stubbs  ' })!.faUsername, 'Stubbs');
  assert.equal(mapWoodsProblemToClimb({ ...IMPOSSIBLE, firstAscent: '   ' })!.faUsername, null);
  assert.equal(mapWoodsProblemToClimb({ ...IMPOSSIBLE, firstAscent: null })!.faUsername, null);
  assert.equal(mapWoodsProblemToClimb({ ...IMPOSSIBLE, firstAscent: undefined })!.faUsername, null);
});

void test('mapWoodsProblemToClimb folds every catalog grade onto the shared scale', () => {
  // 0 → 4a/V0, 4 → 6b/V4, 15 → 8c/V15: the lowest shared id in each V band.
  assert.equal(mapWoodsProblemToClimb({ ...IMPOSSIBLE, problemGrade: 0 })!.difficulty, 10);
  assert.equal(mapWoodsProblemToClimb({ ...IMPOSSIBLE, problemGrade: 4 })!.difficulty, 18);
  assert.equal(mapWoodsProblemToClimb({ ...IMPOSSIBLE, problemGrade: 15 })!.difficulty, 32);
  assert.equal(mapWoodsProblemToClimb({ ...IMPOSSIBLE, problemGrade: 16 })!.difficulty, 33);
});

void test('mapWoodsProblemToClimb clamps V17 onto 8c+/V16 and flags it', () => {
  // The shared table stops at 8c+/V16, so the 6 catalog rows graded V17 land on
  // the same id as V16. The flag is what makes the clamp countable in the import
  // summary rather than an invisible grade change.
  const clamped = mapWoodsProblemToClimb({ ...IMPOSSIBLE, problemGrade: 17 })!;
  assert.equal(clamped.difficulty, 33);
  assert.equal(clamped.difficultyClamped, true);
  assert.deepEqual([...WOODS_CLAMPED_GRADES], [17]);
});

void test('mapWoodsProblemToClimb stores a NULL difficulty for a grade off the Woods scale', () => {
  // Better a missing grade than an invented one: nothing downstream can tell a
  // wrong difficulty from a real one, but it can render a null.
  const offScale = mapWoodsProblemToClimb({ ...IMPOSSIBLE, problemGrade: 99 })!;
  assert.equal(offScale.difficulty, null);
  assert.equal(offScale.difficultyClamped, false);
});

void test('WOODS_REQUIRED_SET_IDS is empty even though the board config reports one synthetic set', () => {
  // The Woods board has no add-on hold sets. The board config hands out a single
  // synthetic set so the board-selection UI has something to select, but
  // required_set_ids must stay empty: search and playlists filter with
  // `required_set_ids <@ ARRAY[selected]`, and `{} <@ anything` is true, so an
  // empty array can never hide a Woods climb — including from a client that
  // selected no sets at all.
  assert.deepEqual(WOODS_REQUIRED_SET_IDS, []);
  assert.deepEqual(getWoodsBoardDetails({ size_id: 1 }).set_ids, [1]);
  assert.deepEqual(getWoodsBoardDetails({ size_id: 2 }).set_ids, [1]);
});

void test('woodsGradeRows seeds one row per shared difficulty id a Woods grade reaches', () => {
  const rows = woodsGradeRows();
  assert.equal(rows.length, 17);
  assert.equal(rows.length, WOODS_DIFFICULTY_IDS.size);
  assert.deepEqual(
    rows.map((row) => row.difficulty),
    [10, 13, 15, 16, 18, 20, 22, 23, 24, 26, 27, 28, 29, 30, 31, 32, 33],
  );
  assert.deepEqual(
    rows.map((row) => row.boulderName),
    [
      '4a/V0',
      '5a/V1',
      '5c/V2',
      '6a/V3',
      '6b/V4',
      '6c/V5',
      '7a/V6',
      '7a+/V7',
      '7b/V8',
      '7c/V9',
      '7c+/V10',
      '8a/V11',
      '8a+/V12',
      '8b/V13',
      '8b+/V14',
      '8c/V15',
      '8c+/V16',
    ],
  );
  assert.ok(rows.every((row) => row.routeName === null && row.isListed === true && row.boardType === 'woods'));
});

void test('woodsGradeRows labels come from BOULDER_GRADES, never invented locally', () => {
  // Tick grade matching compares on LOWER(boulder_name), so a label that drifts
  // from the shared table stops matching ticks logged anywhere else.
  // Widened to Map<number, string>: BOULDER_GRADES is `as const`, so inference
  // would key the map on the literal union of ids and reject a plain number.
  const nameById = new Map<number, string>(BOULDER_GRADES.map((grade) => [grade.difficulty_id, grade.difficulty_name]));
  for (const row of woodsGradeRows()) {
    assert.ok(nameById.has(row.difficulty), `difficulty ${row.difficulty} is not a BOULDER_GRADES id`);
    assert.equal(row.boulderName, nameById.get(row.difficulty));
  }
});

void test('woodsGradeRows is ascending and covers every id mapWoodsProblemToClimb can emit', () => {
  const seededIds = new Set(woodsGradeRows().map((row) => row.difficulty));
  for (let problemGrade = 0; problemGrade <= 17; problemGrade++) {
    const difficulty = mapWoodsProblemToClimb({ ...IMPOSSIBLE, problemGrade })!.difficulty;
    assert.notEqual(difficulty, null, `grade ${problemGrade} must map onto the shared scale`);
    assert.ok(seededIds.has(difficulty!), `grade ${problemGrade} → ${difficulty} has no board_difficulty_grades row`);
  }
  const difficulties = woodsGradeRows().map((row) => row.difficulty);
  assert.deepEqual(
    difficulties,
    [...difficulties].sort((left, right) => left - right),
  );
});

void test('parseWoodsCatalogFile round-trips a valid dump', () => {
  const dump = parseWoodsCatalogFile(
    JSON.stringify({ boardDimension: '8x10', count: 1, problems: [{ id: 1, matching: true, anyFeet: false }] }),
    'woodsboard_8x10.json',
  );
  assert.equal(dump.boardDimension, '8x10');
  assert.equal(dump.problems.length, 1);
});

void test('parseWoodsCatalogFile names the file on malformed JSON', () => {
  assert.throws(
    () => parseWoodsCatalogFile('{ not json', 'woodsboard_12x12.json'),
    /woodsboard_12x12\.json is not valid JSON/,
  );
});

void test('parseWoodsCatalogFile fails loudly when problems is not an array', () => {
  // The importer reads dump.problems.length unconditionally; without this guard a
  // reshaped dump would import zero climbs while reporting success.
  assert.throws(
    () => parseWoodsCatalogFile(JSON.stringify({ boardDimension: '8x10', count: 0, problems: {} }), 'bad.json'),
    /bad\.json has no "problems" array/,
  );
  assert.throws(
    () => parseWoodsCatalogFile(JSON.stringify({ count: 0, problems: [] }), 'bad.json'),
    /bad\.json has no string "boardDimension"/,
  );
  assert.throws(() => parseWoodsCatalogFile('null', 'bad.json'), /bad\.json is not a JSON object/);
});

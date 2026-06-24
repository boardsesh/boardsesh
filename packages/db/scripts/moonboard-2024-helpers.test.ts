import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv5, MOONBOARD_UUID_NAMESPACE } from './moonboard-helpers.js';
import {
  MOONBOARD_2024_LAYOUT_ID,
  angleFromFilename,
  movesToHolds,
  fingerprintFromHolds,
  moonBoard2024ClimbUuid,
  mapMoonBoard2024Problem,
  type MoonBoard2024Problem,
} from './moonboard-2024-helpers.js';

// "1 STAR CHOSS" — the first problem in Problems.Moonboard.2024.40.json.
const SAMPLE: MoonBoard2024Problem = {
  name: '1 STAR CHOSS',
  grade: '6C+',
  userGrade: '6C+',
  setby: 'Gra3son',
  method: 'Any marked holds',
  holdsetup: { description: 'MoonBoard 2024', holdsets: null },
  isBenchmark: true,
  moves: [
    { description: 'F5', isStart: true, isEnd: false },
    { description: 'F6', isStart: true, isEnd: false },
    { description: 'F11', isStart: false, isEnd: false },
    { description: 'G12', isStart: false, isEnd: false },
    { description: 'G16', isStart: false, isEnd: false },
    { description: 'E9', isStart: false, isEnd: false },
    { description: 'C18', isStart: false, isEnd: true },
  ],
  holdsets: [{ description: 'Wooden Holds B' }],
  dateInserted: '2024-11-12T00:00:00.000',
  dateUpdated: '2026-06-21T06:58:01.489',
  dateDeleted: null,
};

void test('angleFromFilename pulls the angle out of an export filename', () => {
  assert.equal(angleFromFilename('Problems.Moonboard.2024.40.json'), 40);
  assert.equal(angleFromFilename('Problems.Moonboard.2024.25.json'), 25);
  assert.equal(angleFromFilename('something-without-angle.json'), undefined);
});

void test('movesToHolds maps grid coordinates and roles', () => {
  const holds = movesToHolds(SAMPLE.moves);
  assert.deepEqual(holds, [
    { holdId: 50, holdState: 'STARTING' }, // F5
    { holdId: 61, holdState: 'STARTING' }, // F6
    { holdId: 116, holdState: 'HAND' }, // F11
    { holdId: 128, holdState: 'HAND' }, // G12
    { holdId: 172, holdState: 'HAND' }, // G16
    { holdId: 93, holdState: 'HAND' }, // E9
    { holdId: 190, holdState: 'FINISH' }, // C18
  ]);
});

void test('fingerprintFromHolds is deterministic and order-independent', () => {
  const holds = movesToHolds(SAMPLE.moves);
  const reversed = [...holds].reverse();
  assert.equal(fingerprintFromHolds(holds), fingerprintFromHolds(reversed));
  // SHA-256 hex
  assert.match(fingerprintFromHolds(holds), /^[0-9a-f]{64}$/);
});

// Pins the exact algorithm — sorted `holdId:holdState:frameNumber(=0)` tuples
// joined with '|', sha256 hex. This MUST stay byte-for-byte identical to the
// canonical fingerprint in packages/kilter-sync/src/sync/fingerprint.ts and
// packages/db/scripts/backfill-hold-fingerprints.ts, or climb dedup splits.
void test('fingerprintFromHolds matches the canonical algorithm output', () => {
  const holds = movesToHolds(SAMPLE.moves);
  assert.equal(fingerprintFromHolds(holds), '4320dc7bf0c843eb100de9ec28ccd9e819feb57a90e25078575b9ec8c754c940');
});

void test('moonBoard2024ClimbUuid is deterministic and keyed off name+setter+holds', () => {
  const frames = 'p50r42p61r42p116r43p128r43p172r43p93r43p190r44';
  const expected = uuidv5(`moonboard:3:40:1 STAR CHOSS|Gra3son|${frames}`, MOONBOARD_UUID_NAMESPACE);
  const uuid = moonBoard2024ClimbUuid({ layoutId: 3, angle: 40, name: '1 STAR CHOSS', setby: 'Gra3son', frames });
  assert.equal(uuid, expected);
  // v5 UUID shape
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Different angle → different uuid (one climb row per problem+angle)
  assert.notEqual(
    uuid,
    moonBoard2024ClimbUuid({ layoutId: 3, angle: 25, name: '1 STAR CHOSS', setby: 'Gra3son', frames }),
  );
});

void test('distinct problems sharing holds get distinct UUIDs (not merged)', () => {
  const a = mapMoonBoard2024Problem(SAMPLE, { layoutId: 3, angle: 40 });
  const other = mapMoonBoard2024Problem(
    { ...SAMPLE, name: 'SPACE KOOK', setby: 'Mike C', grade: '7A' },
    { layoutId: 3, angle: 40 },
  );
  // Same holds → same fingerprint, but different name/setter → different climb.
  assert.equal(a.holdFingerprint, other.holdFingerprint);
  assert.notEqual(a.uuid, other.uuid);
  // Re-mapping the identical problem is idempotent.
  assert.equal(a.uuid, mapMoonBoard2024Problem(SAMPLE, { layoutId: 3, angle: 40 }).uuid);
});

void test('mapMoonBoard2024Problem produces the full climb mapping', () => {
  const mapped = mapMoonBoard2024Problem(SAMPLE, { layoutId: MOONBOARD_2024_LAYOUT_ID, angle: 40 });
  assert.equal(mapped.frames, 'p50r42p61r42p116r43p128r43p172r43p93r43p190r44');
  assert.equal(mapped.difficultyId, 21); // 6C+
  assert.equal(mapped.isBenchmark, true);
  assert.equal(mapped.setterUsername, 'Gra3son');
  assert.equal(mapped.layoutId, 3);
  assert.equal(mapped.angle, 40);
  assert.equal(mapped.createdAt, '2024-11-12T00:00:00.000');
  assert.equal(mapped.holds.length, 7);
  assert.match(mapped.holdFingerprint, /^[0-9a-f]{64}$/);
  // Re-mapping the same problem yields the same UUID (idempotent import).
  assert.equal(mapped.uuid, mapMoonBoard2024Problem(SAMPLE, { layoutId: 3, angle: 40 }).uuid);
});

void test('maps MoonBoard method to a characteristics array', () => {
  // SAMPLE.method is "Any marked holds" (the default) → no token.
  assert.equal(mapMoonBoard2024Problem(SAMPLE, { layoutId: 3, angle: 40 }).characteristics, null);
  assert.deepEqual(
    mapMoonBoard2024Problem({ ...SAMPLE, method: 'Footless' }, { layoutId: 3, angle: 40 }).characteristics,
    ['method_footless'],
  );
  assert.deepEqual(
    mapMoonBoard2024Problem({ ...SAMPLE, method: 'No kickboard' }, { layoutId: 3, angle: 40 }).characteristics,
    ['method_no_kickboard'],
  );
});

void test('preserves non-standard "method" labels in the description, not as a tag', () => {
  const map = (method: string) => mapMoonBoard2024Problem({ ...SAMPLE, method }, { layoutId: 3, angle: 40 });
  // A joke label that differs from the name: no characteristic, kept in description.
  const joke = map('KICKBOARDS ARE AID');
  assert.equal(joke.characteristics, null);
  assert.equal(joke.description, 'KICKBOARDS ARE AID');
  assert.equal(map('PROJECT').description, 'PROJECT');
  // Default + recognized methods leave the description empty.
  assert.equal(map('Any marked holds').description, '');
  assert.equal(map('Feet follow hands').description, '');
  assert.equal(map('Footless').description, ''); // captured as a tag instead
  // When the joke method is identical to the climb name (the common case), don't
  // duplicate it into the description.
  assert.equal(
    mapMoonBoard2024Problem(
      { ...SAMPLE, name: 'KICKBOARDS ARE AID', method: 'KICKBOARDS ARE AID' },
      { layoutId: 3, angle: 40 },
    ).description,
    '',
  );
});

void test('ungraded / unknown-grade problems still map to a climb (null difficulty)', () => {
  const project = mapMoonBoard2024Problem(
    { ...SAMPLE, grade: '', dateInserted: undefined },
    { layoutId: 3, angle: 40 },
  );
  assert.equal(project.difficultyId, undefined); // importer stores null difficulty
  assert.equal(project.createdAt, null); // absent date → null (full catalog omits dates)
  assert.equal(project.holds.length, 7);
  assert.match(project.uuid, /^[0-9a-f-]{36}$/);
  // '9Z' is also unmappable
  assert.equal(mapMoonBoard2024Problem({ ...SAMPLE, grade: '9Z' }, { layoutId: 3, angle: 40 }).difficultyId, undefined);
});

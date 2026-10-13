import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  auroraExportSchema,
  buildImportedClimbRow,
  buildJsonImportAscentTickRow,
  exportAscentToAttempt,
  generateJsonImportAuroraId,
  generateJsonImportCircuitAuroraId,
  importedPlaceholderConflictPolicy,
  isExportAscentActuallyAttempt,
  publishedClimbKey,
  readExportBool,
  resolveCircuitClimbUuids,
  type AuroraExportAscent,
} from './json-import';

const NOW = '2026-07-03T00:00:00.000Z';
const CLIMB_UUID = 'climb-uuid-1';
const CLIMBED_AT = '2026-06-01T10:00:00.000Z';
const USER_ID = 'user-1';

function makeAscent(overrides: Partial<AuroraExportAscent> = {}): AuroraExportAscent {
  return {
    climb: 'Test Climb',
    angle: 40,
    count: 2,
    stars: 3,
    climbed_at: '2026-06-01 10:00:00',
    created_at: '2026-06-01 10:05:00',
    grade: '7a',
    ...overrides,
  };
}

describe('buildJsonImportAscentTickRow', () => {
  // Regression for #3390: the export 'stars' field is the raw Aurora 0-3
  // rating and must be converted to the Boardsesh 1-5 scale, not stored raw.
  it.each([
    { stars: 1, expected: 1 },
    { stars: 2, expected: 3 },
    { stars: 3, expected: 5 },
  ])('converts raw Aurora stars $stars to Boardsesh quality $expected', ({ stars, expected }) => {
    const row = buildJsonImportAscentTickRow(USER_ID, 'kilter', makeAscent({ stars }), CLIMB_UUID, CLIMBED_AT, NOW);
    expect(row.quality).toBe(expected);
  });

  it('stores unrated (stars 0) as null, not 0', () => {
    const row = buildJsonImportAscentTickRow(USER_ID, 'kilter', makeAscent({ stars: 0 }), CLIMB_UUID, CLIMBED_AT, NOW);
    expect(row.quality).toBeNull();
  });

  it('clamps out-of-range stars to the top of the scale', () => {
    const row = buildJsonImportAscentTickRow(USER_ID, 'kilter', makeAscent({ stars: 5 }), CLIMB_UUID, CLIMBED_AT, NOW);
    expect(row.quality).toBe(5);
  });

  // #3301: the merged Aurora shape can omit stars/grade on an attempt-shaped
  // `ascents` row. The builder must tolerate that (null quality/difficulty)
  // rather than throw, while the legacy shape (always present) is unchanged.
  it('tolerates a missing grade (merged shape) with null difficulty', () => {
    const row = buildJsonImportAscentTickRow(
      USER_ID,
      'tension',
      makeAscent({ grade: undefined, stars: undefined }),
      CLIMB_UUID,
      CLIMBED_AT,
      NOW,
    );
    expect(row.difficulty).toBeNull();
    expect(row.quality).toBeNull();
  });

  it('builds the row with the deterministic json-import aurora id and matching sync timestamps', () => {
    const ascent = makeAscent();
    const row = buildJsonImportAscentTickRow(USER_ID, 'kilter', ascent, CLIMB_UUID, CLIMBED_AT, NOW);
    expect(row.auroraId).toBe(generateJsonImportAuroraId(USER_ID, CLIMB_UUID, ascent.angle, CLIMBED_AT, 'ascents'));
    expect(row.auroraType).toBe('ascents');
    // Imported from an Aurora export — already inside upstream, so origin
    // excludes it from the Boardsesh double-count guard.
    expect(row.origin).toBe('json_import');
    expect(row.status).toBe('send');
    expect(row.attemptCount).toBe(ascent.count);
    // The backfill migration's idempotency guard relies on freshly imported
    // rows having updated_at <= aurora_synced_at; both come from the same
    // timestamp here.
    expect(row.updatedAt).toBe(NOW);
    expect(row.auroraSyncedAt).toBe(NOW);
  });
});

describe('merged-shape attempt reclassification (#3301)', () => {
  it('flags only an explicit is_ascent=false as an attempt', () => {
    expect(isExportAscentActuallyAttempt(makeAscent({ is_ascent: false }))).toBe(true);
    // Legacy Kilter exports omit the flag → stays an ascent.
    expect(isExportAscentActuallyAttempt(makeAscent())).toBe(false);
    expect(isExportAscentActuallyAttempt(makeAscent({ is_ascent: true }))).toBe(false);
  });

  it('coerces a merged-shape attempt to the flat attempt shape, preferring tries over count', () => {
    const attempt = exportAscentToAttempt(makeAscent({ is_ascent: false, count: 2, tries: 5 }));
    expect(attempt).toEqual({
      climb: 'Test Climb',
      angle: 40,
      count: 5,
      climbed_at: '2026-06-01 10:00:00',
      created_at: '2026-06-01 10:05:00',
    });
  });

  it('falls back to count when tries is absent', () => {
    const attempt = exportAscentToAttempt(makeAscent({ is_ascent: false, count: 3 }));
    expect(attempt.count).toBe(3);
  });

  // #3521: Tension/TB2 is both the merged-shape board and the board where a
  // quarter of live ticks are mirrored, so orientation has to survive the
  // ascents → attempt coercion or the fix misses exactly the affected users.
  it('carries the mirror flag across the reclassification', () => {
    expect(exportAscentToAttempt(makeAscent({ is_ascent: false, is_mirror: true })).is_mirror).toBe(true);
    expect(exportAscentToAttempt(makeAscent({ is_ascent: false })).is_mirror).toBeUndefined();
  });
});

/**
 * #3521 — `is_mirror` was never declared on the export schema, so zod stripped
 * it before the row builder ran and every imported tick was written
 * non-mirrored. Whether Aurora's account export actually carries the field was
 * NOT verified when this landed: the export is requested by emailing Aurora
 * support, no real one was available, and its shape shares no field names with
 * the live API (`climb` name vs `climb_uuid`, `stars` vs `quality`, `grade` vs
 * `difficulty`) — so the live pull reading `is_mirror` proves nothing about it.
 * These fixtures are hand-built from the shapes already in this repo, not
 * copied from a real export. If the field is absent or spelled differently in
 * the real file, every assertion below still holds and the importer behaves
 * exactly as it did before.
 */
describe('mirrored ascents (#3521)', () => {
  it('keeps is_mirror through schema validation instead of stripping it', () => {
    const parsed = auroraExportSchema.parse({
      user: { username: 'tester' },
      ascents: [{ ...makeAscent(), is_mirror: true }],
      attempts: [
        {
          climb: 'Test Climb',
          angle: 40,
          count: 1,
          climbed_at: '2026-06-02 10:00:00',
          created_at: '2026-06-02 10:00:00',
          is_mirror: true,
        },
      ],
    });
    expect(parsed.ascents[0].is_mirror).toBe(true);
    expect(parsed.attempts[0].is_mirror).toBe(true);
  });

  it('records a mirrored ascent as mirrored', () => {
    const row = buildJsonImportAscentTickRow(
      USER_ID,
      'tension',
      makeAscent({ is_mirror: true }),
      CLIMB_UUID,
      CLIMBED_AT,
      NOW,
    );
    expect(row.isMirror).toBe(true);
  });

  it('leaves a record without a mirror flag non-mirrored, exactly as before', () => {
    // Every legacy Kilter export takes this path, as does any export that turns
    // out not to carry the field at all.
    expect(buildJsonImportAscentTickRow(USER_ID, 'kilter', makeAscent(), CLIMB_UUID, CLIMBED_AT, NOW).isMirror).toBe(
      false,
    );
    expect(
      buildJsonImportAscentTickRow(USER_ID, 'kilter', makeAscent({ is_mirror: false }), CLIMB_UUID, CLIMBED_AT, NOW)
        .isMirror,
    ).toBe(false);
  });

  // The export is a bespoke rendering, not the API shape, so we can't assume it
  // encodes booleans as JSON booleans. A strict z.boolean() would 400 the WHOLE
  // import on `1` or `"true"` — a much worse bug than the one being fixed — so
  // the schema takes the value untyped and readExportBool coerces it, a
  // superset of the live pull's toBool (it also reads the title-case spelling
  // most languages produce when they stringify a boolean).
  it.each([
    { value: true, expected: true },
    { value: 1, expected: true },
    { value: '1', expected: true },
    { value: 'true', expected: true },
    { value: 'True', expected: true },
    { value: 'TRUE', expected: true },
    { value: false, expected: false },
    { value: 0, expected: false },
    { value: 'false', expected: false },
    { value: 'False', expected: false },
    { value: '', expected: false },
    { value: null, expected: false },
    { value: undefined, expected: false },
  ])('accepts is_mirror encoded as $value without failing validation → $expected', ({ value, expected }) => {
    const parsed = auroraExportSchema.safeParse({
      user: { username: 'tester' },
      ascents: [{ ...makeAscent(), is_mirror: value }],
    });
    expect(parsed.success).toBe(true);
    expect(readExportBool(value)).toBe(expected);
  });
});

/**
 * The synthetic aurora_id is a FROZEN key, not an implementation detail.
 *
 * It is persisted on every previously imported tick, where it serves as the ON
 * CONFLICT arbiter for re-imports and as the handle the live Aurora pull uses
 * to claim placeholders. Changing the hash inputs rewrites every existing id,
 * which severs the upsert channel that in-place corrections rely on (the #3390
 * quality rescale and the #3301 attempt heal both reached existing rows through
 * it) and can leave twins behind for users whose climbed_at has since moved.
 *
 * If this test fails, you are looking at a data-integrity event that needs a
 * migration and human sign-off — not a refactor to be re-baselined. #3521
 */
describe('generateJsonImportAuroraId is frozen', () => {
  it('produces the same ids it produced before mirror support was added', () => {
    expect(generateJsonImportAuroraId(USER_ID, CLIMB_UUID, 40, CLIMBED_AT, 'ascents')).toBe(
      'json-import-0ac4059892bcc26b5e00127dc55c4791',
    );
    expect(generateJsonImportAuroraId(USER_ID, CLIMB_UUID, 40, CLIMBED_AT, 'bids')).toBe(
      'json-import-19a4e6d0a89940c54fb24cc5a4c3d4e4',
    );
  });

  it('gives a mirrored and a non-mirrored record at the same instant the same id', () => {
    // Not an accident: mirror is deliberately absent from both the id hash and
    // the dedup key. Letting them diverge would put two rows carrying the same
    // aurora_id into one ON CONFLICT batch, which Postgres rejects (21000).
    const mirrored = buildJsonImportAscentTickRow(
      USER_ID,
      'tension',
      makeAscent({ is_mirror: true }),
      CLIMB_UUID,
      CLIMBED_AT,
      NOW,
    );
    const plain = buildJsonImportAscentTickRow(USER_ID, 'tension', makeAscent(), CLIMB_UUID, CLIMBED_AT, NOW);
    expect(mirrored.auroraId).toBe(plain.auroraId);
  });
});

describe('buildImportedClimbRow', () => {
  const base = {
    userId: USER_ID,
    boardType: 'kilter' as const,
    layoutId: 1,
    setterUsername: 'someone',
    name: 'Test Climb',
    description: '',
    frames: 'p1r15',
    edges: { edgeLeft: 0, edgeRight: 100, edgeBottom: 0, edgeTop: 100 },
    createdAt: '2026-06-01 10:00:00',
  };

  // Regression: a published-but-uncatalogued import must land UNLISTED so it
  // stops polluting catalog search with a per-user placeholder duplicate.
  it('imports a published placeholder as unlisted, non-draft, user-owned', () => {
    const row = buildImportedClimbRow({ ...base, isDraft: false });
    expect(row.isListed).toBe(false);
    expect(row.isDraft).toBe(false);
    expect(row.userId).toBe(USER_ID);
    expect(row.uuid.startsWith('json-import-climb-')).toBe(true);
  });

  it('imports a draft as unlisted and draft', () => {
    const row = buildImportedClimbRow({ ...base, isDraft: true });
    expect(row.isListed).toBe(false);
    expect(row.isDraft).toBe(true);
  });

  it('derives the no_match characteristic from an Aurora "No match" description', () => {
    const plain = buildImportedClimbRow({ ...base, isDraft: false });
    expect(plain.characteristics).toBeNull();
    const noMatch = buildImportedClimbRow({ ...base, description: 'No match. Feet follow hands.', isDraft: false });
    expect(noMatch.characteristics).toEqual(['no_match']);
  });
});

describe('importedPlaceholderConflictPolicy', () => {
  const dialect = new PgDialect();

  it('scopes the on-conflict update to placeholder rows owned by the importing user', () => {
    const policy = importedPlaceholderConflictPolicy(USER_ID);
    expect(policy.setWhere).toBeDefined();
    const rendered = dialect.sqlToQuery(policy.setWhere as NonNullable<typeof policy.setWhere>);
    const whereSql = rendered.sql.toLowerCase();
    // Only json-import placeholder rows are updatable — a real catalog climb can
    // never be delisted by a uuid collision.
    expect(whereSql).toContain("like 'json-import-climb-%'");
    // ...and only THIS user's placeholders (the importing user binds as a param).
    expect(whereSql).toContain('"user_id"');
    expect(rendered.params).toContain(USER_ID);
  });

  it('updates only is_listed, taking the incoming (unlisted) value', () => {
    const policy = importedPlaceholderConflictPolicy(USER_ID);
    expect(Object.keys(policy.set)).toEqual(['isListed']);
    const setSql = dialect.sqlToQuery(policy.set.isListed).sql.toLowerCase();
    expect(setSql).toBe('excluded.is_listed');
  });
});

describe('publishedClimbKey (layout-aware skip list)', () => {
  // Regression: the skip list used to match on name alone, so a same-name
  // catalog climb on ANOTHER layout suppressed this layout's placeholder and
  // left the import's ascents unresolvable. Keys are (layoutId, name).
  it('a same-name catalog climb on another layout does not suppress the placeholder', () => {
    const existingCatalogKeys = new Set([publishedClimbKey(8, 'Route A')]);
    // Different layout → no key match → the placeholder is still created.
    expect(existingCatalogKeys.has(publishedClimbKey(1, 'Route A'))).toBe(false);
    // Same layout → key match → skipped as before.
    expect(existingCatalogKeys.has(publishedClimbKey(8, 'Route A'))).toBe(true);
  });

  it('never collides across layouts or names', () => {
    expect(publishedClimbKey(1, 'Route A')).not.toBe(publishedClimbKey(11, 'Route A'));
    expect(publishedClimbKey(1, 'Route A')).not.toBe(publishedClimbKey(1, 'Route B'));
    // The delimiter keeps numeric prefixes unambiguous (1 + ':1x' vs 11 + 'x').
    expect(publishedClimbKey(1, ':1x')).not.toBe(publishedClimbKey(11, 'x'));
  });
});

describe('generateJsonImportCircuitAuroraId (#3526 / #3541)', () => {
  const CIRCUIT = 'Warmups';
  const CREATED_AT = '2022-02-05 08:48:20';

  it('gives two different users different ids for an identical circuit', () => {
    // The regression that matters. The original importer hashed only
    // `${boardType}:${name}:${created_at}`, so two people importing a circuit
    // with the same name and timestamp collided on the global
    // `playlists_aurora_id_idx` — the second one adopted the first's playlist
    // and took an `owner` edge on it. 36 such rows are still in prod.
    const forUserA = generateJsonImportCircuitAuroraId('user-a', 'kilter', CIRCUIT, CREATED_AT);
    const forUserB = generateJsonImportCircuitAuroraId('user-b', 'kilter', CIRCUIT, CREATED_AT);
    expect(forUserA).not.toBe(forUserB);
  });

  it('is stable for the same user so a re-import updates in place', () => {
    expect(generateJsonImportCircuitAuroraId('user-a', 'kilter', CIRCUIT, CREATED_AT)).toBe(
      generateJsonImportCircuitAuroraId('user-a', 'kilter', CIRCUIT, CREATED_AT),
    );
  });

  it('separates the same circuit name across boards', () => {
    expect(generateJsonImportCircuitAuroraId('user-a', 'kilter', CIRCUIT, CREATED_AT)).not.toBe(
      generateJsonImportCircuitAuroraId('user-a', 'tension', CIRCUIT, CREATED_AT),
    );
  });

  it('keeps the json-import-circuit- prefix the existing prod rows carry', () => {
    expect(generateJsonImportCircuitAuroraId('user-a', 'kilter', CIRCUIT, CREATED_AT)).toMatch(
      /^json-import-circuit-[0-9a-f]{32}$/,
    );
  });
});

/**
 * #4023: `unique_playlist_climb` is (playlist_id, climb_uuid). The JSON import
 * resolves a circuit's climbs by NAME, so two entries collapsing onto one uuid
 * used to produce duplicate insert rows, a raw 23505, and a rolled-back circuit
 * that the climber only ever saw as a bumped `failed` count.
 */
describe('resolveCircuitClimbUuids (#4023)', () => {
  const nameToUuid = new Map([
    ['Crimp Ladder', 'uuid-a'],
    ['Crimp Ladder ', 'uuid-a'],
    ['Sloper Hell', 'uuid-b'],
  ]);

  it('collapses a climb listed twice under the same name to one row', () => {
    expect(resolveCircuitClimbUuids(['Crimp Ladder', 'Sloper Hell', 'Crimp Ladder'], nameToUuid)).toEqual([
      'uuid-a',
      'uuid-b',
    ]);
  });

  it('collapses two different names that resolve to the same uuid', () => {
    expect(resolveCircuitClimbUuids(['Crimp Ladder', 'Crimp Ladder '], nameToUuid)).toEqual(['uuid-a']);
  });

  it('keeps the first occurrence, so circuit order survives the dedupe', () => {
    expect(resolveCircuitClimbUuids(['Sloper Hell', 'Crimp Ladder', 'Sloper Hell'], nameToUuid)).toEqual([
      'uuid-b',
      'uuid-a',
    ]);
  });

  it('drops names that resolve to nothing without disturbing the rest', () => {
    expect(resolveCircuitClimbUuids(['Unknown Climb', 'Sloper Hell'], nameToUuid)).toEqual(['uuid-b']);
  });

  it('returns an empty list when nothing resolves, so the caller skips the delete', () => {
    expect(resolveCircuitClimbUuids(['Unknown Climb'], nameToUuid)).toEqual([]);
  });
});

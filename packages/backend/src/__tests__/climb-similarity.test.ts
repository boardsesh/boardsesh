import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  acquireDuplicateGateLock,
  buildDuplicateClimbErrorMessage,
  buildHoldSignature,
  buildStoredRuleSignature,
  CLIMB_DUPLICATE_ERROR_CODE,
  findExactDuplicateMatch,
  findSimilarClimbs,
  parseFramesToHoldEntries,
} from '../graphql/resolvers/climbs/climb-similarity';

const { mockDb, mockTransactionDb } = vi.hoisted(() => {
  const mockTransactionDb = {
    execute: vi.fn(),
  };
  return {
    mockTransactionDb,
    mockDb: {
      execute: vi.fn(),
      transaction: vi.fn((callback: (transactionDb: typeof mockTransactionDb) => unknown) =>
        callback(mockTransactionDb),
      ),
    },
  };
});

vi.mock('../db/client', () => ({
  db: mockDb,
}));

const dialect = new PgDialect();
const SERIAL_PLAN_GUARD = /SET LOCAL max_parallel_workers_per_gather\s*=\s*0/i;

function renderStatement(statement: unknown): string {
  return dialect.sqlToQuery(statement as SQL).sql;
}

function mockSimilarClimbRows(rows: unknown[]): void {
  mockTransactionDb.execute.mockImplementation((statement: unknown) =>
    Promise.resolve(SERIAL_PLAN_GUARD.test(renderStatement(statement)) ? [] : rows),
  );
}

function getRenderedSimilarityQuery(): { sql: string; params: unknown[] } {
  const queryCall = mockTransactionDb.execute.mock.calls.find(
    ([statement]) => !SERIAL_PLAN_GUARD.test(renderStatement(statement)),
  );
  if (!queryCall) throw new Error('Expected the similarity query to execute');
  return dialect.sqlToQuery(queryCall[0] as SQL);
}

describe('parseFramesToHoldEntries', () => {
  it('parses a Kilter frame string into hold + state tuples', () => {
    const entries = parseFramesToHoldEntries('kilter', 'p1117r12p1140r15p1148r13');
    expect(entries).toEqual([
      { frameNumber: 0, holdId: 1117, holdState: 'STARTING' },
      { frameNumber: 0, holdId: 1140, holdState: 'FOOT' },
      { frameNumber: 0, holdId: 1148, holdState: 'HAND' },
    ]);
  });

  it('returns an empty list for null / empty input', () => {
    expect(parseFramesToHoldEntries('kilter', null)).toEqual([]);
    expect(parseFramesToHoldEntries('kilter', '')).toEqual([]);
  });

  it('flattens multi-frame strings with frameNumber preserved', () => {
    const entries = parseFramesToHoldEntries('tension', 'p10r1p20r2,p30r3');
    expect(entries).toEqual([
      { frameNumber: 0, holdId: 10, holdState: 'STARTING' },
      { frameNumber: 0, holdId: 20, holdState: 'HAND' },
      { frameNumber: 1, holdId: 30, holdState: 'FINISH' },
    ]);
  });
});

describe('buildHoldSignature', () => {
  it('produces a stable signature regardless of input order', () => {
    const a = buildHoldSignature([
      { holdId: 25, holdState: 'FINISH' },
      { holdId: 1, holdState: 'STARTING' },
      { holdId: 13, holdState: 'HAND' },
    ]);
    const b = buildHoldSignature([
      { holdId: 1, holdState: 'STARTING' },
      { holdId: 13, holdState: 'HAND' },
      { holdId: 25, holdState: 'FINISH' },
    ]);
    expect(a).toBe(b);
    expect(a).toBe('1:STARTING,13:HAND,25:FINISH');
  });

  it('returns empty signature for empty input', () => {
    expect(buildHoldSignature([])).toBe('');
  });

  it('first-write-wins when a hold id appears twice (matches DB onConflictDoNothing)', () => {
    // board_climb_holds has a PK on (board_type, climb_uuid, hold_id). When
    // saveClimb does INSERT ... ON CONFLICT DO NOTHING with a parsed frames
    // string that names the same hold_id twice (e.g. "p5r12p5r13"), only
    // the FIRST row persists. The JS signature must mirror that behaviour
    // or the gate's equality check would mismatch for malformed input.
    const signature = buildHoldSignature([
      { holdId: 5, holdState: 'STARTING' },
      { holdId: 5, holdState: 'HAND' },
    ]);
    expect(signature).toBe('5:STARTING');
  });
});

describe('buildDuplicateClimbErrorMessage', () => {
  it('embeds the existing climb name when known', () => {
    expect(buildDuplicateClimbErrorMessage('Spiders Man')).toBe(
      'A climb with the same holds already exists: "Spiders Man"',
    );
  });

  it('falls back to a generic message when the name is missing', () => {
    expect(buildDuplicateClimbErrorMessage(null)).toBe('A climb with the same holds already exists');
    expect(buildDuplicateClimbErrorMessage('   ')).toBe('A climb with the same holds already exists');
  });
});

describe('CLIMB_DUPLICATE_ERROR_CODE', () => {
  it('is the agreed-upon GraphQL extension code', () => {
    // The frontend gates its duplicate-UX banner on this exact value.
    // Changing it here without updating create-climb-form breaks the gate UI.
    expect(CLIMB_DUPLICATE_ERROR_CODE).toBe('CLIMB_IS_DUPLICATE');
  });
});

/**
 * These tests mock the DB and exercise the query-construction + result-mapping
 * paths. They do NOT cover concurrent-publish races: two clients submitting
 * identical holds within a few millisecond window can both pass the gate
 * because there's no unique constraint on the hold-set signature — the gate
 * is best-effort against the snapshot the query sees. Catching the race would
 * require either a partial unique index on a materialized signature column or
 * an advisory lock per (board_type, layout_id, signature). Out of scope here;
 * tracked in the follow-up backfill issue.
 */
describe('findExactDuplicateMatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the candidate has no holds (empty signature)', async () => {
    const match = await findExactDuplicateMatch({
      boardType: 'kilter',
      layoutId: 1,
      signature: '',
      ruleSignature: '',
    });
    expect(match).toBeNull();
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('returns the existing climb when the DB query yields a row', async () => {
    mockDb.execute.mockResolvedValueOnce([
      {
        uuid: 'existing-uuid',
        name: 'Veiny Ahh Dih',
        setter_username: 'asherwang777',
        angle: 30,
      },
    ]);
    const match = await findExactDuplicateMatch({
      boardType: 'kilter',
      layoutId: 1,
      signature: '1117:STARTING,1140:FOOT',
      ruleSignature: '',
    });
    expect(match).toEqual({
      uuid: 'existing-uuid',
      name: 'Veiny Ahh Dih',
      setterUsername: 'asherwang777',
      angle: 30,
    });
  });

  it('returns null when no rows match the signature', async () => {
    mockDb.execute.mockResolvedValueOnce([]);
    const match = await findExactDuplicateMatch({
      boardType: 'tension',
      layoutId: 8,
      signature: '999:STARTING',
      ruleSignature: '',
    });
    expect(match).toBeNull();
  });

  it('emits SQL that restricts the join to the canonical hold states', async () => {
    mockDb.execute.mockResolvedValueOnce([]);
    await findExactDuplicateMatch({
      boardType: 'kilter',
      layoutId: 1,
      signature: '1:STARTING',
      ruleSignature: '',
    });
    // Render the SQL through Drizzle's public PgDialect rather than walking
    // its internal AST. Without this filter, an existing climb with one extra
    // row in a hold_state HOLD_STATE_MAP doesn't know yet would produce a
    // longer signature, miss the candidate's, and slip past the gate.
    const [query] = mockDb.execute.mock.calls[0];
    const { sql: rendered, params } = new PgDialect().sqlToQuery(query as SQL);
    expect(rendered).toContain('hold_state" IN (');
    // Drizzle parameterises the inlined state names; check the param values.
    for (const state of ['STARTING', 'HAND', 'FINISH', 'FOOT']) {
      expect(params).toContain(state);
    }
  });

  it('keys the gate on the rule signature instead of excluding no-match climbs', async () => {
    // The old gate skipped every no_match climb, treating them as Aurora
    // placeholder rows. Rules are part of the duplicate key now, so a no-match
    // climb is a real candidate and only collides with another no-match climb on
    // the same holds — which is the same problem, and should be blocked.
    mockDb.execute.mockResolvedValueOnce([]);
    await findExactDuplicateMatch({
      boardType: 'kilter',
      layoutId: 1,
      signature: '1:STARTING',
      ruleSignature: 'no_match',
    });
    const [query] = mockDb.execute.mock.calls[0];
    const { sql: rendered, params } = new PgDialect().sqlToQuery(query as SQL);
    expect(rendered).not.toContain("@> ARRAY['no_match']");
    expect(params).toContain('no_match');
    // Byte ordering on both sides — the JS twin sorts by code unit, so the SQL
    // must not defer to a locale collation that ignores underscores.
    expect(rendered).toContain('@> ARRAY[');
    expect(rendered).toContain('<@ ARRAY[');
  });

  it('keeps the legacy description fallback for rows with no characteristics array yet', async () => {
    mockDb.execute.mockResolvedValueOnce([]);
    await findExactDuplicateMatch({
      boardType: 'kilter',
      layoutId: 1,
      signature: '1:STARTING',
      ruleSignature: '',
    });
    const [query] = mockDb.execute.mock.calls[0];
    const { sql: rendered } = new PgDialect().sqlToQuery(query as SQL);
    expect(rendered).toContain("LIKE 'no match%'");
    // Only when there is no array to trust — an explicit `noMatch: false` on a
    // climb whose description opens with "No matching feet" must stick.
    expect(rendered).toMatch(/COALESCE\("board_climbs"\."characteristics", CASE WHEN LOWER/);
  });

  it('drops the description fallback on the code-driven boards', async () => {
    // On Woods a NULL characteristics column means "rules unknown until the
    // catalog repair runs", not "no rules the description forgot to mention".
    mockDb.execute.mockResolvedValueOnce([]);
    await findExactDuplicateMatch({
      boardType: 'woods',
      layoutId: 1,
      signature: '1:STARTING',
      ruleSignature: '',
      sizeId: 2,
    });
    const [query] = mockDb.execute.mock.calls[0];
    const { sql: rendered } = new PgDialect().sqlToQuery(query as SQL);
    expect(rendered).not.toContain("LIKE 'no match%'");
  });

  it('scopes the gate to one physical size when a size-scoped board asks for it', async () => {
    mockDb.execute.mockResolvedValueOnce([]);
    await findExactDuplicateMatch({
      boardType: 'woods',
      layoutId: 1,
      signature: '300:HAND',
      ruleSignature: '',
      sizeId: 1,
    });
    const [query] = mockDb.execute.mock.calls[0];
    const { sql: rendered, params } = new PgDialect().sqlToQuery(query as SQL);
    expect(rendered).toContain('compatible_size_ids');
    expect(params).toContain(1);
  });

  it('still blocks a republish of a community-hidden climb (#5049)', async () => {
    // Hiding a junk climb must not free its holds up for someone to publish the
    // same thing again hold for hold, so the gate never learned about is_hidden.
    mockDb.execute.mockResolvedValueOnce([
      {
        uuid: 'hidden-uuid',
        name: 'Reported Junk',
        setter_username: 'someone',
        angle: 40,
      },
    ]);
    await findExactDuplicateMatch({
      boardType: 'kilter',
      layoutId: 1,
      signature: '1117:STARTING,1140:FOOT',
      ruleSignature: '',
    });
    // The claim is about the SQL, not the row: asserting the returned uuid would
    // only re-read the mock above.
    const [query] = mockDb.execute.mock.calls[0];
    const { sql: rendered } = new PgDialect().sqlToQuery(query as SQL);
    expect(rendered).not.toContain('is_hidden');
  });

  it('leaves the candidate set unscoped when no size is supplied', async () => {
    // Aurora climbs legitimately fit several product sizes at once; scoping them
    // to one would hide real duplicates.
    mockDb.execute.mockResolvedValueOnce([]);
    await findExactDuplicateMatch({
      boardType: 'kilter',
      layoutId: 1,
      signature: '1:STARTING',
      ruleSignature: '',
    });
    const [query] = mockDb.execute.mock.calls[0];
    const { sql: rendered } = new PgDialect().sqlToQuery(query as SQL);
    expect(rendered).not.toContain('compatible_size_ids');
  });
});

describe('buildStoredRuleSignature', () => {
  it('sorts and dedupes the stored tokens', () => {
    expect(buildStoredRuleSignature('kilter', ['no_match', 'campus', 'campus'], '')).toBe('campus,no_match');
  });

  it('reads no_match out of the description only when there is no array yet', () => {
    expect(buildStoredRuleSignature('kilter', null, 'No match\nbeta')).toBe('no_match');
    // An explicit array is taken at its word, so `noMatch: false` sticks even on
    // a climb whose prose starts with "No matching…".
    expect(buildStoredRuleSignature('kilter', [], 'No matching feet allowed')).toBe('');
  });

  it('never reads the description on the code-driven boards', () => {
    expect(buildStoredRuleSignature('woods', null, 'no match for the feet here')).toBe('');
    expect(buildStoredRuleSignature('moonboard', null, 'no match for the feet here')).toBe('');
  });

  // #5127: the declaration is far more often appended than led with. The gate's
  // SQL twin (`ruleMatchSql`) has to agree with this, or it silently stops
  // matching — which reads as "duplicates allowed".
  it('reads a declaration appended after the setter prose', () => {
    expect(buildStoredRuleSignature('tension', null, 'Kick board is off. No matching.')).toBe('no_match');
    expect(buildStoredRuleSignature('tension', [], 'Kick board is off. No matching.')).toBe('');
    expect(buildStoredRuleSignature('moonboard', null, 'Kick board is off. No matching.')).toBe('');
    // Prose that merely ends with the phrase is not a declaration.
    expect(buildStoredRuleSignature('tension', null, 'Campus, no match')).toBe('');
  });
});

describe('acquireDuplicateGateLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('takes no lock without a hold signature', async () => {
    await acquireDuplicateGateLock(mockDb, 'kilter', 1, '', { ruleSignature: '' });
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('keys the lock on board, layout, size, rules and holds', async () => {
    // The lock key has to stay at least as coarse as the gate's WHERE clause. A
    // FINER key would let two colliding publishes take different locks and both
    // pass the gate — the exact race the lock exists to close.
    mockDb.execute.mockResolvedValueOnce([]);
    await acquireDuplicateGateLock(mockDb, 'woods', 1, '300:HAND', { ruleSignature: 'any_feet', sizeId: 2 });
    const { params } = new PgDialect().sqlToQuery(mockDb.execute.mock.calls[0][0] as SQL);
    expect(params).toContain('woods|1|2|any_feet|300:HAND');
  });

  it('differs between rule variants of the same holds', async () => {
    mockDb.execute.mockResolvedValue([]);
    await acquireDuplicateGateLock(mockDb, 'kilter', 1, '1:STARTING', { ruleSignature: '' });
    await acquireDuplicateGateLock(mockDb, 'kilter', 1, '1:STARTING', { ruleSignature: 'no_match' });
    const [first, second] = mockDb.execute.mock.calls.map(
      ([statement]) => new PgDialect().sqlToQuery(statement as SQL).params,
    );
    expect(first).not.toEqual(second);
  });
});

describe('findSimilarClimbs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('short-circuits on empty holds without hitting the DB', async () => {
    const result = await findSimilarClimbs({
      boardType: 'kilter',
      layoutId: 1,
      holds: [],
      threshold: 0.9,
    });
    expect(result).toEqual([]);
    expect(mockDb.execute).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('maps each row to the SimilarClimbResult shape', async () => {
    mockSimilarClimbRows([
      {
        uuid: 'similar-1',
        name: 'Dyno from Insta',
        setter_username: 'blakepeyman',
        angle: 40,
        layout_id: 1,
        frames: 'p1117r12',
        shared: 9,
        candidate_hold_count: 10,
        jaccard: 0.9,
      },
    ]);
    const result = await findSimilarClimbs({
      boardType: 'kilter',
      layoutId: 1,
      holds: [
        { holdId: 1117, holdState: 'STARTING' },
        { holdId: 1140, holdState: 'HAND' },
      ],
      threshold: 0.9,
    });
    expect(result).toEqual([
      {
        uuid: 'similar-1',
        name: 'Dyno from Insta',
        setterUsername: 'blakepeyman',
        angle: 40,
        layoutId: 1,
        frames: 'p1117r12',
        difficultyName: null,
        qualityAverage: null,
        ascensionistCount: null,
        compatibleSizeIds: [],
        similarity: 0.9,
        sharedHoldCount: 9,
        candidateHoldCount: 10,
        targetHoldCount: 2,
      },
    ]);
  });

  it('emits CEIL(targetSize * threshold) as the HAVING cutoff at boundary values', async () => {
    // The early-prune HAVING clause is what keeps the query from scanning
    // every climb on a layout. Lock its arithmetic at the extreme thresholds
    // so a stray refactor can't silently widen the funnel (threshold=0 would
    // need every candidate's overlap counted) or shrink it past the input
    // (threshold=1 cutoff > targetSize prunes everything but exact matches).
    mockSimilarClimbRows([]);
    await findSimilarClimbs({
      boardType: 'kilter',
      layoutId: 1,
      holds: [
        { holdId: 1, holdState: 'STARTING' },
        { holdId: 2, holdState: 'HAND' },
        { holdId: 3, holdState: 'HAND' },
        { holdId: 4, holdState: 'FINISH' },
      ],
      threshold: 0,
    });
    {
      const { params } = getRenderedSimilarityQuery();
      // threshold=0 → CEIL(4 * 0) = 0; the HAVING simplifies to "shared >= 0"
      // which lets every candidate through, deliberately. The DB still drops
      // candidates with 0 overlap via the INNER JOIN before HAVING runs.
      expect(params).toContain(0);
    }

    mockTransactionDb.execute.mockReset();
    mockSimilarClimbRows([]);
    await findSimilarClimbs({
      boardType: 'kilter',
      layoutId: 1,
      holds: [
        { holdId: 1, holdState: 'STARTING' },
        { holdId: 2, holdState: 'HAND' },
        { holdId: 3, holdState: 'HAND' },
        { holdId: 4, holdState: 'FINISH' },
      ],
      threshold: 1,
    });
    {
      const { params } = getRenderedSimilarityQuery();
      // threshold=1 → CEIL(4 * 1) = 4; candidates need at least every target
      // hold to clear the prune. Anything less drops here, before Jaccard.
      expect(params).toContain(1);
      expect(params).toContain(4);
    }
  });

  it('dedupes the target by hold position before sizing', async () => {
    // Discovery similarity is position-only — see the docblock on
    // findSimilarClimbs. Verify the target side dedupes by hold_id so an
    // extended-start variant which re-roles the same physical hold
    // (e.g. STARTING → HAND) counts as one position, not two. Without the
    // dedupe, the targetSize denominator would double-count and depress
    // Jaccard below the threshold for legitimate extended-version matches.
    mockSimilarClimbRows([
      {
        uuid: 'pickled',
        name: 'pickled cucumbers',
        setter_username: 'Shanks',
        angle: 40,
        layout_id: 8,
        frames: '',
        shared: 9,
        candidate_hold_count: 12,
        jaccard: 0.75,
      },
    ]);
    const result = await findSimilarClimbs({
      boardType: 'kilter',
      layoutId: 8,
      holds: [
        { holdId: 4122, holdState: 'STARTING' },
        { holdId: 4122, holdState: 'HAND' },
        { holdId: 4182, holdState: 'HAND' },
      ],
      threshold: 0.5,
    });
    // Two distinct positions despite three input tuples.
    expect(result[0]?.targetHoldCount).toBe(2);
  });

  it('scopes candidates to one physical size when asked', async () => {
    // Woods' 8x10 and 12x12 walls both number holds from 0, so hold 300 is a
    // different hold on each. Without the scope the two walls' catalogues cross-
    // match at 100% and the similar list is nonsense.
    mockSimilarClimbRows([]);
    await findSimilarClimbs({
      boardType: 'woods',
      layoutId: 1,
      holds: [{ holdId: 300, holdState: 'HAND' }],
      threshold: 0.5,
      sizeId: 2,
    });
    const { sql: rendered, params } = getRenderedSimilarityQuery();
    expect(rendered).toContain('compatible_size_ids');
    expect(params).toContain(2);
  });

  it('leaves candidates unscoped without a size, and no longer hides no-match climbs', async () => {
    // Discovery similarity is about the holds on the wall, not the rules: the
    // no-match version of a route is exactly what someone looking at this one
    // wants to find.
    mockSimilarClimbRows([]);
    await findSimilarClimbs({
      boardType: 'kilter',
      layoutId: 1,
      holds: [{ holdId: 1117, holdState: 'STARTING' }],
      threshold: 0.5,
    });
    const { sql: rendered } = getRenderedSimilarityQuery();
    expect(rendered).not.toContain('compatible_size_ids @>');
    expect(rendered).not.toContain("@> ARRAY['no_match']");
    expect(rendered).not.toContain("LIKE 'no match%'");
  });

  it('drops community-hidden climbs from discovery (#5049)', async () => {
    // Discovery is a browse surface — the opposite call to the duplicate gate
    // above, which deliberately still sees hidden climbs.
    mockSimilarClimbRows([]);
    await findSimilarClimbs({
      boardType: 'kilter',
      layoutId: 1,
      holds: [{ holdId: 1117, holdState: 'STARTING' }],
      threshold: 0.5,
    });
    const { sql: rendered } = getRenderedSimilarityQuery();
    expect(rendered).toContain('c.is_hidden = FALSE');
  });

  it('disables parallel workers before running the similarity CTE on the same transaction', async () => {
    mockSimilarClimbRows([]);

    await findSimilarClimbs({
      boardType: 'tension',
      layoutId: 10,
      holds: [
        { holdId: 439, holdState: 'STARTING' },
        { holdId: 585, holdState: 'HAND' },
      ],
      threshold: 0.5,
    });

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockTransactionDb.execute).toHaveBeenCalledTimes(2);
    expect(renderStatement(mockTransactionDb.execute.mock.calls[0][0])).toMatch(SERIAL_PLAN_GUARD);
    expect(renderStatement(mockTransactionDb.execute.mock.calls[1][0])).toContain('WITH target_holds AS');
  });
});

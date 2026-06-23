import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  buildDuplicateClimbErrorMessage,
  buildHoldSignature,
  CLIMB_DUPLICATE_ERROR_CODE,
  findExactDuplicateMatch,
  findSimilarClimbs,
  parseFramesToHoldEntries,
} from '../graphql/resolvers/climbs/climb-similarity';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    execute: vi.fn(),
  },
}));

vi.mock('../db/client', () => ({
  db: mockDb,
}));

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
    });
    expect(match).toBeNull();
  });

  it('emits SQL that restricts the join to the canonical hold states', async () => {
    mockDb.execute.mockResolvedValueOnce([]);
    await findExactDuplicateMatch({
      boardType: 'kilter',
      layoutId: 1,
      signature: '1:STARTING',
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

  it("excludes 'No match' placeholder climbs from the gate via the characteristic", async () => {
    // "No match" placeholder climbs are not real routes. Without this filter a
    // real setter typing in the same holds as a placeholder gets a false-positive
    // duplicate error citing the placeholder. The filter reads the structured
    // no_match characteristic (backfilled from the Aurora description convention).
    mockDb.execute.mockResolvedValueOnce([]);
    await findExactDuplicateMatch({
      boardType: 'kilter',
      layoutId: 1,
      signature: '1:STARTING',
    });
    const [query] = mockDb.execute.mock.calls[0];
    const { sql: rendered } = new PgDialect().sqlToQuery(query as SQL);
    expect(rendered).toContain("@> ARRAY['no_match']");
    // ...plus the description-prefix fallback for rows synced in the window
    // between the backfill migration and this code deploy.
    expect(rendered).toContain("LIKE 'no match%'");
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
  });

  it('maps each row to the SimilarClimbResult shape', async () => {
    mockDb.execute.mockResolvedValueOnce([
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
    mockDb.execute.mockResolvedValueOnce([]);
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
      const [query] = mockDb.execute.mock.calls[0];
      const { params } = new PgDialect().sqlToQuery(query as SQL);
      // threshold=0 → CEIL(4 * 0) = 0; the HAVING simplifies to "shared >= 0"
      // which lets every candidate through, deliberately. The DB still drops
      // candidates with 0 overlap via the INNER JOIN before HAVING runs.
      expect(params).toContain(0);
    }

    mockDb.execute.mockReset();
    mockDb.execute.mockResolvedValueOnce([]);
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
      const [query] = mockDb.execute.mock.calls[0];
      const { params } = new PgDialect().sqlToQuery(query as SQL);
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
    mockDb.execute.mockResolvedValueOnce([
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
});

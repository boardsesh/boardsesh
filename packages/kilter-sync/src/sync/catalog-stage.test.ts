import { describe, expect, it } from 'vitest';

import {
  buildLayoutCatalogIndex,
  buildSelfAliasLowerSet,
  createGroupResult,
  createStagingBatch,
  stageCatalogClimb,
  type LayoutCatalogClimbRow,
  type RerouteContext,
  type StageCatalogClimbContext,
} from './catalog-sync';
import { decodeGripsClimbConcat } from './catalog-parse';
import { fingerprintFromHolds } from './fingerprint';
import type { KilterCatalogClimb } from '../api/kilter-rest';

// Two layouts with disjoint hole ids, the shape behind the eight climbs Kilter
// filed under the wrong product layout: every hole of a mis-tagged climb misses
// on the layout we resolved and places cleanly on the other one.
const SOURCE_LAYOUT_ID = 1;
const TARGET_LAYOUT_ID = 8;
const SOURCE_REMAP = new Map<number, number>([
  [10, 100],
  [20, 200],
]);
const TARGET_REMAP = new Map<number, number>([
  [4000, 900],
  [4001, 901],
]);
const SOURCE_CONCAT = 'h10p12h20p13';
const TARGET_CONCAT = 'h4000p12h4001p13';

function catalogClimb(overrides: Partial<KilterCatalogClimb> = {}): KilterCatalogClimb {
  return {
    climbUuid: 'CLIMB-1',
    climbConcat: SOURCE_CONCAT,
    name: 'Sloper Squeeze',
    description: '',
    edgeLeft: 0,
    edgeRight: 0,
    edgeBottom: 0,
    edgeTop: 0,
    frameCount: 1,
    framesPace: 0,
    userUuid: '26394',
    username: 'DynoClimb',
    productName: 'Kilter Board Original',
    productLayoutUuid: '27',
    allowMatch: true,
    isDraft: false,
    isListed: true,
    isDeleted: false,
    accumulatedHoldSetValue: 3,
    origin: 'NATIVE',
    createdAt: '2026-09-10T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
    ...overrides,
  };
}

function catalogRow(overrides: Partial<LayoutCatalogClimbRow> & Pick<LayoutCatalogClimbRow, 'uuid'>) {
  return { fingerprint: null, isListed: true, userId: null, isDraft: false, ...overrides };
}

/** The fingerprint the staging path derives for a concat on a given layout. */
function fingerprintFor(climbConcat: string, holeToPlacement: Map<number, number>, frameCount: number): string {
  const decoded = decodeGripsClimbConcat(climbConcat, holeToPlacement, frameCount);
  if (!decoded.ok) throw new Error(`expected this concat to decode, got ${decoded.reason}`);
  return fingerprintFromHolds(decoded.holds);
}

function rerouteContext(entries: Array<[number, Map<number, number>]>): RerouteContext {
  return { holeToPlacementByLayout: new Map(entries), candidates: new Map() };
}

function stagingContext(
  options: {
    layoutId?: number;
    climbRows?: LayoutCatalogClimbRow[];
    selfAliasUuids?: string[];
    holeToPlacement?: Map<number, number>;
    openSkips?: Map<string, string>;
    /** Undefined means "a list exists and names nothing"; null means no list at all. */
    deletedLowerUuids?: ReadonlySet<string> | null;
    reroute?: RerouteContext | null;
  } = {},
): StageCatalogClimbContext {
  return {
    index: buildLayoutCatalogIndex({
      layoutId: options.layoutId ?? SOURCE_LAYOUT_ID,
      climbRows: options.climbRows ?? [],
      existingSelfAliasLower: buildSelfAliasLowerSet(options.selfAliasUuids ?? []),
      holeToPlacement: options.holeToPlacement ?? SOURCE_REMAP,
    }),
    sourceLayoutUuid: '27',
    openSkips: options.openSkips ?? new Map(),
    batch: createStagingBatch(),
    climbUuidToCanonical: new Map(),
    canonicalsToRelist: new Set(),
    deletedLowerUuids: options.deletedLowerUuids === undefined ? new Set<string>() : options.deletedLowerUuids,
    reroute: options.reroute ?? null,
    result: createGroupResult(),
    now: new Date('2026-09-15T00:00:00Z'),
  };
}

void describe('stageCatalogClimb — UUID identity', () => {
  it('re-lists a synced canonical Kilter still lists, and routes its stats', () => {
    const context = stagingContext({ climbRows: [catalogRow({ uuid: 'CLIMB-1', isListed: false })] });

    // Upstream casing differs from ours — the match is case-insensitive.
    expect(stageCatalogClimb(catalogClimb({ climbUuid: 'climb-1' }), context)).toBe('identity');
    expect([...context.canonicalsToRelist]).toEqual(['CLIMB-1']);
    expect(context.result.relistsBlockedByDeletionHistory).toBe(0);
    expect(context.climbUuidToCanonical.get('climb-1')).toBe('CLIMB-1');
    // The missing self-alias is still backfilled on this path.
    expect(context.batch.aliasRows).toEqual([
      { boardType: 'kilter', aliasUuid: 'CLIMB-1', canonicalUuid: 'CLIMB-1', source: 'kilter' },
    ]);
  });

  it('blocks — and counts — a re-list for a uuid Kilter also reports deleted', () => {
    const context = stagingContext({
      climbRows: [catalogRow({ uuid: 'CLIMB-1', isListed: false })],
      deletedLowerUuids: new Set(['climb-1']),
    });

    expect(stageCatalogClimb(catalogClimb(), context)).toBe('identity');
    expect(context.canonicalsToRelist.size).toBe(0);
    expect(context.result.relistsBlockedByDeletionHistory).toBe(1);
  });

  it('re-lists nothing when the run has no deletion list at all', () => {
    const context = stagingContext({
      climbRows: [catalogRow({ uuid: 'CLIMB-1', isListed: false })],
      deletedLowerUuids: null,
    });

    expect(stageCatalogClimb(catalogClimb(), context)).toBe('identity');
    expect(context.canonicalsToRelist.size).toBe(0);
    // Not a blocked re-list: nothing was suppressed on deletion evidence.
    expect(context.result.relistsBlockedByDeletionHistory).toBe(0);
  });

  it('adds no alias churn when the self-alias already exists', () => {
    const context = stagingContext({
      climbRows: [catalogRow({ uuid: 'CLIMB-1' })],
      selfAliasUuids: ['CLIMB-1'],
    });

    stageCatalogClimb(catalogClimb(), context);
    expect(context.batch.aliasRows).toHaveLength(0);
    expect(context.result.selfAliasesBackfilled).toBe(0);
  });

  it('shares the run-wide self-alias set, so a self-alias staged once is never staged again', () => {
    // One set is loaded per run and handed to every layout index and the
    // reroute pass. A canonical inserted by one index (here: staged as new)
    // must count as having its self-alias when a later index meets it.
    const shared = buildSelfAliasLowerSet([]);
    const first = stagingContext();
    first.index = buildLayoutCatalogIndex({
      layoutId: SOURCE_LAYOUT_ID,
      climbRows: [],
      existingSelfAliasLower: shared,
      holeToPlacement: SOURCE_REMAP,
    });
    expect(stageCatalogClimb(catalogClimb(), first)).toBe('inserted');
    expect(shared.has('climb-1')).toBe(true);

    const later = stagingContext();
    later.index = buildLayoutCatalogIndex({
      layoutId: SOURCE_LAYOUT_ID,
      climbRows: [catalogRow({ uuid: 'CLIMB-1' })],
      existingSelfAliasLower: shared,
      holeToPlacement: SOURCE_REMAP,
    });
    expect(stageCatalogClimb(catalogClimb(), later)).toBe('identity');
    expect(later.batch.aliasRows).toHaveLength(0);
    expect(later.result.selfAliasesBackfilled).toBe(0);
  });
});

void describe('stageCatalogClimb — dedup and insert', () => {
  it('stamps the index layout id on a new canonical, holds and notification', () => {
    // This is what makes a reroute land on the TARGET layout: staging takes the
    // layout id from the index it was handed, never from the incoming climb.
    const context = stagingContext({ layoutId: TARGET_LAYOUT_ID, holeToPlacement: TARGET_REMAP });

    expect(stageCatalogClimb(catalogClimb({ climbUuid: 'MISTAGGED', climbConcat: TARGET_CONCAT }), context)).toBe(
      'inserted',
    );
    expect(context.batch.newClimbInserts[0]).toMatchObject({ uuid: 'MISTAGGED', layoutId: TARGET_LAYOUT_ID });
    expect(context.batch.newHoldRows.map((hold) => hold.holdId)).toEqual([900, 901]);
    expect(context.result.newCanonicals[0]?.layoutId).toBe(TARGET_LAYOUT_ID);
  });

  it('folds onto an existing canonical on the layout instead of inserting a twin', () => {
    const context = stagingContext({
      layoutId: TARGET_LAYOUT_ID,
      holeToPlacement: TARGET_REMAP,
      climbRows: [
        catalogRow({
          uuid: 'EXISTING',
          fingerprint: fingerprintFor(TARGET_CONCAT, TARGET_REMAP, 1),
          isListed: false,
        }),
      ],
    });

    expect(stageCatalogClimb(catalogClimb({ climbUuid: 'MISTAGGED', climbConcat: TARGET_CONCAT }), context)).toBe(
      'folded',
    );
    expect(context.batch.newClimbInserts).toHaveLength(0);
    expect(context.batch.aliasRows).toEqual([
      { boardType: 'kilter', aliasUuid: 'MISTAGGED', canonicalUuid: 'EXISTING', source: 'kilter' },
      // …plus the canonical's own missing self-alias (see below).
      { boardType: 'kilter', aliasUuid: 'EXISTING', canonicalUuid: 'EXISTING', source: 'kilter' },
    ]);
    // The fold path's re-list is not deletion-guarded: a live folded alias keeps
    // the canonical safe from the deletion pass in the same cycle.
    expect([...context.canonicalsToRelist]).toEqual(['EXISTING']);
  });

  it('stages the canonical’s missing self-alias when a climb folds onto it', () => {
    // Without this the canonical is invisible to the deletion pass's alias-graph
    // lookup, so the direct-uuid fallback unlists it in the very cycle the fold
    // re-listed it — a permanent flip-flop for the ~6k canonicals that never got
    // a self-alias, one sync_seq bump per cycle for offline clients.
    const context = stagingContext({
      climbRows: [catalogRow({ uuid: 'CANON', fingerprint: fingerprintFor(SOURCE_CONCAT, SOURCE_REMAP, 1) })],
    });

    expect(stageCatalogClimb(catalogClimb({ climbUuid: 'DUP' }), context)).toBe('folded');
    expect(context.batch.aliasRows).toEqual([
      { boardType: 'kilter', aliasUuid: 'DUP', canonicalUuid: 'CANON', source: 'kilter' },
      { boardType: 'kilter', aliasUuid: 'CANON', canonicalUuid: 'CANON', source: 'kilter' },
    ]);
    expect(context.result.selfAliasesBackfilled).toBe(1);
  });

  it('stages that self-alias once, however many climbs fold onto the canonical', () => {
    const context = stagingContext({
      climbRows: [catalogRow({ uuid: 'CANON', fingerprint: fingerprintFor(SOURCE_CONCAT, SOURCE_REMAP, 1) })],
    });

    stageCatalogClimb(catalogClimb({ climbUuid: 'DUP-1' }), context);
    stageCatalogClimb(catalogClimb({ climbUuid: 'DUP-2' }), context);
    expect(context.batch.aliasRows).toHaveLength(3);
    expect(context.result.selfAliasesBackfilled).toBe(1);
  });

  it('adds no self-alias when the canonical already has one', () => {
    const context = stagingContext({
      climbRows: [catalogRow({ uuid: 'CANON', fingerprint: fingerprintFor(SOURCE_CONCAT, SOURCE_REMAP, 1) })],
      selfAliasUuids: ['CANON'],
    });

    stageCatalogClimb(catalogClimb({ climbUuid: 'DUP' }), context);
    expect(context.batch.aliasRows).toEqual([
      { boardType: 'kilter', aliasUuid: 'DUP', canonicalUuid: 'CANON', source: 'kilter' },
    ]);
    expect(context.result.selfAliasesBackfilled).toBe(0);
  });

  it('adds no self-alias for a canonical created earlier in the same run', () => {
    // The insert path already staged one; a second would be pure churn.
    const context = stagingContext();

    expect(stageCatalogClimb(catalogClimb({ climbUuid: 'FRESH' }), context)).toBe('inserted');
    expect(stageCatalogClimb(catalogClimb({ climbUuid: 'DUP' }), context)).toBe('folded');
    expect(context.batch.aliasRows).toEqual([
      { boardType: 'kilter', aliasUuid: 'FRESH', canonicalUuid: 'FRESH', source: 'kilter' },
      { boardType: 'kilter', aliasUuid: 'DUP', canonicalUuid: 'FRESH', source: 'kilter' },
    ]);
    expect(context.result.selfAliasesBackfilled).toBe(0);
  });

  it('keeps the first canonical seen for a fingerprint', () => {
    const fingerprint = fingerprintFor(SOURCE_CONCAT, SOURCE_REMAP, 1);
    const context = stagingContext({
      climbRows: [catalogRow({ uuid: 'FIRST', fingerprint }), catalogRow({ uuid: 'SECOND', fingerprint })],
    });

    stageCatalogClimb(catalogClimb({ climbUuid: 'NEW' }), context);
    expect(context.batch.aliasRows[0]?.canonicalUuid).toBe('FIRST');
  });

  it('stamps an open backlog row resolved once the climb ingests', () => {
    const context = stagingContext({ openSkips: new Map([['climb-1', 'CLIMB-1']]) });

    expect(stageCatalogClimb(catalogClimb({ climbUuid: 'climb-1' }), context)).toBe('inserted');
    expect(context.result.resolvedSkipUuids).toEqual(['CLIMB-1']);
  });
});

void describe('stageCatalogClimb — reroute candidates', () => {
  const mistaggedClimb = catalogClimb({ climbUuid: 'MISTAGGED', climbConcat: TARGET_CONCAT });

  it('holds a mis-tagged climb for the reroute pass instead of writing a skip row', () => {
    const reroute = rerouteContext([
      [SOURCE_LAYOUT_ID, SOURCE_REMAP],
      [TARGET_LAYOUT_ID, TARGET_REMAP],
    ]);
    const context = stagingContext({ reroute });

    expect(stageCatalogClimb(mistaggedClimb, context)).toBe('reroute_candidate');
    const candidate = reroute.candidates.get('mistagged');
    expect(candidate).toMatchObject({
      sourceLayoutId: SOURCE_LAYOUT_ID,
      targetLayoutId: TARGET_LAYOUT_ID,
      sourceLayoutUuid: '27',
      // The fingerprint is the TARGET layout's, so the reroute pass dedups
      // against the catalog the climb is about to join.
      fingerprint: fingerprintFor(TARGET_CONCAT, TARGET_REMAP, 1),
    });
    expect(candidate?.sourceFailure.reason).toBe('unplaceable_hole');
    // Neither a skip row nor an unmapped count — the reroute pass decides.
    expect(context.result.skips).toHaveLength(0);
    expect(context.result.climbsUnmapped).toBe(0);
  });

  it('records the climb once when several Grips layouts carry it', () => {
    const reroute = rerouteContext([
      [SOURCE_LAYOUT_ID, SOURCE_REMAP],
      [TARGET_LAYOUT_ID, TARGET_REMAP],
    ]);
    const context = stagingContext({ reroute });

    stageCatalogClimb(mistaggedClimb, context);
    reroute.candidates.get('mistagged')?.stats.push({
      climbUuid: 'MISTAGGED',
      angle: 40,
      ascentCount: 3,
      currentDifficultyId: 20,
      difficultyAverage: 20.4,
      qualityAverage: 4.2,
      faUsername: null,
      faAt: null,
    });
    expect(stageCatalogClimb(mistaggedClimb, context)).toBe('reroute_candidate');

    expect(reroute.candidates.size).toBe(1);
    // Re-recording would drop the stats the source group already collected.
    expect(reroute.candidates.get('mistagged')?.stats).toHaveLength(1);
  });

  it('skips rather than guessing when two layouts could decode the climb', () => {
    const reroute = rerouteContext([
      [SOURCE_LAYOUT_ID, SOURCE_REMAP],
      [TARGET_LAYOUT_ID, TARGET_REMAP],
      [9, new Map(TARGET_REMAP)],
    ]);
    const context = stagingContext({ reroute });

    expect(stageCatalogClimb(mistaggedClimb, context)).toBe('skipped');
    expect(reroute.candidates.size).toBe(0);
    expect(context.result.climbsUnmapped).toBe(1);
    expect(context.result.skips[0]).toMatchObject({
      climbUuid: 'MISTAGGED',
      reason: 'unplaceable_hole',
      layoutId: SOURCE_LAYOUT_ID,
    });
  });

  it('skips when rerouting is disabled — the reroute pass never hops twice', () => {
    const context = stagingContext({ reroute: null });

    expect(stageCatalogClimb(mistaggedClimb, context)).toBe('skipped');
    expect(context.result.skips).toHaveLength(1);
  });

  it('never reroutes a failure that is not about an unplaceable hole', () => {
    const reroute = rerouteContext([
      [SOURCE_LAYOUT_ID, SOURCE_REMAP],
      [TARGET_LAYOUT_ID, TARGET_REMAP],
    ]);
    const context = stagingContext({ reroute });
    const unparsable = catalogClimb({ climbUuid: 'ODD', climbConcat: 'h10p12~~h20p13' });

    expect(stageCatalogClimb(unparsable, context)).toBe('skipped');
    expect(reroute.candidates.size).toBe(0);
    expect(context.result.skips[0]).toMatchObject({ reason: 'unparsable_concat' });
  });
});

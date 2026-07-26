import { describe, expect, it } from 'vitest';

import { buildSkipRow, describeSkip, summarizeSkipReasons, type ClimbIngestSkip } from './catalog-backlog';
import { decodeGripsClimbConcat } from './catalog-parse';
import type { KilterCatalogClimb } from '../api/kilter-rest';

const CONTEXT = { boardType: 'kilter', layoutId: 1, sourceLayoutUuid: '27' } as const;

function catalogClimb(overrides: Partial<KilterCatalogClimb> = {}): KilterCatalogClimb {
  return {
    climbUuid: 'DA658EAACBE54AC89DB4060ED07BAF6C',
    climbConcat: 'h1180p12e5h9999p13',
    name: 'Sloper Squeeze',
    description: '',
    edgeLeft: 0,
    edgeRight: 0,
    edgeBottom: 0,
    edgeTop: 0,
    frameCount: 5,
    framesPace: 1000,
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
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

/** Decode and assert it failed — the skip rows only exist for failures. */
function failedDecode(climb: KilterCatalogClimb, remap: Map<number, number>) {
  const result = decodeGripsClimbConcat(climb.climbConcat, remap, climb.frameCount);
  if (result.ok) throw new Error('expected this concat to fail decoding');
  return result;
}

void describe('buildSkipRow', () => {
  it('keeps the upstream hold string verbatim so the encoding can be decoded later', () => {
    const climb = catalogClimb();
    const row = buildSkipRow(climb, failedDecode(climb, new Map([[1180, 1192]])), CONTEXT);
    // The whole reason this table exists: a skipped climb used to leave nothing
    // behind, so a new encoding could hide climbs forever with no way to see it.
    expect(row.rawHolds).toBe(climb.climbConcat);
  });

  it('records which hole had no placement on the resolved layout', () => {
    const climb = catalogClimb();
    const row = buildSkipRow(climb, failedDecode(climb, new Map([[1180, 1192]])), CONTEXT);
    expect(row).toMatchObject({
      boardType: 'kilter',
      climbUuid: 'DA658EAACBE54AC89DB4060ED07BAF6C',
      layoutId: 1,
      sourceLayoutUuid: '27',
      reason: 'unplaceable_hole',
      detail: 'holeId=9999',
      framesCount: 5,
      climbName: 'Sloper Squeeze',
      setterUsername: 'DynoClimb',
    });
  });

  it('records where an unknown encoding stopped parsing', () => {
    const climb = catalogClimb({ climbConcat: 'h10p12~~h20p13', frameCount: 1 });
    const row = buildSkipRow(climb, failedDecode(climb, new Map([[10, 100]])), CONTEXT);
    expect(row).toMatchObject({ reason: 'unparsable_concat', detail: 'offset=6' });
  });

  it('records an out-of-range frame index', () => {
    const climb = catalogClimb({ climbConcat: 'h10p12s9', frameCount: 3 });
    const row = buildSkipRow(climb, failedDecode(climb, new Map([[10, 100]])), CONTEXT);
    expect(row).toMatchObject({ reason: 'frame_out_of_range', detail: 'frame=9' });
  });

  it('tolerates a climb with no name or setter', () => {
    const climb = catalogClimb({ name: '', username: null });
    const row = buildSkipRow(climb, failedDecode(climb, new Map([[1180, 1192]])), CONTEXT);
    expect(row.climbName).toBeNull();
    expect(row.setterUsername).toBeNull();
  });

  it('keeps layout context null when the layout itself never resolved', () => {
    const climb = catalogClimb();
    const row = buildSkipRow(climb, failedDecode(climb, new Map([[1180, 1192]])), {
      boardType: 'kilter',
      layoutId: null,
      sourceLayoutUuid: null,
    });
    expect(row.layoutId).toBeNull();
    expect(row.sourceLayoutUuid).toBeNull();
  });
});

void describe('skip reporting', () => {
  const skip = (reason: ClimbIngestSkip['reason'], climbUuid: string, detail: string | null): ClimbIngestSkip => ({
    boardType: 'kilter',
    climbUuid,
    layoutId: 1,
    sourceLayoutUuid: '27',
    reason,
    detail,
    rawHolds: 'h10p12',
    framesCount: 1,
    climbName: null,
    setterUsername: null,
  });

  it('counts by reason, worst first, so a systemic break is obvious', () => {
    expect(
      summarizeSkipReasons([
        skip('unplaceable_hole', 'a', 'holeId=1'),
        skip('unparsable_concat', 'b', 'offset=3'),
        skip('unparsable_concat', 'c', 'offset=4'),
        skip('unparsable_concat', 'd', 'offset=5'),
      ]),
    ).toEqual([
      { reason: 'unparsable_concat', count: 3 },
      { reason: 'unplaceable_hole', count: 1 },
    ]);
  });

  it('breaks reason ties by name so the log line is stable run to run', () => {
    expect(summarizeSkipReasons([skip('unparsable_concat', 'a', null), skip('frame_out_of_range', 'b', null)])).toEqual(
      [
        { reason: 'frame_out_of_range', count: 1 },
        { reason: 'unparsable_concat', count: 1 },
      ],
    );
  });

  it('describes a skip with its reason and detail', () => {
    expect(describeSkip(skip('unplaceable_hole', 'ABC', 'holeId=9999'))).toBe('ABC (unplaceable_hole holeId=9999)');
  });

  it('describes a skip that carries no detail', () => {
    expect(describeSkip(skip('unparsable_concat', 'ABC', null))).toBe('ABC (unparsable_concat)');
  });
});

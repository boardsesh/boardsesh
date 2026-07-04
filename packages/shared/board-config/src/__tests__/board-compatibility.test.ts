import { describe, expect, it } from 'vitest';
import {
  classifyClimbBoardCompatibility,
  findNextCompatibleQueueItem,
  type ActiveBoardForCompatibility,
  type ClimbBoardIdentity,
} from '../board-compatibility';

const KILTER_L1: ActiveBoardForCompatibility = { boardName: 'kilter', layoutId: 1 };
const KILTER_HOMEWALL_L8: ActiveBoardForCompatibility = { boardName: 'kilter', layoutId: 8 };
const MOONBOARD_2016: ActiveBoardForCompatibility = { boardName: 'moonboard', layoutId: 1 };

type TestQueueItem = { uuid: string; climb: ClimbBoardIdentity & { uuid: string } };

function makeItem(uuid: string, climb: ClimbBoardIdentity = {}): TestQueueItem {
  return { uuid, climb: { uuid: `c-${uuid}`, ...climb } };
}

describe('classifyClimbBoardCompatibility', () => {
  it('returns unknown when the active config is missing', () => {
    expect(classifyClimbBoardCompatibility(undefined, { boardType: 'kilter', layoutId: 1 })).toBe('unknown');
  });

  it('returns unknown when the climb carries no board metadata', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: undefined, layoutId: undefined })).toBe('unknown');
  });

  it('returns compatible when known boardType and layoutId match', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: 'kilter', layoutId: 1 })).toBe('compatible');
  });

  it('returns incompatible on a different boardType', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: 'tension', layoutId: 1 })).toBe('incompatible');
  });

  it('returns incompatible on a different layoutId', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: 'kilter', layoutId: 8 })).toBe('incompatible');
  });

  it('falls through to the layout check when boardType is unrecognised', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: 'mystery', layoutId: 1 })).toBe('compatible');
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: 'mystery', layoutId: 8 })).toBe('incompatible');
  });

  it('judges on layout alone when only layoutId is known', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: undefined, layoutId: 1 })).toBe('compatible');
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: undefined, layoutId: 8 })).toBe('incompatible');
  });

  // Production repros from issue #3193 (Sentry BOARDSESH-39 / BOARDSESH-6P):
  // kilter layout-1 climbs sent while the app was on a Homewall or MoonBoard config.
  it('flags a kilter original climb as incompatible with a kilter Homewall board (BOARDSESH-39)', () => {
    expect(classifyClimbBoardCompatibility(KILTER_HOMEWALL_L8, { boardType: 'kilter', layoutId: 1 })).toBe(
      'incompatible',
    );
  });

  it('flags a kilter climb as incompatible with a moonboard, even when layout ids collide (BOARDSESH-6P)', () => {
    // MoonBoard layout ids are a separate 1-7 space; boardType must win before layout.
    expect(classifyClimbBoardCompatibility(MOONBOARD_2016, { boardType: 'kilter', layoutId: 1 })).toBe('incompatible');
  });
});

describe('findNextCompatibleQueueItem', () => {
  it('skips a run of spill climbs and returns the next compatible one with the count', () => {
    const queue = [
      makeItem('q0', { boardType: 'kilter', layoutId: 1 }),
      makeItem('q1', { boardType: 'tension', layoutId: 1 }), // spill
      makeItem('q2', { boardType: 'kilter', layoutId: 8 }), // spill (layout)
      makeItem('q3', { boardType: 'kilter', layoutId: 1 }), // compatible
    ];
    // Start at the spill at q1.
    const result = findNextCompatibleQueueItem(queue, 'q1', KILTER_L1);
    expect(result.item?.uuid).toBe('q3');
    expect(result.skippedCount).toBe(2);
  });

  it('returns the current item with skippedCount 0 when it is already compatible', () => {
    const queue = [
      makeItem('q0', { boardType: 'kilter', layoutId: 1 }),
      makeItem('q1', { boardType: 'kilter', layoutId: 1 }),
    ];
    const result = findNextCompatibleQueueItem(queue, 'q0', KILTER_L1);
    expect(result.item?.uuid).toBe('q0');
    expect(result.skippedCount).toBe(0);
  });

  it('returns null when every remaining climb is incompatible', () => {
    const queue = [
      makeItem('q0', { boardType: 'tension', layoutId: 1 }),
      makeItem('q1', { boardType: 'kilter', layoutId: 8 }),
    ];
    const result = findNextCompatibleQueueItem(queue, 'q0', KILTER_L1);
    expect(result.item).toBeNull();
    expect(result.skippedCount).toBe(2);
  });

  it('treats unknown-metadata climbs as sendable (not skipped)', () => {
    const queue = [
      makeItem('q0', { boardType: 'tension', layoutId: 1 }), // spill
      makeItem('q1', { boardType: undefined, layoutId: undefined }), // unknown → stop here
    ];
    const result = findNextCompatibleQueueItem(queue, 'q0', KILTER_L1);
    expect(result.item?.uuid).toBe('q1');
    expect(result.skippedCount).toBe(1);
  });
});

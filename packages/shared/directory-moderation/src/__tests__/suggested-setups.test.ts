import { describe, it, expect } from 'vitest';
import {
  groupSuggestedSetups,
  setupKey,
  setupMatches,
  suggestedSetupUpdateInput,
  type SuggestedSetupNote,
} from '../suggested-setups';

const at = (minute: number) => `2026-11-23T12:${String(minute).padStart(2, '0')}:00.000Z`;
const note = (setIds: string, minute: number, angle?: number | null): SuggestedSetupNote => ({
  suggestedSetup: { layoutId: 1, sizeId: 10, setIds, ...(angle !== undefined ? { angle } : {}) },
  createdAt: at(minute),
});

describe('setupKey', () => {
  it('is equal for the same sets in any order or repeated, and for no angle and a null one', () => {
    expect(setupKey({ layoutId: 1, sizeId: 10, setIds: '3,1,1', angle: null })).toBe(
      setupKey({ layoutId: 1, sizeId: 10, setIds: '1,3' }),
    );
    expect(setupKey({ layoutId: 1, sizeId: 10, setIds: '1,3' })).toBe('1:10:1,3:');
  });

  it('differs by layout, size, sets and angle', () => {
    const base = setupKey({ layoutId: 1, sizeId: 10, setIds: '1', angle: 40 });
    expect(setupKey({ layoutId: 2, sizeId: 10, setIds: '1', angle: 40 })).not.toBe(base);
    expect(setupKey({ layoutId: 1, sizeId: 11, setIds: '1', angle: 40 })).not.toBe(base);
    expect(setupKey({ layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 })).not.toBe(base);
    expect(setupKey({ layoutId: 1, sizeId: 10, setIds: '1', angle: 25 })).not.toBe(base);
    expect(setupKey({ layoutId: 1, sizeId: 10, setIds: '1' })).not.toBe(base);
  });
});

describe('groupSuggestedSetups', () => {
  it('groups equal setups, most suggested first, in canonical form', () => {
    const groups = groupSuggestedSetups([
      note('2', 1),
      note('3,1', 2),
      { createdAt: at(3), suggestedSetup: null },
      { createdAt: at(4) },
      note('1,3,3', 5, null),
    ]);
    expect(groups).toEqual([
      { key: '1:10:1,3:', setup: { layoutId: 1, sizeId: 10, setIds: '1,3', angle: null }, count: 2 },
      { key: '1:10:2:', setup: { layoutId: 1, sizeId: 10, setIds: '2', angle: null }, count: 1 },
    ]);
  });

  it('puts the setup suggested most recently first when counts tie, then the first one seen', () => {
    expect(groupSuggestedSetups([note('1', 1), note('2', 9)]).map((group) => group.setup.setIds)).toEqual(['2', '1']);
    // A group's latest suggestion counts, not its first.
    expect(
      groupSuggestedSetups([note('1', 1), note('2', 5), note('1', 9), note('2', 2)]).map((group) => group.setup.setIds),
    ).toEqual(['1', '2']);
    const undated = [
      { suggestedSetup: { layoutId: 1, sizeId: 10, setIds: '4' } },
      { suggestedSetup: { layoutId: 1, sizeId: 10, setIds: '5' } },
    ];
    expect(groupSuggestedSetups(undated).map((group) => group.setup.setIds)).toEqual(['4', '5']);
  });

  it('keeps the angle apart: a fixed-angle setup at 25 and at 40 are two setups', () => {
    const groups = groupSuggestedSetups([note('1', 1, 25), note('1', 2, 40), note('1', 3, 40)]);
    expect(groups.map((group) => [group.setup.angle, group.count])).toEqual([
      [40, 2],
      [25, 1],
    ]);
  });

  it('is empty without suggestions', () => {
    expect(groupSuggestedSetups([])).toEqual([]);
    expect(groupSuggestedSetups([{ createdAt: at(1), suggestedSetup: null }])).toEqual([]);
  });
});

describe('setupMatches', () => {
  const current = { layoutId: 1, sizeId: 10, setIds: '3,1', angle: 40 };

  it('matches the same layout, size and sets in any order', () => {
    expect(setupMatches({ layoutId: 1, sizeId: 10, setIds: '1,3' }, current)).toBe(true);
    expect(setupMatches({ layoutId: 1, sizeId: 10, setIds: '1' }, current)).toBe(false);
    expect(setupMatches({ layoutId: 2, sizeId: 10, setIds: '1,3' }, current)).toBe(false);
    expect(setupMatches({ layoutId: 1, sizeId: 11, setIds: '1,3' }, current)).toBe(false);
  });

  it('counts the angle only when the setup names one', () => {
    expect(setupMatches({ layoutId: 1, sizeId: 10, setIds: '1,3', angle: null }, current)).toBe(true);
    expect(setupMatches({ layoutId: 1, sizeId: 10, setIds: '1,3', angle: 40 }, current)).toBe(true);
    expect(setupMatches({ layoutId: 1, sizeId: 10, setIds: '1,3', angle: 25 }, current)).toBe(false);
  });
});

describe('suggestedSetupUpdateInput', () => {
  it('sends the layout, size and canonical sets, and the angle only when the setup has one', () => {
    expect(suggestedSetupUpdateInput('board-uuid', { layoutId: 1, sizeId: 10, setIds: '3,1', angle: null })).toEqual({
      boardUuid: 'board-uuid',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,3',
    });
    expect(suggestedSetupUpdateInput('board-uuid', { layoutId: 1, sizeId: 10, setIds: '1', angle: 25 })).toEqual({
      boardUuid: 'board-uuid',
      layoutId: 1,
      sizeId: 10,
      setIds: '1',
      angle: 25,
    });
  });

  it('adds allowDuplicateConfig only when asked', () => {
    const setup = { layoutId: 1, sizeId: 10, setIds: '1' };
    expect(suggestedSetupUpdateInput('board-uuid', setup, { allowDuplicateConfig: true }).allowDuplicateConfig).toBe(
      true,
    );
    expect(suggestedSetupUpdateInput('board-uuid', setup, { allowDuplicateConfig: false })).not.toHaveProperty(
      'allowDuplicateConfig',
    );
  });
});

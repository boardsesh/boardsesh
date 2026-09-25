import { describe, expect, it } from 'vitest';
import { hashKey } from '@tanstack/react-query';
import type { ClimbBoardFilterState } from '@boardsesh/climb-filters';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { buildCountPreviewInput, withSetterSelection } from '../climb-count-preview-input';
import { DEFAULT_FILTERS, type ClimbFilters } from '../climb-filter-types';
import { SEARCH_CLIMBS_COUNT_QUERY_KEY } from '../graphql/query-keys';

const boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
const draftFilters: ClimbFilters = { ...DEFAULT_FILTERS, minGrade: 16, maxGrade: 22, setter: ['seeded-setter'] };
const draftBoardFilters: ClimbBoardFilterState = { onlyBenchmarks: true };

// The count hook keys on [...SEARCH_CLIMBS_COUNT_QUERY_KEY, input]; compare the
// hashes React Query itself uses, so key order and dropped undefineds are real.
function countQueryHash(input: ClimbSearchInput): string {
  return hashKey([...SEARCH_CLIMBS_COUNT_QUERY_KEY, input]);
}

// What the setters route sees: the sheet's input after the JSON route param.
function pushedCountInput(): ClimbSearchInput {
  const serialized = JSON.stringify(buildCountPreviewInput(draftFilters, draftBoardFilters, boardConfig, 'crimp'));
  return JSON.parse(serialized) as ClimbSearchInput;
}

describe('climb count preview input', () => {
  it('trims the name like the committed search does, so a lone space is no by-name search', () => {
    expect(buildCountPreviewInput(DEFAULT_FILTERS, {}, boardConfig, '  crimp ').name).toBe('crimp');
    expect(buildCountPreviewInput(DEFAULT_FILTERS, {}, boardConfig, ' ')).not.toHaveProperty('name');
  });

  it('counts other angles only on a board that has the switch (#5642)', () => {
    const otherAngles: ClimbFilters = { ...DEFAULT_FILTERS, includeOtherAngles: true };
    const woodsConfig = { boardName: 'woods', layoutId: 1, sizeId: 2, setIds: '1', angle: 40 };

    expect(buildCountPreviewInput(otherAngles, {}, woodsConfig, '').crossAngleStats).toBe(true);
    expect(buildCountPreviewInput(otherAngles, {}, boardConfig, '')).not.toHaveProperty('crossAngleStats');
  });

  it('gives the setters screen and the sheet the same count query key for the same picks', () => {
    const settersScreenInput = withSetterSelection(pushedCountInput(), ['alice', 'bob']);
    // The sheet after the handoff merges the picks into its draft.
    const sheetInput = buildCountPreviewInput(
      { ...draftFilters, setter: ['alice', 'bob'] },
      draftBoardFilters,
      boardConfig,
      'crimp',
    );

    expect(countQueryHash(settersScreenInput)).toBe(countQueryHash(sheetInput));
  });

  it('matches the sheet key when every setter is cleared', () => {
    const settersScreenInput = withSetterSelection(pushedCountInput(), []);
    // The sheet's handoff merge writes `setter: undefined` for an empty selection.
    const sheetInput = buildCountPreviewInput(
      { ...draftFilters, setter: undefined },
      draftBoardFilters,
      boardConfig,
      'crimp',
    );

    expect(settersScreenInput).not.toHaveProperty('setter');
    expect(countQueryHash(settersScreenInput)).toBe(countQueryHash(sheetInput));
  });

  it('keeps the rest of the draft and does not mutate the input it was given', () => {
    const baseInput = pushedCountInput();
    const settersScreenInput = withSetterSelection(baseInput, ['alice']);

    expect(settersScreenInput).toMatchObject({
      boardName: 'kilter',
      minGrade: 16,
      maxGrade: 22,
      onlyBenchmarks: true,
      name: 'crimp',
      pageSize: 1,
      setter: ['alice'],
    });
    expect(baseInput.setter).toEqual(['seeded-setter']);
  });
});

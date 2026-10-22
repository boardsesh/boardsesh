// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PYRAMID_OPTIONS, DEFAULT_VOLUME_OPTIONS } from '@boardsesh/playlist-generator';
import { DEFAULT_WORKOUT_FILTERS, NO_WORKOUT, type GeneratorSelection } from '../workout-blocks';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
// What the card hands the block list, and the list's onChange to drive it.
const blockList = vi.hoisted(() => ({
  latest: null as {
    selection: unknown;
    sizeFilters: unknown;
    onChange: (selection: unknown) => void;
  } | null,
}));
const tallWide = vi.hoisted(() => ({ hasShorter: false, hasNarrower: false }));

vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-constants', () => ({
  getTallWideScope: () => ({ ...tallWide, narrowerSizeIds: [], shorterSizeIds: [] }),
}));
vi.mock('@boardsesh/climb-filters', () => ({
  formatMinAscentsFilterCount: (value: number) => String(value),
  getMinAscentsFilterOptions: () => [0, 1, 10],
  getMinRatingPickerValue: (value: number | null | undefined) => (value != null && value > 0 ? value : null),
}));
vi.mock('../WorkoutBlockList', () => ({
  WorkoutBlockList: (props: { selection: unknown; sizeFilters: unknown; onChange: (selection: unknown) => void }) => {
    blockList.latest = props;
    return null;
  },
}));
// Only `sizeFilterAvailability` is used here; the controls behind it stay out.
vi.mock('../generator-controls', () => ({ Chip: () => null, generatorControlStyles: {} }));
vi.mock('../../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', null, title),
}));
vi.mock('../../../SegmentedControl', () => ({ SegmentedControl: () => null }));
vi.mock('../../../CollapsibleSection', () => ({ CollapsibleSection: () => null }));
vi.mock('../../../StarRating', () => ({ StarRating: () => null }));
vi.mock('../../../SwitchRow', () => ({ SwitchRow: () => null }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, variant: 'liquidGlass', m3: {} }),
}));
vi.mock('../../../../theme/tokens', () => ({ spacing: {} }));

import { GeneratorPickerCard } from '../GeneratorPickerCard';

const ONE_BLOCK: GeneratorSelection = {
  blocks: [
    {
      id: 'block-1',
      kind: 'workout',
      options: { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 20 },
      filters: DEFAULT_WORKOUT_FILTERS,
    },
  ],
};

function renderCard(selection: GeneratorSelection, onChange = vi.fn()) {
  const view = render(
    createElement(GeneratorPickerCard, {
      boardName: 'kilter',
      layoutId: 8,
      sizeId: 21,
      angle: 40,
      selection,
      onChange,
    }),
  );
  return { ...view, onChange };
}

function changeBlocks(next: GeneratorSelection) {
  act(() => blockList.latest?.onChange(next));
}

beforeEach(() => {
  analytics.track.mockClear();
  blockList.latest = null;
  tallWide.hasShorter = false;
  tallWide.hasNarrower = false;
});

describe('GeneratorPickerCard', () => {
  it('fires "Workout Generator Opened" with web-aligned props when the first block is added', () => {
    const { onChange } = renderCard(NO_WORKOUT);

    changeBlocks(ONE_BLOCK);

    // Exact payload web sends (playlist-generator-drawer.tsx): { targetType, boardName, angle }.
    // No `workoutType` key — PostHog groups by exact prop name, so it must match web.
    expect(analytics.track).toHaveBeenCalledExactlyOnceWith('Workout Generator Opened', {
      targetType: 'session',
      boardName: 'kilter',
      angle: 40,
    });
    expect(onChange).toHaveBeenCalledWith(ONE_BLOCK);
  });

  it('does not fire for edits to a workout that already has blocks', () => {
    renderCard(ONE_BLOCK);

    changeBlocks({
      ...ONE_BLOCK,
      blocks: [
        ...ONE_BLOCK.blocks,
        {
          id: 'block-2',
          kind: 'workout',
          options: { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 18 },
          filters: DEFAULT_WORKOUT_FILTERS,
        },
      ],
    });
    changeBlocks(NO_WORKOUT);

    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('has no climb filters of its own: each block carries them', () => {
    const screen = renderCard(ONE_BLOCK);

    expect(screen.queryByText('mobile.session.preGeneratorClimbFilters')).toBeNull();
  });

  it('tells the blocks which size filters the board offers', () => {
    renderCard(ONE_BLOCK);
    expect(blockList.latest?.sizeFilters).toEqual({ tall: false, wide: false });

    tallWide.hasShorter = true;
    renderCard(ONE_BLOCK);
    expect(blockList.latest?.sizeFilters).toEqual({ tall: true, wide: false });
  });

  it('clears a tall-climbs filter the board size cannot use, on every block that has it', () => {
    const tallFilters = { ...DEFAULT_WORKOUT_FILTERS, onlyTallClimbs: true };
    const [onlyBlock] = ONE_BLOCK.blocks;
    const tallOnly: GeneratorSelection = {
      blocks: [
        { ...onlyBlock, filters: tallFilters },
        { ...onlyBlock, id: 'block-2' },
        { ...onlyBlock, id: 'block-3', filters: tallFilters },
      ],
    };
    const { onChange } = renderCard(tallOnly);

    expect(onChange).toHaveBeenCalledWith({
      blocks: [
        { ...onlyBlock, filters: DEFAULT_WORKOUT_FILTERS },
        tallOnly.blocks[1],
        { ...onlyBlock, id: 'block-3', filters: DEFAULT_WORKOUT_FILTERS },
      ],
    });
  });
});

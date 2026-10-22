// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PYRAMID_OPTIONS, DEFAULT_VOLUME_OPTIONS } from '@boardsesh/playlist-generator';
import { NO_WORKOUT, type GeneratorSelection } from '../workout-blocks';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
// What the card hands the block list, and the list's onChange to drive it.
const blockList = vi.hoisted(() => ({
  latest: null as { selection: unknown; onChange: (selection: unknown) => void } | null,
}));
const chips = vi.hoisted(() => ({ byLabel: new Map<string, () => void>() }));
const segments = vi.hoisted(() => ({ byLabel: new Map<string, (key: string) => void>() }));
const collapsible = vi.hoisted(() => ({ titles: [] as string[] }));
const tallWide = vi.hoisted(() => ({ hasShorter: false, hasNarrower: false }));

vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) => {
      if (key === 'mobile.session.preGeneratorOptionAccessibilityLabel' && options) {
        return `${options.group}, ${options.value}`;
      }
      if (key === 'mobile.session.preGeneratorMinAscentsOption' && options) return `${options.value}+`;
      return key;
    },
  }),
}));
vi.mock('@boardsesh/board-constants', () => ({
  getTallWideScope: () => ({ ...tallWide, narrowerSizeIds: [], shorterSizeIds: [] }),
}));
vi.mock('@boardsesh/climb-filters', () => ({
  formatMinAscentsFilterCount: (value: number) => String(value),
  getMinAscentsFilterOptions: () => [0, 1, 10],
  getMinRatingPickerValue: (value: number | null | undefined) => (value != null && value > 0 ? value : null),
}));
vi.mock('../WorkoutBlockList', () => ({
  WorkoutBlockList: (props: { selection: unknown; onChange: (selection: unknown) => void }) => {
    blockList.latest = props;
    return null;
  },
}));
vi.mock('../generator-controls', () => ({
  Chip: ({ onPress, accessibilityLabel }: { onPress: () => void; accessibilityLabel?: string }) => {
    if (accessibilityLabel) chips.byLabel.set(accessibilityLabel, onPress);
    return null;
  },
  generatorControlStyles: { chipRow: {}, groupedCard: {}, groupDivider: {} },
}));
vi.mock('../../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', null, title),
}));
vi.mock('../../../SegmentedControl', () => ({
  SegmentedControl: ({
    accessibilityLabel,
    onSelect,
  }: {
    accessibilityLabel?: string;
    onSelect: (key: string) => void;
  }) => {
    if (accessibilityLabel) segments.byLabel.set(accessibilityLabel, onSelect);
    return null;
  },
}));
vi.mock('../../../CollapsibleSection', () => ({
  // Render children so the filter controls mount.
  CollapsibleSection: ({ title, children }: { title: string; children?: ReactNode }) => {
    collapsible.titles.push(title);
    return createElement('div', null, children);
  },
}));
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
  ...NO_WORKOUT,
  blocks: [{ id: 'block-1', kind: 'workout', options: { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 20 } }],
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
  chips.byLabel.clear();
  segments.byLabel.clear();
  collapsible.titles = [];
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
        { id: 'block-2', kind: 'workout', options: { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 18 } },
      ],
    });
    changeBlocks(NO_WORKOUT);

    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('hides the climb filters until there is a block for them to apply to', () => {
    renderCard(NO_WORKOUT);
    expect(collapsible.titles).toEqual([]);

    renderCard(ONE_BLOCK);
    expect(collapsible.titles).toContain('mobile.session.preGeneratorClimbFilters');
  });

  it('sets the filters once for the whole selection, leaving the blocks alone', () => {
    const { onChange } = renderCard(ONE_BLOCK);

    act(() => segments.byLabel.get('mobile.session.preGeneratorClimbBias')?.('attempted'));
    expect(onChange).toHaveBeenLastCalledWith({
      blocks: ONE_BLOCK.blocks,
      filters: { ...ONE_BLOCK.filters, climbBias: 'attempted' },
    });

    act(() => chips.byLabel.get('mobile.session.preGeneratorMinAscents, 10+')?.());
    expect(onChange).toHaveBeenLastCalledWith({
      blocks: ONE_BLOCK.blocks,
      filters: { ...ONE_BLOCK.filters, minAscents: 10 },
    });
  });

  it('clears a tall-climbs filter the board size cannot use', () => {
    const tallOnly: GeneratorSelection = { ...ONE_BLOCK, filters: { ...ONE_BLOCK.filters, onlyTallClimbs: true } };
    const { onChange } = renderCard(tallOnly);

    expect(onChange).toHaveBeenCalledWith({ ...tallOnly, filters: { ...tallOnly.filters, onlyTallClimbs: false } });
  });
});

// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, useState, type ReactNode, type Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  type GeneratorOptions,
} from '@boardsesh/playlist-generator';
import {
  DEFAULT_WORKOUT_FILTERS,
  NO_WORKOUT,
  type GeneratorSelection,
  type WorkoutBlock,
  type WorkoutFilters,
} from '../workout-blocks';

const uuids = vi.hoisted(() => {
  let counter = 0;
  return { next: () => `uuid-${++counter}` };
});
// Each card's onLayout and ⋯ menu, keyed by the card's testID / the menu's label.
const layouts = vi.hoisted(() => ({ byTestId: new Map<string, () => void>() }));
const menus = vi.hoisted(() => ({
  byLabel: new Map<string, { labels: string[]; onSelectIndex: (index: number) => void }>(),
}));
const segments = vi.hoisted(() => ({ byLabel: new Map<string, (key: string) => void>() }));

vi.mock('expo-crypto', () => ({ randomUUID: () => uuids.next() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) => {
      if (key === 'mobile.session.preGeneratorOptionAccessibilityLabel' && options) {
        return `${options.group}, ${options.value}`;
      }
      if (key === 'mobile.session.preGeneratorBlockTitle' && options) return `Block ${options.position}`;
      if (key === 'mobile.session.preGeneratorBlockHeaderAccessibilityLabel' && options) {
        return `Block ${options.position}: ${options.type}`;
      }
      return options ? `${key}(${Object.values(options).join(',')})` : key;
    },
  }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({
    children,
    testID,
    onLayout,
    ref,
  }: {
    children?: ReactNode;
    testID?: string;
    onLayout?: () => void;
    ref?: Ref<HTMLDivElement>;
  }) => {
    if (testID && onLayout) layouts.byTestId.set(testID, onLayout);
    return createElement('div', { 'data-testid': testID, ref }, children);
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityState,
    children,
  }: {
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean };
    children?: ReactNode;
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        disabled,
        'aria-label': accessibilityLabel,
        'aria-expanded': accessibilityState?.expanded,
      },
      children,
    ),
}));
vi.mock('../../../AppMenu', () => ({
  AppMenu: ({
    accessibilityLabel,
    actions,
    onSelectIndex,
  }: {
    accessibilityLabel: string;
    actions: Array<{ label: string }>;
    onSelectIndex: (index: number) => void;
  }) => {
    menus.byLabel.set(accessibilityLabel, { labels: actions.map((action) => action.label), onSelectIndex });
    return null;
  },
}));
vi.mock('../../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
}));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../SegmentedControl', () => ({
  SegmentedControl: ({
    accessibilityLabel,
    onSelect,
  }: {
    accessibilityLabel: string;
    onSelect: (key: string) => void;
  }) => {
    segments.byLabel.set(accessibilityLabel, onSelect);
    return null;
  },
}));
// Open, so a card's filter controls mount under its fields.
vi.mock('../../../CollapsibleSection', () => ({
  CollapsibleSection: ({ title, summary, children }: { title: string; summary?: string; children?: ReactNode }) =>
    createElement('div', { 'data-filters': title, 'data-summary': summary }, children),
}));
vi.mock('../../../StarRating', () => ({ StarRating: () => null }));
vi.mock('../../../SwitchRow', () => ({ SwitchRow: () => null }));
vi.mock('../../../SectionDisclosureChevron', () => ({ SectionDisclosureChevron: () => null }));
vi.mock('../../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../grade', () => ({ GradeSingleSelectRail: () => null }));
// The shared chip and steppers have their own coverage through the filters.
vi.mock('../generator-controls', () => ({
  Chip: ({ onPress, accessibilityLabel }: { onPress: () => void; accessibilityLabel?: string }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }),
  GroupedSteppers: () => null,
  workoutStepperRows: () => [],
  generatorControlStyles: { chipRow: {}, groupedCard: {}, groupDivider: {} },
  getDefaultTargetGrade: () => 15,
  toRailGrades: () => [],
}));
vi.mock('../../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGradeByDifficultyId: (difficultyId: number) => `V${difficultyId}` }),
}));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../../theme/tokens', () => ({ spacing: {} }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {}, variant: 'liquidGlass', m3: {} }),
}));

import { WorkoutBlockList } from '../WorkoutBlockList';

const changes = vi.fn<(selection: GeneratorSelection) => void>();
const revealBlock = vi.fn();

const STRICT: WorkoutFilters = { ...DEFAULT_WORKOUT_FILTERS, climbBias: 'any', minAscents: 50 };
const workout = (id: string, options: GeneratorOptions, filters = DEFAULT_WORKOUT_FILTERS): WorkoutBlock => ({
  id,
  kind: 'workout',
  options,
  filters,
});
const warmUp = (id: string, filters = DEFAULT_WORKOUT_FILTERS): WorkoutBlock => ({
  id,
  kind: 'warmUp',
  warmUpType: 'standard',
  filters,
});
const pyramid = (id: string, targetGrade: number) => workout(id, { ...DEFAULT_PYRAMID_OPTIONS, targetGrade });

// Holds the selection like PreSessionView does, so taps re-render the list.
function Harness({ initial }: { initial: GeneratorSelection }) {
  const [selection, setSelection] = useState(initial);
  return createElement(WorkoutBlockList, {
    boardName: 'kilter',
    sizeFilters: { tall: false, wide: false },
    selection,
    onChange: (next: GeneratorSelection) => {
      changes(next);
      setSelection(next);
    },
    onRevealBlock: revealBlock,
  });
}

function renderList(blocks: WorkoutBlock[]) {
  return render(createElement(Harness, { initial: { ...NO_WORKOUT, blocks } }));
}

function lastSelection(): GeneratorSelection {
  const selection = changes.mock.calls.at(-1)?.[0];
  if (!selection) throw new Error('expected a change');
  return selection;
}

// Card headers are the only buttons that announce an expanded state.
function headers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('button[aria-expanded]'));
}

function menu(position: number) {
  const entry = menus.byLabel.get(`mobile.session.preGeneratorBlockActionsAccessibilityLabel(${position})`);
  if (!entry) throw new Error(`no menu for block ${position}`);
  return entry;
}

function selectMenuAction(position: number, label: string) {
  const { labels, onSelectIndex } = menu(position);
  act(() => onSelectIndex(labels.indexOf(label)));
}

beforeEach(() => {
  changes.mockClear();
  revealBlock.mockClear();
  layouts.byTestId.clear();
  menus.byLabel.clear();
  segments.byLabel.clear();
});

describe('WorkoutBlockList', () => {
  it('says there is no workout yet, then adds an open Volume block', () => {
    const screen = renderList([]);

    expect(screen.getByText('mobile.session.preGeneratorEmpty')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('mobile.session.preGeneratorAddBlock'));

    expect(lastSelection().blocks).toEqual([workout('uuid-1', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 15 })]);
    expect(screen.queryByText('mobile.session.preGeneratorEmpty')).toBeNull();
    expect(headers(screen.container).map((header) => header.getAttribute('aria-expanded'))).toEqual(['true']);
  });

  it('keeps one card open at a time without touching the selection', () => {
    const screen = renderList([pyramid('first', 20), pyramid('second', 18)]);

    // Screenshot mode's first block shows open.
    expect(headers(screen.container).map((header) => header.getAttribute('aria-expanded'))).toEqual(['true', 'false']);

    fireEvent.click(headers(screen.container)[1]);
    expect(headers(screen.container).map((header) => header.getAttribute('aria-expanded'))).toEqual(['false', 'true']);

    fireEvent.click(headers(screen.container)[1]);
    expect(headers(screen.container).map((header) => header.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
    // Opening and closing is the list's own state: the preview never rebuilds for it.
    expect(changes).not.toHaveBeenCalled();
  });

  it('shows a collapsed card’s summary on its header', () => {
    const screen = renderList([pyramid('first', 20), pyramid('second', 18)]);

    expect(headers(screen.container)[1].getAttribute('aria-label')).toBe(
      'Block 2: mobile.session.preGeneratorPyramid. V18 · mobile.session.preGeneratorBlockSummarySteps(5) · mobile.session.preGeneratorBlockSummaryPerStep(1)',
    );
    // The open card's header names it apart from its selected type chip.
    expect(headers(screen.container)[0].getAttribute('aria-label')).toBe('Block 1: mobile.session.preGeneratorPyramid');
    expect(screen.getAllByLabelText('Block 1, mobile.session.preGeneratorPyramid')).toHaveLength(1);
  });

  it('moves and removes any block from its menu, the first included', () => {
    renderList([pyramid('first', 20), pyramid('second', 18), pyramid('third', 16)]);

    // Moves that can't happen are left out.
    expect(menu(1).labels).toEqual([
      'mobile.session.preGeneratorMoveBlockDown',
      'mobile.session.preGeneratorRemoveBlock',
    ]);
    expect(menu(3).labels).toEqual([
      'mobile.session.preGeneratorMoveBlockUp',
      'mobile.session.preGeneratorRemoveBlock',
    ]);

    selectMenuAction(1, 'mobile.session.preGeneratorMoveBlockDown');
    expect(lastSelection().blocks.map((block) => block.id)).toEqual(['second', 'first', 'third']);

    selectMenuAction(1, 'mobile.session.preGeneratorRemoveBlock');
    expect(lastSelection().blocks.map((block) => block.id)).toEqual(['first', 'third']);
  });

  it("tells a warm-up at position 2 that it ramps to block 3's grade", () => {
    const screen = renderList([pyramid('first', 12), warmUp('warm'), pyramid('third', 20)]);

    fireEvent.click(headers(screen.container)[1]);

    expect(screen.getByText('mobile.session.preGeneratorWarmUpTarget(V20,3)')).toBeTruthy();
  });

  it('tells a trailing warm-up it has nothing to ramp to', () => {
    const screen = renderList([pyramid('first', 12), warmUp('warm')]);

    expect(headers(screen.container)[1].getAttribute('aria-label')).toContain(
      'mobile.session.preGeneratorWarmUpSummaryNoTarget',
    );
    fireEvent.click(headers(screen.container)[1]);
    expect(screen.getByText('mobile.session.preGeneratorWarmUpNoTarget')).toBeTruthy();

    act(() => segments.byLabel.get('mobile.session.preGeneratorWarmUp')?.('extended'));
    expect(lastSelection().blocks[1]).toEqual({ ...warmUp('warm'), warmUpType: 'extended' });
  });

  it('switches a block to a warm-up and back from its chips', () => {
    const screen = renderList([pyramid('first', 20), pyramid('second', 18)]);

    fireEvent.click(screen.getByLabelText('Block 1, mobile.session.preWorkoutSectionWarmUp'));
    expect(lastSelection().blocks[0]).toEqual(warmUp('first'));

    // Back to a workout at the grade of the block after it.
    fireEvent.click(screen.getByLabelText('Block 1, mobile.session.preGeneratorVolume'));
    expect(lastSelection().blocks[0]).toEqual(workout('first', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 18 }));
  });

  it("sets the open block's own filters, leaving the other blocks' alone", () => {
    const screen = renderList([pyramid('first', 20), pyramid('second', 18)]);

    // Only the open card shows its filters.
    expect(screen.container.querySelectorAll('[data-filters]')).toHaveLength(1);
    act(() => segments.byLabel.get('mobile.session.preGeneratorClimbBias')?.('attempted'));

    expect(lastSelection().blocks.map((block) => block.filters.climbBias)).toEqual(['attempted', 'unfamiliar']);
  });

  it('marks a closed card whose filters are not the defaults', () => {
    const screen = renderList([pyramid('first', 20), warmUp('warm', STRICT), warmUp('plain')]);

    expect(headers(screen.container)[1].getAttribute('aria-label')).toContain(
      ' · mobile.session.preGeneratorBlockSummaryFiltered',
    );
    expect(headers(screen.container)[2].getAttribute('aria-label')).not.toContain('Filtered');
  });

  it("gives a new block the last block's filters, and keeps them through a type change", () => {
    const screen = renderList([pyramid('first', 20), warmUp('warm', STRICT)]);

    fireEvent.click(screen.getByLabelText('mobile.session.preGeneratorAddBlock'));
    const addedId = lastSelection().blocks[2].id;
    expect(lastSelection().blocks[2]).toEqual(workout(addedId, { ...DEFAULT_LADDER_OPTIONS, targetGrade: 20 }, STRICT));

    // The new block opens on add; turning it into a warm-up keeps its filters.
    fireEvent.click(screen.getByLabelText('Block 3, mobile.session.preWorkoutSectionWarmUp'));
    expect(lastSelection().blocks[2]).toEqual(warmUp(addedId, STRICT));
  });

  it('greys out Add a block at five blocks', () => {
    const screen = renderList([warmUp('w1'), pyramid('b2', 20), warmUp('w3'), pyramid('b4', 18), pyramid('b5', 16)]);

    const addRow = screen.getByLabelText('mobile.session.preGeneratorBlockLimit(5)');
    expect(addRow).toHaveProperty('disabled', true);
    expect(screen.queryByLabelText('mobile.session.preGeneratorAddBlock')).toBeNull();
  });

  it('scrolls a card into view once, after it opens', () => {
    const screen = renderList([pyramid('first', 20), pyramid('second', 18)]);

    // A card that was open from the start is not scrolled to.
    act(() => layouts.byTestId.get('workout-block-1')?.());
    expect(revealBlock).not.toHaveBeenCalled();

    fireEvent.click(headers(screen.container)[1]);
    act(() => layouts.byTestId.get('workout-block-2')?.());
    act(() => layouts.byTestId.get('workout-block-2')?.());

    expect(revealBlock).toHaveBeenCalledTimes(1);
    expect(revealBlock).toHaveBeenCalledWith(screen.getByTestId('workout-block-2'));

    fireEvent.click(screen.getByLabelText('mobile.session.preGeneratorAddBlock'));
    act(() => layouts.byTestId.get('workout-block-3')?.());
    expect(revealBlock).toHaveBeenCalledTimes(2);
  });
});

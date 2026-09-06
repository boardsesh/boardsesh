// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';

// The swipeable's props and the row's accessibility surface are captured via
// hoisted vars so tests can drive onSwipeableWillOpen / onAccessibilityAction
// without a native tree. deriveGradeTokenModel and the other row-meta rules
// (@boardsesh/logbook) are intentionally NOT mocked so the real display
// decisions + the row's label formatting are exercised end-to-end.
const swipeable = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
const a11y = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
// Controls the app-wide "Show Boardsesh grades" toggle for the row. Default OFF
// so the existing consensus-fallback tests are unaffected; the Boardsesh-grade
// block flips it per case. resolveCrowdDifficultyId (@boardsesh/logbook, via the
// real boardsesh-grade-display lib) is exercised for real off this flag.
const boardsesh = vi.hoisted(() => ({ active: false }));

vi.mock('react-native', () => ({
  View: (props: { children?: ReactNode } & Record<string, unknown>) => {
    // The row's accessible View is the only one carrying accessibilityActions.
    if (props.accessibilityActions) a11y.props = props;
    return createElement('div', null, props.children);
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ fontScale: 1, width: 375, height: 800 }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Interpolate counts so `mobile.logbook.tries:1` / `…row.stars:3` are assertable.
    t: (key: string, opts?: { count?: number }) => (opts?.count != null ? `${key}:${opts.count}` : key),
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    createAnimatedComponent: (C: unknown) => C,
  },
  useAnimatedStyle: () => ({}),
  useAnimatedReaction: () => {},
  interpolate: () => 0,
  Extrapolation: { CLAMP: 'clamp' },
  runOnJS:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
  useSharedValue: (v: unknown) => ({ value: v }),
}));
vi.mock('react-native-gesture-handler', () => {
  // Defined inside the factory because vi.mock is hoisted above module-scope vars.
  const gestureChain = () => {
    const builder: Record<string, () => typeof builder> = {};
    for (const method of [
      'maxDuration',
      'maxDistance',
      'minDuration',
      'onStart',
      'onEnd',
      'activeOffsetY',
      'failOffsetX',
    ]) {
      builder[method] = () => builder;
    }
    return builder;
  };
  return {
    Gesture: { Tap: gestureChain, LongPress: gestureChain, Pan: gestureChain, Exclusive: (...g: unknown[]) => g[0] },
    GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  };
});
// Capture the swipeable's props so tests can fire onSwipeableWillOpen directly.
vi.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  default: (props: { children?: ReactNode } & Record<string, unknown>) => {
    swipeable.props = props;
    return createElement('div', null, props.children);
  },
}));
vi.mock('@boardsesh/profile-stats', () => ({
  getLayoutDisplayName: () => 'Kilter Original',
  // dayjs-like: the row only calls .toDate() for toLocaleTimeString.
  parseTickTime: () => ({ toDate: () => new Date('2026-06-15T10:00:00Z') }),
}));
vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: () => '#7A3FE4',
  DEFAULT_GRADE_COLOR: '#8A8A8E',
}));
// Carries the variant so the grade slot can be told apart from the meta line.
vi.mock('../../Text', () => ({
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('span', { 'data-variant': variant }, children),
}));
// Icons render as <i data-icon="…"> so tests can assert which glyphs mounted.
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('../../ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => null }));
vi.mock('../../use-swipe-arm', () => ({
  useSwipeArm: () => ({ armedRef: { current: false }, arm: () => {}, disarm: () => {} }),
}));
vi.mock('../../../theme/colors', () => ({
  brandColors: { primary: '#6D28D9', error: '#C81E1E' },
  withAlpha: (color: string) => color,
}));
vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { white: '#fff', systemGray: '#888', separator: '#ccc' },
}));
vi.mock('../../../theme/tokens', () => ({ spacing: new Proxy({}, { get: () => 8 }), borderRadius: { sm: 4 } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      background: '#fff',
      secondaryBackground: '#f5f5f5',
      separator: '#ccc',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
    },
    brandColors: { warning: '#B45309', success: '#047857' },
  }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGrade: (g: string | null | undefined) => g ?? null,
    formatGradeByDifficultyId: (id: number | null | undefined) => (id != null ? `V${id}` : null),
  }),
}));
vi.mock('../../../hooks/use-display-grade', () => ({
  useBoardseshGradesActive: () => boardsesh.active,
}));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({
  renderBoardToPlaylistConfig: () => ({ boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: [1] }),
}));
vi.mock('../../../lib/haptics', () => ({
  hapticSelection: () => {},
  hapticMedium: () => {},
  hapticLight: () => {},
  hapticSuccess: () => {},
}));

import { LogbookRow } from '../LogbookRow';

function ascent(overrides: Partial<AscentFeedItem> = {}): AscentFeedItem {
  return {
    uuid: 'tick-1',
    climbUuid: 'climb-1',
    climbName: 'Test Climb',
    setterUsername: 'setter',
    boardType: 'kilter',
    boardId: 1,
    boardDisplayName: 'Kilter',
    layoutId: 1,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 1,
    quality: null,
    difficulty: null,
    difficultyName: null,
    consensusDifficulty: null,
    consensusDifficultyName: null,
    qualityAverage: null,
    isBenchmark: false,
    isNoMatch: false,
    comment: null,
    climbedAt: '2026-06-15T10:00:00.000Z',
    frames: 'p1r1',
    ...overrides,
  } as AscentFeedItem;
}

type RowHandlers = {
  onActivate?: (item: AscentFeedItem) => void;
  showBoardInMeta?: boolean;
  groupTries?: number;
  onOpenActions?: (item: AscentFeedItem) => void;
  onEdit?: (item: AscentFeedItem) => void;
  onDeleteRequest?: (item: AscentFeedItem, method: 'swipe' | 'a11y') => void;
};

function renderRow(item: AscentFeedItem, handlers: RowHandlers = {}) {
  return render(createElement(LogbookRow, { ascent: item, onActivate: () => {}, ...handlers }));
}

function iconNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-icon]')).map((iconEl) => iconEl.getAttribute('data-icon') ?? '');
}

beforeEach(() => {
  swipeable.props = null;
  a11y.props = null;
  boardsesh.active = false;
});

// The logbook is a DIARY surface: it is about what YOU did, so your own grade
// is the unremarkable number here and the CROWD's is the one that has to say
// whose it is. Exactly one number sits in the grade slot; the other, when they
// differ, leads the meta line. No delta arrow — the two numbers are adjacent on
// an ordinal scale, so an arrow only restates what reading them already says.
function gradeSlotText(container: HTMLElement): string {
  return container.querySelector('[data-variant="title3"]')?.textContent ?? '';
}

describe('LogbookRow — grade slot', () => {
  it('MARKS the crowd grade with the people glyph for a tick you never graded', () => {
    const { container } = renderRow(ascent({ consensusDifficulty: 9, consensusDifficultyName: 'V9' }));

    expect(gradeSlotText(container)).toBe('V9');
    const icons = iconNames(container);
    // One people glyph: the number in the slot is not yours.
    expect(icons.filter((name) => name === 'people')).toHaveLength(1);
    // Never both markers — there is only one number in the slot.
    expect(icons).not.toContain('person');
    // The crowd can't disagree with a grade that was never logged, so it has
    // nothing to add to the meta line either.
    expect(container.textContent).not.toContain('V9 · ');
  });

  it('leaves YOUR grade unmarked and sends the crowd’s to the meta line', () => {
    const { container } = renderRow(
      ascent({ difficulty: 8, difficultyName: 'V8', consensusDifficulty: 9, consensusDifficultyName: 'V9' }),
    );

    expect(gradeSlotText(container)).toBe('V8');
    const icons = iconNames(container);
    expect(icons).not.toContain('people');
    expect(icons).not.toContain('person');
    // The crowd's number leads the meta run — one line, no stacked second grade.
    expect(container.textContent).toContain('V9 · mobile.logbook.tries:1');
    // No arrow: the two numbers are right there to compare.
    expect(icons).not.toContain('chevron.up');
    expect(icons).not.toContain('chevron.down');
  });

  it('drops the meta token when your grade renders to the same label as the crowd’s', () => {
    const { container } = renderRow(
      ascent({ difficulty: 9, difficultyName: 'V9', consensusDifficulty: 9, consensusDifficultyName: 'V9' }),
    );

    expect(gradeSlotText(container)).toBe('V9');
    const icons = iconNames(container);
    expect(icons).not.toContain('people');
    expect(container.textContent).not.toContain('V9 · mobile.logbook.tries:1');
  });

  it('speaks the crowd marker, which VoiceOver cannot see', () => {
    renderRow(ascent({ consensusDifficulty: 9, consensusDifficultyName: 'V9' }));
    expect(a11y.props?.accessibilityLabel).toContain('common:mobile.gradeToken.a11yCommunity');
  });
});

describe('LogbookRow — Boardsesh grade fallback', () => {
  it('keeps the climber’s own grade in the slot and puts the Boardsesh grade on the meta line', () => {
    boardsesh.active = true;
    // User graded V18; Boardsesh grade (trusted) is V22 and no legacy consensus.
    const { container } = renderRow(
      ascent({ difficulty: 18, difficultyName: '18', boardseshDifficulty: 22, boardseshConfidence: 'confirmed' }),
    );

    // The logger's own grade always wins the slot, and needs no marker here.
    expect(gradeSlotText(container)).toBe('V18');
    const icons = iconNames(container);
    expect(icons).not.toContain('people');
    // Boardsesh grade fills the crowd side, on the meta line.
    expect(container.textContent).toContain('V22 · mobile.logbook.tries:1');
    expect(icons).not.toContain('chevron.up');
    expect(icons).not.toContain('chevron.down');
  });

  it('shows the Boardsesh grade in the slot (marked) for an ungraded tick when active', () => {
    boardsesh.active = true;
    const { container, queryByText } = renderRow(
      ascent({
        consensusDifficulty: 25,
        consensusDifficultyName: '25',
        boardseshDifficulty: 20,
        boardseshConfidence: 'confirmed',
      }),
    );

    // Boardsesh grade replaces the legacy consensus as the crowd grade shown.
    expect(gradeSlotText(container)).toBe('V20');
    expect(queryByText('V25')).toBeNull();
    expect(iconNames(container).filter((name) => name === 'people')).toHaveLength(1);
  });

  it('shows the legacy consensus for an ungraded tick when the toggle is off', () => {
    boardsesh.active = false;
    const { container, queryByText } = renderRow(
      ascent({
        consensusDifficulty: 25,
        consensusDifficultyName: '25',
        boardseshDifficulty: 20,
        boardseshConfidence: 'confirmed',
      }),
    );

    expect(gradeSlotText(container)).toBe('V25');
    expect(queryByText('V20')).toBeNull();
  });

  it('never uses a setter_only Boardsesh grade — falls back to the consensus even when active', () => {
    boardsesh.active = true;
    const { container, queryByText } = renderRow(
      ascent({
        consensusDifficulty: 25,
        consensusDifficultyName: '25',
        boardseshDifficulty: 20,
        boardseshConfidence: 'setter_only',
      }),
    );

    expect(gradeSlotText(container)).toBe('V25');
    expect(queryByText('V20')).toBeNull();
  });
});

describe('LogbookRow — meta line', () => {
  it('renders no stars part when quality is null or the "cleared" 0', () => {
    const { container: unratedContainer } = renderRow(ascent({ quality: null }));
    expect(unratedContainer.textContent).not.toContain('mobile.logbook.row.stars');

    const { container: clearedContainer } = renderRow(ascent({ quality: 0 }));
    expect(clearedContainer.textContent).not.toContain('mobile.logbook.row.stars');
  });

  it('renders the stars label for a rated tick', () => {
    const { container } = renderRow(ascent({ quality: 3 }));
    expect(container.textContent).toContain('mobile.logbook.row.stars:3');
  });

  it('shows no note glyph for a whitespace-only comment', () => {
    const { container } = renderRow(ascent({ comment: '   ' }));
    expect(iconNames(container)).not.toContain('edit');
  });

  it('shows the note glyph for a real comment', () => {
    const { container } = renderRow(ascent({ comment: 'beta' }));
    expect(iconNames(container)).toContain('edit');
  });

  it('shows the video glyph only when a beta video is attached', () => {
    const { container: withBeta } = renderRow(ascent({ hasBetaVideo: true }));
    expect(iconNames(withBeta)).toContain('video.fill');

    const { container: withoutBeta } = renderRow(ascent({ hasBetaVideo: null }));
    expect(iconNames(withoutBeta)).not.toContain('video.fill');
  });

  it('labels the wall by the user-named board, falling back to the layout', () => {
    // A named board is personal context and wins; ticks without one show the
    // wall product ("Kilter Original", per the profile-stats mock).
    const { container: named } = renderRow(ascent({ boardDisplayName: 'My Garage Board' }));
    expect(named.textContent).toContain('My Garage Board 40°');

    const { container: unnamed } = renderRow(ascent({ boardDisplayName: null }));
    expect(unnamed.textContent).toContain('Kilter Original 40°');
  });

  it('drops the BOARD but keeps the angle when a divider above covers the wall', () => {
    // Fixture's named board wins the label ('Kilter 40°', not the layout name).
    const { container: covered } = renderRow(ascent({}), { showBoardInMeta: false });
    expect(covered.textContent).not.toContain('Kilter 40°');
    expect(covered.textContent).toContain('40°'); // angle never leaves the row

    const { container: uncovered } = renderRow(ascent({}));
    expect(uncovered.textContent).toContain('Kilter 40°');
  });

  it('renders the composite "Flash · N tries" label when a grouped flash day carries extra tries', () => {
    const { container } = renderRow(ascent({ status: 'flash', attemptCount: 1 }), { groupTries: 5 });
    expect(container.textContent).toContain('mobile.logbook.status.flash · mobile.logbook.tries:5');
    expect(a11y.props?.accessibilityLabel).toContain('mobile.logbook.tries:5');
  });

  it('keeps an ungrouped flash bare even with a contradictory imported attemptCount', () => {
    // Imported data can carry status=flash with attemptCount > 1; without
    // groupTries (flat views) the row must not grow a tries suffix.
    const { container } = renderRow(ascent({ status: 'flash', attemptCount: 3 }));
    expect(container.textContent).toContain('mobile.logbook.status.flash');
    expect(container.textContent).not.toContain('mobile.logbook.tries:3');
    expect(a11y.props?.accessibilityLabel).not.toContain('mobile.logbook.tries');
  });

  it('clamps an imported 0-attempt send to 1 try', () => {
    const { container } = renderRow(ascent({ status: 'send', attemptCount: 0 }));
    expect(container.textContent).toContain('mobile.logbook.tries:1');
  });
});

describe('LogbookRow — swipe wiring', () => {
  it('maps the swipe directions onto delete (right-to-left) and edit (left-to-right)', () => {
    const item = ascent();
    const onEdit = vi.fn();
    const onDeleteRequest = vi.fn();
    renderRow(item, { onEdit, onDeleteRequest });
    expect(swipeable.props).not.toBeNull();

    const willOpen = swipeable.props?.onSwipeableWillOpen as (direction: 'left' | 'right') => void;
    // ReanimatedSwipeable reports the SWIPE direction: 'left' = the RIGHT
    // actions (Delete) opened; 'right' = the LEFT actions (Edit).
    willOpen('left');
    expect(onDeleteRequest).toHaveBeenCalledWith(item, 'swipe');
    expect(onEdit).not.toHaveBeenCalled();

    willOpen('right');
    expect(onEdit).toHaveBeenCalledWith(item, 'swipe');
    expect(onDeleteRequest).toHaveBeenCalledTimes(1);
  });
});

describe('LogbookRow — accessibility actions', () => {
  it('exposes edit/delete/more and routes the delete action with the a11y method', () => {
    const item = ascent();
    const onEdit = vi.fn();
    const onDeleteRequest = vi.fn();
    const onOpenActions = vi.fn();
    renderRow(item, { onEdit, onDeleteRequest, onOpenActions });
    expect(a11y.props).not.toBeNull();

    const actions = a11y.props?.accessibilityActions as { name: string }[];
    expect(actions.map((action) => action.name)).toEqual(['edit', 'delete', 'more']);

    const onAction = a11y.props?.onAccessibilityAction as (event: { nativeEvent: { actionName: string } }) => void;
    onAction({ nativeEvent: { actionName: 'delete' } });
    expect(onDeleteRequest).toHaveBeenCalledWith(item, 'a11y');
    expect(onEdit).not.toHaveBeenCalled();
    expect(onOpenActions).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
vi.mock('../../PressableSurface', () => {
  const surface =
    (feedback: string) =>
    ({
      children,
      onPress,
      disabled,
      accessibilityLabel,
      style,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
      style?: unknown;
    }) =>
      createElement(
        'button',
        {
          disabled,
          onClick: disabled ? undefined : onPress,
          'aria-label': accessibilityLabel,
          'data-feedback': feedback,
          'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        },
        children,
      );
  return { PressableSurface: surface('animated'), StaticPressableSurface: surface('static') };
});
import { createElement, type ReactNode } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';

// The swipeable's props and the row's accessibility surface are captured via
// hoisted vars so tests can drive onSwipeableWillOpen / onAccessibilityAction
// without a native tree. deriveLogbookGradeDisplay and the other row-meta rules
// (@boardsesh/logbook) are intentionally NOT mocked so the real display
// decisions + the row's label formatting are exercised end-to-end.
const tracker = vi.hoisted(() => ({
  start: null as (() => void) | null,
  end: null as ((event: { translationX: number }) => void) | null,
}));
const swipeable = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
const panels = vi.hoisted(() => ({ enabled: false, language: '' }));
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
    t: (key: string, opts?: { count?: number }) =>
      opts?.count != null ? `${key}:${opts.count}` : `${key}${panels.language}`,
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
  const gestureChain = (track = false) => {
    const builder: Record<string, (callback?: unknown) => typeof builder> = {};
    for (const method of [
      'maxDuration',
      'maxDistance',
      'minDuration',
      'onStart',
      'onEnd',
      'activeOffsetY',
      'failOffsetX',
      'failOffsetY',
      'activeOffsetX',
      'enabled',
    ]) {
      builder[method] = (callback?: unknown) => {
        if (track && method === 'onEnd') tracker.end = callback as typeof tracker.end;
        if (track && method === 'onStart') tracker.start = callback as typeof tracker.start;
        return builder;
      };
    }
    return builder;
  };
  return {
    Gesture: {
      Tap: gestureChain,
      LongPress: gestureChain,
      Pan: () => gestureChain(true),
      Simultaneous: (...gestures: unknown[]) => gestures[0],
      Exclusive: (...g: unknown[]) => g[0],
    },
    GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  };
});
// Capture the swipeable's props so tests can fire onSwipeableWillOpen directly.
vi.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  default: (props: { children?: ReactNode } & Record<string, unknown>) => {
    swipeable.props = props;
    const renderAction = (callback: unknown) =>
      typeof callback === 'function' ? callback({ value: 0 }, { value: 0 }) : null;
    return createElement(
      'div',
      null,
      props.children,
      panels.enabled ? renderAction(props.renderLeftActions) : null,
      panels.enabled ? renderAction(props.renderRightActions) : null,
    );
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
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
// Icons render as <i data-icon="…"> so tests can assert which glyphs mounted.
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('../../ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => null }));
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
    // Tags a non-default board so a test can see which board the row formatted on.
    formatGradeByDifficultyId: (id: number | null | undefined, boardName?: string | null) =>
      id != null ? `V${id}${boardName && boardName !== 'kilter' ? ` (${boardName})` : ''}` : null,
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
  fontScale?: number;
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
  panels.enabled = false;
  panels.language = '';
});

describe('LogbookRow swipe feedback lifetime', () => {
  it('keeps panel layout and callbacks through first drag, close and recycling', () => {
    panels.enabled = true;
    const onEdit = vi.fn();
    const onDeleteRequest = vi.fn();
    const props = { onActivate: vi.fn(), onEdit, onDeleteRequest };
    const item = ascent();
    const screen = render(<LogbookRow ascent={item} {...props} />);
    const readPanels = () =>
      ['mobile.logbook.row.editAction', 'mobile.logbook.row.deleteAction'].map((label) => {
        const button = screen.getByRole('button', { name: label });
        return { label, style: button.getAttribute('data-style'), feedback: button.getAttribute('data-feedback') };
      });
    const idle = readPanels();
    expect(idle.map((panel) => panel.feedback)).toEqual(['static', 'static']);
    act(() => (swipeable.props?.onSwipeableOpenStartDrag as () => void)());
    expect(readPanels()).toEqual(idle.map((panel) => ({ ...panel, feedback: 'animated' })));
    expect(onEdit).not.toHaveBeenCalled();
    expect(onDeleteRequest).not.toHaveBeenCalled();
    act(() => (swipeable.props?.onSwipeableClose as () => void)());
    expect(readPanels()).toEqual(idle);
    act(() => (swipeable.props?.onSwipeableOpenStartDrag as () => void)());
    screen.rerender(<LogbookRow ascent={{ ...item, uuid: 'tick-2' }} {...props} />);
    expect(readPanels()).toEqual(idle);
    fireEvent.click(screen.getByRole('button', { name: 'mobile.logbook.row.editAction' }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'tick-2' }), 'swipe');
  });

  it('keeps panel render callbacks despite new translators, then refreshes changed labels', () => {
    panels.enabled = true;
    const props = { onActivate: vi.fn(), onEdit: vi.fn(), onDeleteRequest: vi.fn() };
    const item = ascent();
    const screen = render(<LogbookRow ascent={item} {...props} />);
    const left = swipeable.props?.renderLeftActions;
    const right = swipeable.props?.renderRightActions;
    screen.rerender(<LogbookRow ascent={{ ...item }} {...props} />);
    expect(swipeable.props?.renderLeftActions).toBe(left);
    expect(swipeable.props?.renderRightActions).toBe(right);
    panels.language = ':fr';
    screen.rerender(<LogbookRow ascent={{ ...item }} {...props} />);
    expect(swipeable.props?.renderLeftActions).not.toBe(left);
    expect(swipeable.props?.renderRightActions).not.toBe(right);
    expect(screen.getByRole('button', { name: 'mobile.logbook.row.editAction:fr' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'mobile.logbook.row.deleteAction:fr' })).toBeTruthy();
  });
});

describe('LogbookRow — grade column', () => {
  it('shows the consensus as the big grade with the people marker (no sub-line) for an ungraded tick', () => {
    const { container, getByText } = renderRow(ascent({ consensusDifficulty: 9, consensusDifficultyName: 'V9' }));

    getByText('V9');
    const icons = iconNames(container);
    // One people glyph: the consensus-sourced marker beside the big grade.
    expect(icons.filter((name) => name === 'people')).toHaveLength(1);
    // The crowd can't disagree with a grade that was never logged.
    expect(icons).not.toContain('chevron.up');
    expect(icons).not.toContain('chevron.down');
  });

  it("formats the grade on the ascent's own board, not the board in scope", () => {
    const { getByText } = renderRow(ascent({ boardType: 'moonboard', difficulty: 16, difficultyName: '6a/V2' }));
    getByText('V16 (moonboard)');
  });

  it('renders the consensus sub-line with a down arrow when you graded softer than the crowd', () => {
    const { container, getByText } = renderRow(
      ascent({ difficulty: 8, difficultyName: 'V8', consensusDifficulty: 9, consensusDifficultyName: 'V9' }),
    );

    // Your grade big, the crowd's as the secondary.
    getByText('V8');
    getByText('V9');
    const icons = iconNames(container);
    expect(icons.filter((name) => name === 'people')).toHaveLength(1);
    // logged 8 < consensus 9 → you found it softer → arrow points down.
    expect(icons).toContain('chevron.down');
    expect(icons).not.toContain('chevron.up');
  });

  it('shows no sub-line and no people marker when the logged grade matches the consensus', () => {
    const { container, getByText } = renderRow(
      ascent({ difficulty: 9, difficultyName: 'V9', consensusDifficulty: 9, consensusDifficultyName: 'V9' }),
    );

    getByText('V9');
    const icons = iconNames(container);
    expect(icons).not.toContain('people');
    expect(icons).not.toContain('chevron.up');
    expect(icons).not.toContain('chevron.down');
  });
});

describe('LogbookRow — Boardsesh grade fallback', () => {
  it('keeps the climber’s own grade big and shows the Boardsesh grade as the crowd secondary when active', () => {
    boardsesh.active = true;
    // User graded V18; Boardsesh grade (trusted) is V22 and no legacy consensus.
    const { container, getByText } = renderRow(
      ascent({ difficulty: 18, difficultyName: '18', boardseshDifficulty: 22, boardseshConfidence: 'confirmed' }),
    );

    // The logger's own grade always wins as the big grade.
    getByText('V18');
    // Boardsesh grade fills the crowd side as the small secondary.
    getByText('V22');
    const icons = iconNames(container);
    expect(icons.filter((name) => name === 'people')).toHaveLength(1);
    // 18 < 22 → you found it softer than the Boardsesh grade → arrow down.
    expect(icons).toContain('chevron.down');
    expect(icons).not.toContain('chevron.up');
  });

  it('shows the Boardsesh grade as the big grade (with the people marker) for an ungraded tick when active', () => {
    boardsesh.active = true;
    const { container, getByText, queryByText } = renderRow(
      ascent({
        consensusDifficulty: 25,
        consensusDifficultyName: '25',
        boardseshDifficulty: 20,
        boardseshConfidence: 'confirmed',
      }),
    );

    // Boardsesh grade replaces the legacy consensus as the crowd grade shown.
    getByText('V20');
    expect(queryByText('V25')).toBeNull();
    const icons = iconNames(container);
    expect(icons.filter((name) => name === 'people')).toHaveLength(1);
    expect(icons).not.toContain('chevron.up');
    expect(icons).not.toContain('chevron.down');
  });

  it('shows the legacy consensus for an ungraded tick when the toggle is off', () => {
    boardsesh.active = false;
    const { getByText, queryByText } = renderRow(
      ascent({
        consensusDifficulty: 25,
        consensusDifficultyName: '25',
        boardseshDifficulty: 20,
        boardseshConfidence: 'confirmed',
      }),
    );

    getByText('V25');
    expect(queryByText('V20')).toBeNull();
  });

  it('never uses a setter_only Boardsesh grade — falls back to the consensus even when active', () => {
    boardsesh.active = true;
    const { getByText, queryByText } = renderRow(
      ascent({
        consensusDifficulty: 25,
        consensusDifficultyName: '25',
        boardseshDifficulty: 20,
        boardseshConfidence: 'setter_only',
      }),
    );

    getByText('V25');
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

  it('keeps canonical board identity alongside a named wall', () => {
    const { container: named } = renderRow(ascent({ boardDisplayName: 'My Garage Board' }));
    expect(named.textContent).toContain('My Garage Board');
    expect(named.textContent).toContain('Kilter Original · 40°');

    const { container: unnamed } = renderRow(ascent({ boardDisplayName: null }));
    expect(unnamed.textContent).toContain('Kilter Original · 40°');
  });

  it('retains board and angle when a day header covers the named wall, including large type', () => {
    const { container } = renderRow(ascent({ boardDisplayName: 'My Garage Board' }), {
      showBoardInMeta: false,
      fontScale: 1.5,
    });
    expect(container.textContent).toContain('Kilter Original · 40°');
    expect(container.textContent).not.toContain('My Garage Board');
    expect(a11y.props?.accessibilityLabel).toContain('My Garage Board');
    expect(a11y.props?.accessibilityLabel).toContain('Kilter Original · 40°');
    expect(a11y.props?.testID).toBe('logbook-entry-tick-1');
  });

  it('shows a readable note preview and includes the note in the accessible entry', () => {
    const { container } = renderRow(ascent({ comment: '  Keep the heel\non.  ' }));
    expect(container.textContent).toContain('Keep the heel on.');
    expect(a11y.props?.accessibilityLabel).toContain('Keep the heel on.');
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

    tracker.start?.();
    tracker.end?.({ translationX: -90 });
    expect(onDeleteRequest).not.toHaveBeenCalled();
    tracker.start?.();
    tracker.end?.({ translationX: -210 });
    expect(onDeleteRequest).toHaveBeenCalledWith(item, 'swipe');
    expect(onEdit).not.toHaveBeenCalled();
    tracker.start?.();
    tracker.end?.({ translationX: 210 });
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

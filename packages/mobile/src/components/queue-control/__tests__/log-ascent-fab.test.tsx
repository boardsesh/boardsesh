// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/queue';
import type { LogbookEntry } from '@boardsesh/board-react';
import type { LogAscentInput, BoardConfig } from '../../../providers/drawer-host-provider';

// --- hoisted spies / mutable provider state -----------------------------------
const drawer = vi.hoisted(() => ({
  openLogAscent: vi.fn(),
  boardConfig: null as BoardConfig | null,
}));
const queue = vi.hoisted(() => ({ sessionId: null as string | null }));
const boardProvider = vi.hoisted(() => ({
  value: null as { logbook: LogbookEntry[]; getLogbook: (uuids: string[]) => Promise<void> } | null,
}));

// reanimated: Animated.View → div, the pop spring hooks are inert.
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withSequence: (...args: number[]) => args[args.length - 1],
  withSpring: (value: number) => value,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@boardsesh/board-react', () => ({ useOptionalBoardProvider: () => boardProvider.value }));

// GlassIconButton → button exposing the wiring + the colour signals under test.
type GlassIconButtonMockProps = {
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  iconName?: string;
  iconColor?: string;
  tintColor?: string;
  fallbackColor?: string;
};
vi.mock('../../GlassIconButton', () => ({
  GlassIconButton: ({
    onPress,
    disabled,
    accessibilityLabel,
    iconName,
    iconColor,
    tintColor,
    fallbackColor,
  }: GlassIconButtonMockProps) =>
    createElement('button', {
      onClick: onPress,
      disabled,
      'data-fab': iconName,
      'data-label': accessibilityLabel,
      'data-icon-color': iconColor ?? '',
      'data-tint': tintColor ?? '',
      'data-fallback': fallbackColor ?? '',
    }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#111111', fill: '#EEEEEE' },
    brandColors: { success: '#34C759' },
  }),
}));

vi.mock('../../../providers/queue-provider', () => ({ useQueueSessionId: () => ({ sessionId: queue.sessionId }) }));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openLogAscent: drawer.openLogAscent, boardConfig: drawer.boardConfig }),
}));

vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));

vi.mock('../../../theme/animations', () => ({ springs: { bouncy: {}, snappy: {} } }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../theme/layout', () => ({ glassSize: { hero: 64, standard: 56 } }));

// NB: ../../lib/ascent-status-utils is intentionally NOT mocked — the real,
// pure countSentAscents drives the logged/green state from the logbook fixture.

import { LogAscentFab } from '../LogAscentFab';

function makeClimb(over: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-123',
    setter_username: 'someone',
    name: 'Test Problem',
    frames: '',
    angle: 40,
    ascensionist_count: 5,
    difficulty: 'V5',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    ...over,
  };
}

function makeBoardConfig(over: Partial<BoardConfig> = {}): BoardConfig {
  return { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40, ...over };
}

function makeSendEntry(over: Partial<LogbookEntry> = {}): LogbookEntry {
  return {
    uuid: 'tick-1',
    climb_uuid: 'climb-123',
    angle: 40,
    is_mirror: false,
    tries: 2,
    quality: 3,
    difficulty: 22,
    comment: '',
    climbed_at: '2025-01-01T00:00:00Z',
    is_ascent: true,
    status: 'send',
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    ...over,
  };
}

const fab = (root: HTMLElement) => root.querySelector('[data-fab="tick"]') as HTMLButtonElement;

describe('LogAscentFab', () => {
  beforeEach(() => {
    drawer.openLogAscent.mockClear();
    drawer.boardConfig = makeBoardConfig();
    queue.sessionId = 'sess-9';
    boardProvider.value = { logbook: [], getLogbook: vi.fn().mockResolvedValue(undefined) };
  });

  it('renders the tick FAB', () => {
    const { container } = render(<LogAscentFab climb={makeClimb()} />);
    expect(fab(container)).not.toBeNull();
  });

  it('opens the log-ascent sheet with the expected payload when tapped', () => {
    const climb = makeClimb({
      uuid: 'climb-123',
      angle: 40,
      difficulty: 'V5',
      mirrored: true,
      benchmark_difficulty: 'V6',
    });
    drawer.boardConfig = makeBoardConfig({ boardName: 'tension', layoutId: 8, sizeId: 17, setIds: '26,27' });
    queue.sessionId = 'sess-42';

    const { container } = render(<LogAscentFab climb={climb} />);
    fireEvent.click(fab(container));

    expect(drawer.openLogAscent).toHaveBeenCalledTimes(1);
    const payload = drawer.openLogAscent.mock.calls[0][0] as LogAscentInput;
    expect(payload).toMatchObject({
      climbUuid: 'climb-123',
      boardName: 'tension',
      angle: 40,
      isMirror: true,
      isBenchmark: true,
      layoutId: 8,
      sizeId: 17,
      setIds: '26,27',
      sessionId: 'sess-42',
      consensusGradeName: 'V5',
    });
  });

  it('reports isBenchmark:false and isMirror:false for a plain climb', () => {
    const climb = makeClimb({ mirrored: false, benchmark_difficulty: null });
    const { container } = render(<LogAscentFab climb={climb} />);
    fireEvent.click(fab(container));

    const payload = drawer.openLogAscent.mock.calls[0][0] as LogAscentInput;
    expect(payload.isMirror).toBe(false);
    expect(payload.isBenchmark).toBe(false);
  });

  it('is disabled and does not open the sheet when boardConfig is null', () => {
    drawer.boardConfig = null;
    const { container } = render(<LogAscentFab climb={makeClimb()} />);
    const button = fab(container);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(drawer.openLogAscent).not.toHaveBeenCalled();
  });

  it('renders neutral glass + a label glyph when the climb is not logged', () => {
    boardProvider.value = { logbook: [], getLogbook: vi.fn().mockResolvedValue(undefined) };
    const { container } = render(<LogAscentFab climb={makeClimb()} />);
    const button = fab(container);
    // Always neutral glass — no tint, fallback is the system fill — and the glyph
    // is the neutral system label.
    expect(button.getAttribute('data-tint')).toBe('');
    expect(button.getAttribute('data-fallback')).toBe('#EEEEEE');
    expect(button.getAttribute('data-icon-color')).toBe('#111111');
  });

  it('signals a logged climb with a green glyph, keeping the glass neutral', () => {
    // Real countSentAscents counts this send at climb-123 / angle 40 → logged.
    boardProvider.value = {
      logbook: [makeSendEntry({ climb_uuid: 'climb-123', angle: 40 })],
      getLogbook: vi.fn().mockResolvedValue(undefined),
    };
    const { container } = render(<LogAscentFab climb={makeClimb({ uuid: 'climb-123', angle: 40 })} />);
    const button = fab(container);

    // Logged → success-coloured glyph; the glass background stays neutral (no
    // tint, the same fill as the resting state).
    expect(button.getAttribute('data-icon-color')).toBe('#34C759');
    expect(button.getAttribute('data-tint')).toBe('');
    expect(button.getAttribute('data-fallback')).toBe('#EEEEEE');
    // The a11y label gains the "already logged" suffix.
    expect(button.getAttribute('data-label')).toContain('mobile.queue.alreadyLogged');
  });

  it('treats a send at a different angle as not logged (angle is part of the match)', () => {
    boardProvider.value = {
      logbook: [makeSendEntry({ climb_uuid: 'climb-123', angle: 25 })],
      getLogbook: vi.fn().mockResolvedValue(undefined),
    };
    const { container } = render(<LogAscentFab climb={makeClimb({ uuid: 'climb-123', angle: 40 })} />);
    expect(fab(container).getAttribute('data-icon-color')).toBe('#111111');
  });

  it('counts a flash (tries:1 ascent) as logged via the real normalizer', () => {
    boardProvider.value = {
      logbook: [makeSendEntry({ status: undefined, is_ascent: true, tries: 1 })],
      getLogbook: vi.fn().mockResolvedValue(undefined),
    };
    const { container } = render(<LogAscentFab climb={makeClimb({ uuid: 'climb-123', angle: 40 })} />);
    expect(fab(container).getAttribute('data-icon-color')).toBe('#34C759');
  });
});

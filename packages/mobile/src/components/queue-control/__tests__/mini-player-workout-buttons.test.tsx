// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { WorkoutOneTapNotice } from '../../play-drawer/use-workout-one-tap';
import type { WorkoutOutcomeTarget } from '../../play-drawer/workout-outcome';

// The MiniPlayer's Fell / Sent (#6940). The taps are useWorkoutOneTap's (its own
// test); here: what each slot draws and says, and that it hands the hook the
// bar's Log ascent opener and the toast for messages.

const oneTap = vi.hoisted(() => ({
  onFell: vi.fn(),
  onSent: vi.fn(),
  notice: null as WorkoutOneTapNotice | null,
  calls: [] as unknown[][],
}));
const drawer = vi.hoisted(() => ({ openLogAscent: vi.fn() }));

vi.mock('../../play-drawer/use-workout-one-tap', () => ({
  useWorkoutOneTap: (...args: unknown[]) => {
    oneTap.calls.push(args);
    return { onFell: oneTap.onFell, onSent: oneTap.onSent, notice: oneTap.notice, dismissNotice: vi.fn() };
  },
}));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => drawer }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#111111' },
    brandColors: { primary: '#6D28D9', success: '#16A34A' },
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => (options?.name ? `${key}:${options.name}` : key),
  }),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-icon-color': color ?? '' }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityHint,
    testID,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityHint: string;
    testID: string;
  }) =>
    createElement(
      'button',
      { onClick: onPress, 'aria-label': accessibilityLabel, 'data-hint': accessibilityHint, 'data-testid': testID },
      children,
    ),
}));
vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

const { MiniPlayerWorkoutButtons } = await import('../MiniPlayerWorkoutButtons');

const TARGET: WorkoutOutcomeTarget = {
  climb: {
    uuid: 'climb-1',
    name: 'Crimp line',
    benchmark_difficulty: null,
    ascensionist_count: 0,
    difficulty: 'V5',
  } as unknown as Climb,
  queueItemUuid: 'item-1',
  sessionId: 'session-1',
  boardName: 'spray',
  layoutId: 7,
  sizeId: 1,
  setIds: '1',
  angle: 40,
  isMirror: true,
};

function renderButtons(buttonIds: readonly ('fell' | 'sent')[], wallLeftAtMs: number | null = null) {
  return render(
    createElement(MiniPlayerWorkoutButtons, {
      buttonIds,
      shown: { target: TARGET, wallLeftAtMs },
      slotWidth: 44,
      rowHeight: 48,
    }),
  );
}

beforeEach(() => {
  oneTap.onFell.mockClear();
  oneTap.onSent.mockClear();
  oneTap.notice = null;
  oneTap.calls = [];
  drawer.openLogAscent.mockClear();
});

describe('MiniPlayerWorkoutButtons', () => {
  it('draws Fell then Sent, each in its own keyed slot, and logs through the one-tap hook', () => {
    const { getByTestId, container } = renderButtons(['fell', 'sent']);
    const slots = [...container.querySelectorAll('[data-testid^="mini-player-slot-"]')].map((slot) =>
      slot.getAttribute('data-testid'),
    );
    expect(slots).toEqual(['mini-player-slot-fell', 'mini-player-slot-sent']);
    fireEvent.click(getByTestId('mini-player-workout-fell'));
    fireEvent.click(getByTestId('mini-player-workout-sent'));
    expect(oneTap.onFell).toHaveBeenCalledTimes(1);
    expect(oneTap.onSent).toHaveBeenCalledTimes(1);
    expect(oneTap.calls[0]?.[3]).toEqual({ messages: 'toast' });
  });

  it("speaks the player's labels and hints", () => {
    const { getByTestId } = renderButtons(['fell', 'sent']);
    expect(getByTestId('mini-player-workout-fell').getAttribute('aria-label')).toBe('playView.workoutOutcome.fell');
    expect(getByTestId('mini-player-workout-fell').getAttribute('data-hint')).toBe('playView.workoutOutcome.fellHint');
    expect(getByTestId('mini-player-workout-sent').getAttribute('aria-label')).toBe('playView.workoutOutcome.sent');
  });

  it('names the climb the wall left while the bar holds it', () => {
    const { getByTestId } = renderButtons(['fell', 'sent'], 1_760_000_000_000);
    expect(getByTestId('mini-player-workout-sent').getAttribute('data-hint')).toBe(
      'playView.workoutOutcome.sentHintPrevious:Crimp line',
    );
    expect(oneTap.calls[0]?.[2]).toBe(1_760_000_000_000);
  });

  it('shows a check on the button whose go saved, and keeps its label', () => {
    oneTap.notice = { kind: 'saved', status: 'attempt', queueItemUuid: 'item-1', message: 'Try logged' };
    const fell = renderButtons(['fell', 'sent']);
    const icons = [...fell.container.querySelectorAll('[data-icon]')].map((icon) => icon.getAttribute('data-icon'));
    expect(icons).toEqual(['checkmark.circle.fill', 'tick']);
    expect(fell.getByTestId('mini-player-workout-fell').getAttribute('aria-label')).toBe(
      'playView.workoutOutcome.fell',
    );
    fell.unmount();

    oneTap.notice = { kind: 'saved', status: 'flash', queueItemUuid: 'item-1', message: 'Flash logged' };
    const sent = renderButtons(['sent']);
    expect(sent.container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('checkmark.circle.fill');
  });

  it("opens the bar's Log ascent on the climb the taps log, for a first ascent that needs a grade", () => {
    renderButtons(['sent']);
    const openLogSheet = oneTap.calls[0]?.[1] as () => void;
    openLogSheet();
    expect(drawer.openLogAscent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        climbUuid: 'climb-1',
        boardName: 'spray',
        layoutId: 7,
        angle: 40,
        isMirror: true,
        sessionId: 'session-1',
        baseAscensionistCount: 0,
        consensusGradeName: 'V5',
      }),
    );
  });
});

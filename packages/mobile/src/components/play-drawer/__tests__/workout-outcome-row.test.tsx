// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

// What the climber sees and a screen reader hears. The taps themselves are
// use-workout-one-tap.test.tsx's.

type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: string;
};
vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    testID,
    accessibilityLabel,
    accessibilityHint,
    accessibilityRole,
  }: PressMockProps) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'data-testid': testID,
        'data-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        'data-role': accessibilityRole,
      },
      children,
    ),
}));
vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({ children, title }: { children?: ReactNode; title: string }) =>
    createElement('span', { 'data-large-content': title }, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, maxFontSizeMultiplier }: { children?: ReactNode; maxFontSizeMultiplier?: number }) =>
    createElement('span', { 'data-max-font-scale': maxFontSizeMultiplier }, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primaryFill: 'primaryFill', onPrimary: 'onPrimary', error: 'error', primary: 'primary' },
    systemColors: { fill: 'fill', label: 'label' },
    radii: { button: 22 },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ androidRipple: () => undefined, spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));
vi.mock('../../../theme/layout', () => ({ glassSize: { inline: 44 } }));

const oneTap = vi.hoisted(() => ({
  onFell: vi.fn(),
  onSent: vi.fn(),
  dismissNotice: vi.fn(),
  notice: null as WorkoutOneTapNotice | null,
  calls: [] as unknown[][],
}));
vi.mock('../use-workout-one-tap', () => ({
  useWorkoutOneTap: (...args: unknown[]) => {
    oneTap.calls.push(args);
    return {
      onFell: oneTap.onFell,
      onSent: oneTap.onSent,
      notice: oneTap.notice,
      dismissNotice: oneTap.dismissNotice,
    };
  },
}));

import { WorkoutOutcomeRow } from '../WorkoutOutcomeRow';
import type { WorkoutOneTapNotice } from '../use-workout-one-tap';

const TARGET = {
  climb: { uuid: 'climb-1' } as unknown as Climb,
  queueItemUuid: 'item-1',
  sessionId: 'session-1',
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
  isMirror: false,
};

beforeEach(() => {
  oneTap.notice = null;
  oneTap.dismissNotice.mockClear();
});

describe('WorkoutOutcomeRow', () => {
  it('draws Fell then Sent, each a labelled button with a hint', () => {
    const { getByTestId } = render(createElement(WorkoutOutcomeRow, { target: TARGET, onOpenLogSheet: vi.fn() }));

    const fell = getByTestId('workout-outcome-fell');
    const sent = getByTestId('workout-outcome-sent');
    expect(fell.compareDocumentPosition(sent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fell.getAttribute('data-role')).toBe('button');
    expect(fell.getAttribute('data-label')).toBe('playView.workoutOutcome.fell');
    expect(fell.getAttribute('data-hint')).toBe('playView.workoutOutcome.fellHint');
    expect(sent.getAttribute('data-role')).toBe('button');
    expect(sent.getAttribute('data-label')).toBe('playView.workoutOutcome.sent');
    expect(sent.getAttribute('data-hint')).toBe('playView.workoutOutcome.sentHint');
  });

  it('caps the labels like the rest of the row and offers them in the Large Content Viewer', () => {
    const { container } = render(createElement(WorkoutOutcomeRow, { target: TARGET, onOpenLogSheet: vi.fn() }));

    const scales = [...container.querySelectorAll('[data-max-font-scale]')].map((node) =>
      node.getAttribute('data-max-font-scale'),
    );
    expect(scales).toEqual(['1.2', '1.2']);
    const viewerTitles = [...container.querySelectorAll('[data-large-content]')].map((node) =>
      node.getAttribute('data-large-content'),
    );
    expect(viewerTitles).toEqual(['playView.workoutOutcome.fell', 'playView.workoutOutcome.sent']);
  });

  it('runs Fell and Sent, for the climb it was handed, with the sheet opener', () => {
    oneTap.calls.length = 0;
    const onOpenLogSheet = vi.fn();
    const { getByTestId } = render(createElement(WorkoutOutcomeRow, { target: TARGET, onOpenLogSheet }));

    fireEvent.click(getByTestId('workout-outcome-fell'));
    fireEvent.click(getByTestId('workout-outcome-sent'));

    expect(oneTap.onFell).toHaveBeenCalledTimes(1);
    expect(oneTap.onSent).toHaveBeenCalledTimes(1);
    expect(oneTap.calls.at(-1)).toEqual([TARGET, onOpenLogSheet, null]);
  });
});

// Held for the climb the wall just left (`useWorkoutOutcomeHold`): the board
// already shows the next climb, so the row says which climb its buttons log.
describe('WorkoutOutcomeRow: held for the climb the wall left', () => {
  const WALL_LEFT_AT_MS = 1_760_000_000_000;

  function renderHeldRow() {
    return render(
      createElement(WorkoutOutcomeRow, { target: TARGET, wallLeftAtMs: WALL_LEFT_AT_MS, onOpenLogSheet: vi.fn() }),
    );
  }

  it('hands the hook when the wall left, so a tap logs there and only within the grace', () => {
    oneTap.calls.length = 0;
    const onOpenLogSheet = vi.fn();
    render(createElement(WorkoutOutcomeRow, { target: TARGET, wallLeftAtMs: WALL_LEFT_AT_MS, onOpenLogSheet }));

    expect(oneTap.calls.at(-1)).toEqual([TARGET, onOpenLogSheet, WALL_LEFT_AT_MS]);
  });

  it('keeps Fell and Sent as live buttons, with hints that name the previous climb', () => {
    const { getByTestId } = renderHeldRow();

    const fell = getByTestId('workout-outcome-fell');
    const sent = getByTestId('workout-outcome-sent');
    expect(fell.getAttribute('data-label')).toBe('playView.workoutOutcome.fell');
    expect(fell.getAttribute('data-hint')).toBe('playView.workoutOutcome.fellHintPrevious');
    expect(sent.getAttribute('data-label')).toBe('playView.workoutOutcome.sent');
    expect(sent.getAttribute('data-hint')).toBe('playView.workoutOutcome.sentHintPrevious');

    fireEvent.click(fell);
    expect(oneTap.onFell).toHaveBeenCalled();
  });

  it('names the climb on a saved go, since it is not the one on screen', () => {
    oneTap.notice = {
      kind: 'saved',
      status: 'attempt',
      queueItemUuid: 'item-1',
      message: 'Try logged · Crimp line',
    };
    const { getByTestId } = renderHeldRow();

    expect(getByTestId('workout-outcome-fell').textContent).toBe('Try logged · Crimp line');
  });
});

// The player is a native modal on iOS and root toasts draw behind it, so the
// row is where a tap's outcome shows.
describe('WorkoutOutcomeRow: what a tap did', () => {
  function renderRow() {
    return render(createElement(WorkoutOutcomeRow, { target: TARGET, onOpenLogSheet: vi.fn() }));
  }

  it('says a try saved on Fell, and leaves Sent as it was', () => {
    oneTap.notice = {
      kind: 'saved',
      status: 'attempt',
      queueItemUuid: 'item-1',
      message: 'Try logged · Crimp line',
    };
    const { getByTestId } = renderRow();

    const fell = getByTestId('workout-outcome-fell');
    const sent = getByTestId('workout-outcome-sent');
    expect(fell.textContent).toBe('playView.workoutOutcome.attemptLoggedLabel');
    expect(fell.querySelector('[data-icon="success"]')).toBeTruthy();
    expect(fell.querySelector('[data-large-content]')?.getAttribute('data-large-content')).toBe(
      'playView.workoutOutcome.attemptLoggedLabel',
    );
    // Still the button it was, for a screen reader and for the next go.
    expect(fell.getAttribute('data-label')).toBe('playView.workoutOutcome.fell');
    expect(sent.textContent).toBe('playView.workoutOutcome.sent');
    expect(sent.querySelector('[data-icon]')).toBeNull();
  });

  it.each([
    ['flash', 'playView.workoutOutcome.flashLoggedLabel'],
    ['send', 'playView.workoutOutcome.sendLoggedLabel'],
  ] as const)('says a %s saved on Sent', (status, label) => {
    oneTap.notice = { kind: 'saved', status, queueItemUuid: 'item-1', message: 'named' };
    const { getByTestId } = renderRow();

    expect(getByTestId('workout-outcome-sent').textContent).toBe(label);
    expect(getByTestId('workout-outcome-fell').textContent).toBe('playView.workoutOutcome.fell');
  });

  it('names the climb when the go was for the one the wall just left', () => {
    oneTap.notice = {
      kind: 'saved',
      status: 'flash',
      queueItemUuid: 'item-0',
      message: 'Flash logged · Crimp line',
    };
    const { getByTestId } = renderRow();

    expect(getByTestId('workout-outcome-sent').textContent).toBe('Flash logged · Crimp line');
  });

  it('gives a failure the whole row, and a tap on it brings the buttons back', () => {
    oneTap.notice = { kind: 'message', tone: 'error', message: 'Could not save your ascent.' };
    const { getByTestId, queryByTestId } = renderRow();

    const message = getByTestId('workout-outcome-message');
    expect(message.textContent).toBe('Could not save your ascent.');
    expect(message.getAttribute('data-label')).toBe('Could not save your ascent.');
    expect(message.getAttribute('data-hint')).toBe('playView.workoutOutcome.messageHint');
    expect(message.querySelector('[data-icon="error"]')?.getAttribute('data-color')).toBe('error');
    expect(queryByTestId('workout-outcome-fell')).toBeNull();
    expect(queryByTestId('workout-outcome-sent')).toBeNull();

    fireEvent.click(message);
    expect(oneTap.dismissNotice).toHaveBeenCalledTimes(1);
  });

  it('shows where to log a first ascent the same way, as information', () => {
    oneTap.notice = { kind: 'message', tone: 'info', message: 'Swipe back to Crimp line.' };
    const { getByTestId } = renderRow();

    const message = getByTestId('workout-outcome-message');
    expect(message.textContent).toBe('Swipe back to Crimp line.');
    expect(message.querySelector('[data-icon="info"]')?.getAttribute('data-color')).toBe('primary');
  });
});

// @vitest-environment jsdom
//
// What the rest timer says in a crew (#5382): who paces the wall, that the
// sheet's changes go to everyone, and that auto-advance becomes the crew's
// setting rather than one a passenger cannot touch. The store is REAL: a crew
// clock is adopted the way the session's event would adopt it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type SegmentedProps = {
  options: { key: string; label: string }[];
  selectedKey: string;
  onSelect: (key: string) => void;
  accessibilityLabel?: string;
};

type SwitchProps = {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
};

type ButtonProps = {
  title: string;
  onPress: () => void;
  icon?: string;
  disabled?: boolean;
  variant?: string;
};

type ViewProps = {
  children?: ReactNode;
  testID?: string;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  accessibilityValue?: { text?: string; min?: number; max?: number; now?: number };
  accessibilityActions?: readonly { name: string }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
};

type PressableProps = {
  children?: ReactNode;
  testID?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: { expanded?: boolean };
};

const harness = vi.hoisted(() => ({
  nowMs: 0,
  sessionId: 'session-1' as string | null,
  isCrewSession: true,
  inAppBoardConnection: 'heldByPeer',
  holderDisplayName: 'Sam' as string | null,
  fontScale: 1,
}));

const settingsStore = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
}));

vi.mock('react-native', () => ({
  // The slider's adjustable node is a View, and its increment / decrement
  // actions are the only way a VoiceOver user — or a test, which has no thumb
  // either — moves it. A click stands in for increment, a right-click for
  // decrement.
  View: ({
    children,
    testID,
    accessibilityRole,
    accessibilityLabel,
    accessibilityValue,
    accessibilityActions,
    onAccessibilityAction,
  }: ViewProps) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'data-a11y-role': accessibilityRole,
        'data-a11y-label': accessibilityLabel,
        'data-a11y-value': accessibilityValue?.text,
        'data-a11y-min': accessibilityValue?.min,
        'data-a11y-max': accessibilityValue?.max,
        'data-a11y-actions': accessibilityActions?.map((action) => action.name).join(','),
        onClick: onAccessibilityAction
          ? () => onAccessibilityAction({ nativeEvent: { actionName: 'increment' } })
          : undefined,
        onContextMenu: onAccessibilityAction
          ? () => onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } })
          : undefined,
      },
      children,
    ),
  Pressable: ({
    children,
    testID,
    onPress,
    onLongPress,
    delayLongPress,
    accessibilityLabel,
    accessibilityHint,
    accessibilityState,
  }: PressableProps) =>
    createElement(
      'button',
      {
        'data-testid': testID,
        'data-a11y-label': accessibilityLabel,
        'data-a11y-hint': accessibilityHint,
        'data-expanded': accessibilityState?.expanded == null ? undefined : String(accessibilityState.expanded),
        'data-delay-long-press': delayLongPress,
        onClick: onPress,
        // jsdom has no long press; a right-click stands in for one.
        onContextMenu: onLongPress,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: harness.fontScale }),
}));

vi.mock('react-native-reanimated', () => {
  const AnimatedView = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const fade = { duration: () => ({}) };
  return {
    default: {
      View: AnimatedView,
      // The press-scale and thumb-grow springs these drive are UI-thread
      // decoration; what matters here is that the control renders and commits.
      createAnimatedComponent: <P,>(Component: (props: P) => ReactNode) => Component,
    },
    FadeIn: fade,
    FadeOut: fade,
    useAnimatedStyle: () => ({}),
    useSharedValue: (initial: number) => ({ value: initial, get: () => initial, set: () => {} }),
    withSpring: (value: number) => value,
    runOnJS: <A extends unknown[]>(fn: (...args: A) => void) => fn,
  };
});

vi.mock('react-native-gesture-handler', () => {
  const chainable: Record<string, () => unknown> = {};
  const gesture = new Proxy(chainable, { get: () => () => gesture });
  return {
    Gesture: { Pan: () => gesture, Tap: () => gesture, Race: () => gesture },
    GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  };
});

vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join(',')}` : key),
  }),
}));

vi.mock('../../../settings', async () => {
  const { useReducer, useEffect } = await import('react');
  return {
    useSetting: (key: string) => {
      const [, forceRender] = useReducer((count: number) => count + 1, 0);
      useEffect(() => {
        settingsStore.listeners.add(forceRender);
        return () => {
          settingsStore.listeners.delete(forceRender);
        };
      }, []);
      const write = (next: unknown) => {
        settingsStore.values[key] = next;
        for (const listener of settingsStore.listeners) listener();
      };
      return [settingsStore.values[key], write];
    },
    getSetting: (key: string) => settingsStore.values[key],
    setSetting: (key: string, next: unknown) => {
      settingsStore.values[key] = next;
      for (const listener of settingsStore.listeners) listener();
    },
  };
});

vi.mock('../../../lib/clock', () => ({ nowMs: () => harness.nowMs }));
// Native capability is covered by rest-timer-sheet; these suites exercise crew/workout UI.
vi.mock('../../../lib/live-activity/live-activity-plugin', () => ({ sessionPresenceSupportsRestTimer: true }));
vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn(), hapticSelection: vi.fn(), hapticLight: vi.fn() }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: '#111111',
      secondaryLabel: '#666666',
      tertiaryLabel: '#AAAAAA',
      separator: '#DDDDDD',
      fill: '#78788033',
    },
    brandColors: { error: '#C81E1E', primary: '#7C3AED' },
  }),
}));
vi.mock('../../../theme/colors', () => ({ brandColors: { primary: '#6D28D9' } }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#FFFFFF' } }));
vi.mock('../../../theme/animations', () => ({ springs: { snappy: {} }, timing: { instant: 50, fast: 150 } }));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: harness.sessionId }),
  useIsCrewSession: () => harness.isCrewSession,
}));
vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({
    inAppBoardConnection: harness.inAppBoardConnection,
    localConnected: false,
    holderDisplayName: harness.holderDisplayName,
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { full: 9999 },
}));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2, REST_CLOCK_MAX_FONT_SCALE: 1.3 }));

vi.mock('../RestTimerPill', () => ({
  RestTimerHeroClock: () => createElement('span', { 'data-testid': 'sheet-hero-clock' }),
}));

vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({
    children,
    visible,
    scrollable,
    snapPoints,
    enableDynamicSizing = false,
  }: {
    children?: ReactNode;
    visible: boolean;
    scrollable?: boolean;
    snapPoints?: (string | number)[];
    enableDynamicSizing?: boolean;
  }) =>
    visible
      ? createElement(
          'div',
          {
            'data-testid': 'sheet',
            'data-scrollable': scrollable,
            'data-snap-points': snapPoints?.join(','),
            'data-dynamic-sizing': enableDynamicSizing,
          },
          children,
        )
      : null,
}));

vi.mock('../../Text', () => ({
  Text: ({
    children,
    testID,
    maxFontSizeMultiplier,
    numberOfLines,
  }: {
    children?: ReactNode;
    testID?: string;
    maxFontSizeMultiplier?: number;
    numberOfLines?: number;
  }) =>
    createElement(
      'span',
      {
        'data-testid': testID,
        'data-max-scale': maxFontSizeMultiplier,
        'data-lines': numberOfLines,
      },
      children,
    ),
}));

vi.mock('../../Button', () => ({
  Button: ({ title, onPress, icon, disabled, variant }: ButtonProps) =>
    createElement(
      'button',
      {
        'data-button': title,
        'data-icon': icon ?? '',
        'data-variant': variant ?? '',
        'data-disabled': String(Boolean(disabled)),
        onClick: () => {
          if (!disabled) onPress();
        },
      },
      title,
    ),
}));

vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({ label, description, value, onValueChange, disabled }: SwitchProps) =>
    createElement('button', {
      'data-switch': label,
      'data-value': String(value),
      'data-disabled': String(Boolean(disabled)),
      'data-description': description ?? '',
      onClick: () => {
        if (!disabled) onValueChange(!value);
      },
    }),
}));

vi.mock('../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', { 'data-section': title }, title),
}));

vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({ options, selectedKey, onSelect, accessibilityLabel }: SegmentedProps) =>
    createElement(
      'div',
      { 'data-segmented': accessibilityLabel ?? '' },
      options.map((option) =>
        createElement(
          'button',
          {
            key: option.key,
            'data-segment': `${accessibilityLabel}:${option.key}`,
            'data-selected': String(option.key === selectedKey),
            onClick: () => onSelect(option.key),
          },
          option.label,
        ),
      ),
    ),
}));

vi.mock('../../navigation/ScrollableTabs', () => ({
  ScrollableTabs: ({ options, selectedKey, onSelect, accessibilityLabel }: SegmentedProps) =>
    createElement(
      'div',
      { 'data-scrolling-tabs': accessibilityLabel },
      options.map((option) =>
        createElement(
          'button',
          {
            key: option.key,
            'data-tab': option.key,
            'aria-selected': option.key === selectedKey,
            onClick: () => onSelect(option.key),
          },
          option.label,
        ),
      ),
    ),
}));

vi.mock('../../tick/TickDestructiveRow', () => ({
  TickDestructiveRow: ({ label, icon, onPress }: { label: string; icon?: string; onPress: () => void }) =>
    createElement('button', { 'data-destructive': label, 'data-icon': icon ?? 'delete', onClick: onPress }, label),
}));

import { handleCrewCadenceChange, resetCrewCadenceForTests } from '../../../lib/crew-rest-cadence';
import type { SessionRestCadenceWire } from '../../../lib/graphql/operations';
import {
  applyRestTimerStagePacing,
  armRestTimer,
  getRestTimerState,
  resetRestTimerStoreForTests,
  subscribeLocalRestTimerActions,
} from '../../../lib/rest-timer-store';
import { resetServerClock } from '../../../lib/server-clock';
import { RestTimerSheet } from '../RestTimerSheet';
import { RestTimerPacerCaption, restTimerPacerCaption } from '../RestTimerPacerCaption';
import { RestTimerCrewNote } from '../RestTimerCrewNote';

const NOW_MS = Date.parse('2026-10-24T10:00:00.000Z');
const AUTO_ADVANCE_ROW = '[data-switch="mobile.restTimer.autoAdvance"]';

function followCrewClock(clock: Partial<SessionRestCadenceWire> = {}) {
  handleCrewCadenceChange(
    {
      restCadence: {
        mode: 'onTheMinute',
        targetSeconds: 120,
        autoAdvance: true,
        advanceOn: 'deadline',
        source: 'settings',
        isRunning: true,
        anchorAt: String(NOW_MS),
        pausedElapsedSeconds: 0,
        setByParticipantId: 'participant-sam',
        ...clock,
      },
      revision: 4,
      serverNow: String(NOW_MS),
      isSnapshot: true,
      action: null,
    },
    { sessionId: 'session-1', ownParticipantId: 'participant-me', receivedAtMs: NOW_MS },
  );
}

function autoAdvanceRow(container: HTMLElement) {
  const row = container.querySelector(AUTO_ADVANCE_ROW) as HTMLElement;
  return { description: row.getAttribute('data-description'), disabled: row.getAttribute('data-disabled') };
}

beforeEach(() => {
  harness.nowMs = NOW_MS;
  harness.sessionId = 'session-1';
  harness.isCrewSession = true;
  harness.inAppBoardConnection = 'heldByPeer';
  harness.holderDisplayName = 'Sam';
  settingsStore.values = { restTimerTargetSeconds: 60, restTimerMode: 'afterTick', restTimerAutoAdvance: true };
  settingsStore.listeners.clear();
  resetRestTimerStoreForTests();
  resetCrewCadenceForTests();
  resetServerClock();
});

afterEach(() => {
  cleanup();
});

describe('restTimerPacerCaption', () => {
  const t = ((key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${Object.values(params).join(',')}` : key) as unknown as Parameters<
    typeof restTimerPacerCaption
  >[2];

  it('names who paces the wall, and says nothing alone', () => {
    expect(restTimerPacerCaption('holder', null, t)).toBe('mobile.restTimer.crew.pacedByYou');
    expect(restTimerPacerCaption('passenger', 'Sam', t)).toBe('mobile.restTimer.crew.pacedByName:Sam');
    expect(restTimerPacerCaption('passenger', null, t)).toBe('mobile.restTimer.crew.pacedByCrewmate');
    expect(restTimerPacerCaption('unheld', null, t)).toBe('mobile.restTimer.crew.unheld');
    expect(restTimerPacerCaption('solo', null, t)).toBeNull();
  });
});

describe('RestTimerPacerCaption', () => {
  it('says nothing without a crew clock', () => {
    armRestTimer('afterTick', NOW_MS, 'session-1');
    const { queryByTestId } = render(<RestTimerPacerCaption />);
    expect(queryByTestId('rest-timer-pacer-caption')).toBeNull();
  });

  it.each([
    ['heldByPeer', 'Sam', 'mobile.restTimer.crew.pacedByName:Sam'],
    ['connectedByMe', null, 'mobile.restTimer.crew.pacedByYou'],
    ['disconnected', null, 'mobile.restTimer.crew.unheld'],
  ])('with the board %s, reads %s', (connection, holder, expected) => {
    harness.inAppBoardConnection = connection;
    harness.holderDisplayName = holder;
    followCrewClock();
    const { getByTestId } = render(<RestTimerPacerCaption />);
    expect(getByTestId('rest-timer-pacer-caption').textContent).toBe(expected);
  });

  it('keeps the pill’s line to one, capped at the chrome-label scale', () => {
    followCrewClock();
    const { getByTestId } = render(<RestTimerPacerCaption />);
    const caption = getByTestId('rest-timer-pacer-caption');
    expect(caption.getAttribute('data-max-scale')).toBe('1.2');
    expect(caption.getAttribute('data-lines')).toBe('1');
  });

  it('lets the sheet’s line grow with Dynamic Type and wrap', () => {
    followCrewClock();
    const { getByTestId } = render(<RestTimerPacerCaption variant="subheadline" centered scalesWithText />);
    const caption = getByTestId('rest-timer-pacer-caption');
    expect(caption.hasAttribute('data-max-scale')).toBe(false);
    expect(caption.hasAttribute('data-lines')).toBe(false);
  });

  it('says nothing when the crew clock never moves the wall', () => {
    followCrewClock({ autoAdvance: false });
    const { queryByTestId } = render(<RestTimerPacerCaption />);
    expect(queryByTestId('rest-timer-pacer-caption')).toBeNull();
  });

  it('says nothing for a climber alone in the session', () => {
    harness.isCrewSession = false;
    followCrewClock();
    const { queryByTestId } = render(<RestTimerPacerCaption />);
    expect(queryByTestId('rest-timer-pacer-caption')).toBeNull();
  });
});

describe('RestTimerCrewNote', () => {
  it('tells the sheet its changes go to everyone, only with a crew clock in a crew', () => {
    followCrewClock();
    const { getByTestId } = render(<RestTimerCrewNote placement="sheet" />);
    expect(getByTestId('rest-timer-crew-note').textContent).toBe('mobile.restTimer.crew.sheetNote');
  });

  it('keeps the sheet quiet in a crew with no shared clock', () => {
    armRestTimer('afterTick', NOW_MS, 'session-1');
    const { queryByTestId } = render(<RestTimerCrewNote placement="sheet" />);
    expect(queryByTestId('rest-timer-crew-note')).toBeNull();
  });

  it('tells the arm row the switch is the crew’s', () => {
    const { getByTestId } = render(<RestTimerCrewNote placement="armRow" />);
    expect(getByTestId('rest-timer-crew-note').textContent).toBe('mobile.restTimer.crew.armNote');
  });

  it('says nothing to a climber alone', () => {
    harness.isCrewSession = false;
    followCrewClock();
    const { queryByTestId } = render(<RestTimerCrewNote placement="sheet" />);
    expect(queryByTestId('rest-timer-crew-note')).toBeNull();
  });

  it('asks for an update when the crew clock is something this app cannot run', () => {
    armRestTimer('afterTick', NOW_MS, 'session-1');
    followCrewClock({ mode: 'everyOtherMinute' });
    const { getByTestId } = render(<RestTimerCrewNote placement="sheet" />);
    expect(getByTestId('rest-timer-crew-note').textContent).toBe('mobile.restTimer.crew.unsupported');
  });
});

describe('the sheet’s auto-advance switch in a crew', () => {
  it('is the crew’s setting with a crew clock: a passenger can switch it, and sees whose phone moves the wall', () => {
    followCrewClock();
    const { container, getByTestId } = render(<RestTimerSheet visible onClose={() => {}} />);
    expect(autoAdvanceRow(container)).toEqual({
      description: 'mobile.restTimer.crew.autoAdvanceByName:Sam',
      disabled: 'false',
    });
    expect(getByTestId('rest-timer-crew-note').textContent).toBe('mobile.restTimer.crew.sheetNote');
  });

  it('stays blocked for a passenger with no crew clock', () => {
    armRestTimer('afterTick', NOW_MS, 'session-1');
    const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
    expect(autoAdvanceRow(container)).toEqual({ description: 'mobile.restTimer.autoAdvanceBlocked', disabled: 'true' });
  });

  it('tells the holder its phone moves the wall for everyone', () => {
    harness.inAppBoardConnection = 'connectedByMe';
    followCrewClock();
    const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
    expect(autoAdvanceRow(container).description).toBe('mobile.restTimer.crew.autoAdvanceByYou');
  });

  it('says it waits for a holder when nobody holds the board', () => {
    harness.inAppBoardConnection = 'disconnected';
    followCrewClock();
    const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
    expect(autoAdvanceRow(container)).toEqual({
      description: 'mobile.restTimer.crew.autoAdvanceUnheld',
      disabled: 'false',
    });
  });

  it('needs the crew clock’s rest length, not this climber’s own', () => {
    settingsStore.values.restTimerTargetSeconds = null;
    followCrewClock();
    const { container, unmount } = render(<RestTimerSheet visible onClose={() => {}} />);
    expect(autoAdvanceRow(container)).toEqual({
      description: 'mobile.restTimer.crew.autoAdvanceByName:Sam',
      disabled: 'false',
    });
    unmount();

    settingsStore.values.restTimerTargetSeconds = 60;
    followCrewClock({ targetSeconds: null });
    const offClock = render(<RestTimerSheet visible onClose={() => {}} />);
    expect(autoAdvanceRow(offClock.container)).toEqual({
      description: 'mobile.restTimer.autoAdvanceNeedsLength',
      disabled: 'true',
    });
  });

  it('keeps its own hint for a climber alone', () => {
    harness.isCrewSession = false;
    followCrewClock();
    const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
    expect(autoAdvanceRow(container).description).toBe('mobile.restTimer.autoAdvanceHint');
  });
});

describe('the sheet’s rest controls follow the crew clock', () => {
  // Sam's clock: on the minute, 2:00, moving the wall. This climber's own: after
  // each send, 1:00, auto-advance off.
  beforeEach(() => {
    settingsStore.values = { restTimerTargetSeconds: 60, restTimerMode: 'afterTick', restTimerAutoAdvance: false };
  });

  function controls(container: HTMLElement) {
    const row = container.querySelector(AUTO_ADVANCE_ROW) as HTMLElement;
    return {
      autoAdvance: row.getAttribute('data-value'),
      length: container.querySelector('[data-testid="rest-length-pill"]')?.getAttribute('data-a11y-label'),
      cadence: container
        .querySelector('[data-segmented="mobile.restTimer.modeAria"] [data-selected="true"]')
        ?.getAttribute('data-segment'),
    };
  }

  it('shows the crew’s length, cadence and auto-advance where this climber’s own differ', () => {
    followCrewClock();
    const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
    expect(controls(container)).toEqual({
      autoAdvance: 'true',
      length: 'mobile.restTimer.lengthPillAria:2:00',
      cadence: 'mobile.restTimer.modeAria:onTheMinute',
    });
  });

  it('keeps this climber’s own values with no crew clock', () => {
    armRestTimer('afterTick', NOW_MS, 'session-1');
    harness.inAppBoardConnection = 'connectedByMe';
    const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
    expect(controls(container)).toEqual({
      autoAdvance: 'false',
      length: 'mobile.restTimer.lengthPillAria:1:00',
      cadence: 'mobile.restTimer.modeAria:afterTick',
    });
  });

  it('switching auto-advance hands the crew its own clock with only that changed', () => {
    followCrewClock();
    const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
    fireEvent.click(container.querySelector(AUTO_ADVANCE_ROW) as HTMLElement);
    expect(settingsStore.values).toEqual({
      restTimerTargetSeconds: 120,
      restTimerMode: 'onTheMinute',
      restTimerAutoAdvance: false,
    });
  });

  it('stepping the rest length keeps the crew’s cadence and auto-advance', () => {
    followCrewClock();
    const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
    fireEvent.click(container.querySelector('[data-testid="rest-length-pill"]') as HTMLElement);
    expect(settingsStore.values).toEqual({
      restTimerTargetSeconds: 150,
      restTimerMode: 'onTheMinute',
      restTimerAutoAdvance: true,
    });
  });

  it('changing the cadence keeps the crew’s length and auto-advance', () => {
    followCrewClock();
    const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
    fireEvent.click(container.querySelector('[data-segment="mobile.restTimer.modeAria:afterTick"]') as HTMLElement);
    expect(settingsStore.values).toEqual({
      restTimerTargetSeconds: 120,
      restTimerMode: 'afterTick',
      restTimerAutoAdvance: true,
    });
  });

  it('sends each edit to the crew clock with only that change, keeping its advance rule', () => {
    followCrewClock({ advanceOn: 'tick' });
    const actions: string[] = [];
    const unsubscribe = subscribeLocalRestTimerActions((action) => actions.push(action.type));
    const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
    fireEvent.click(container.querySelector('[data-segment="mobile.restTimer.modeAria:afterTick"]') as HTMLElement);
    unsubscribe();
    expect(actions).toEqual(['crewPacingEdited']);
    expect(getRestTimerState().crewPacingDraft).toMatchObject({
      mode: 'afterTick',
      targetSeconds: 120,
      autoAdvance: true,
      advanceOn: 'tick',
      source: 'settings',
    });
    // The timer runs on the crew's clock until the server answers.
    expect(getRestTimerState().crew?.config?.mode).toBe('onTheMinute');
  });

  it('steps on from the first tap with a second before the server answers', () => {
    followCrewClock();
    const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
    const lengthPill = () => container.querySelector('[data-testid="rest-length-pill"]') as HTMLElement;
    fireEvent.click(lengthPill());
    fireEvent.click(lengthPill());
    expect(controls(container).length).toBe('mobile.restTimer.lengthPillAria:3:00');
    expect(getRestTimerState().crewPacingDraft?.targetSeconds).toBe(180);
    expect(settingsStore.values.restTimerTargetSeconds).toBe(180);
  });

  it('sends nothing to the crew from a tap that changes nothing', () => {
    followCrewClock();
    const actions: string[] = [];
    const unsubscribe = subscribeLocalRestTimerActions((action) => actions.push(action.type));
    const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
    fireEvent.click(container.querySelector('[data-segment="mobile.restTimer.modeAria:onTheMinute"]') as HTMLElement);
    unsubscribe();
    expect(actions).toEqual([]);
    expect(getRestTimerState().crewPacingDraft).toBeNull();
  });

  describe('with a workout stage on this phone', () => {
    const stage = {
      sessionId: 'session-1',
      stageId: 'stage-1',
      kind: 'limitBouldering' as const,
      queueItemUuid: 'item-1',
      mode: 'afterTick' as const,
      targetSeconds: 180,
      advanceOn: 'send' as const,
      closesRound: false,
      stagePacing: { mode: 'afterTick' as const, restSeconds: 180, advanceOn: 'send' as const },
    };

    it('says the workout sets it while the crew clock runs a workout’s pacing', () => {
      applyRestTimerStagePacing(stage, NOW_MS, 'none');
      followCrewClock({ mode: 'afterTick', targetSeconds: 180, advanceOn: 'send', source: 'stage' });
      const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
      expect(container.querySelector('[data-section="mobile.restTimer.workoutPacingTitle"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="rest-length-pill"]')).toBeNull();
    });

    it('shows the crew’s controls once a crewmate set the crew clock by hand', () => {
      applyRestTimerStagePacing(stage, NOW_MS, 'none');
      followCrewClock();
      const { container } = render(<RestTimerSheet visible onClose={() => {}} />);
      expect(container.querySelector('[data-section="mobile.restTimer.workoutPacingTitle"]')).toBeNull();
      expect(controls(container)).toEqual({
        autoAdvance: 'true',
        length: 'mobile.restTimer.lengthPillAria:2:00',
        cadence: 'mobile.restTimer.modeAria:onTheMinute',
      });
    });
  });
});

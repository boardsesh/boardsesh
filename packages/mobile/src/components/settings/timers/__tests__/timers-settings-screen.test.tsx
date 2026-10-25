// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type {
  MoreButtonRow,
  MoreFormModel,
  MoreSelectRow,
  MoreSegmentedRow,
  MoreToggleRow,
  MoreValueRow,
} from '../../../MoreForm.types';

const captured = vi.hoisted(() => ({ model: null as MoreFormModel | null }));
const values = vi.hoisted(() => new Map<string, unknown>());
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const driver = vi.hoisted(() => ({ blockedReason: null as 'crewPassenger' | null }));
const sound = vi.hoisted(() => ({ available: false }));
const modeChange = vi.hoisted(() => ({ change: vi.fn(() => true) }));
const windowSize = vi.hoisted(() => ({ fontScale: 1 }));
const pairingSheet = vi.hoisted(() => ({
  props: null as null | { onSelect: (timerName: string) => void; onDismiss: () => void },
}));
const rogueScenario = vi.hoisted(() => ({
  isAuthenticated: true,
  viewerUserId: 'me' as string | null,
  boards: undefined as UserBoard[] | undefined,
  activeBoard: null as UserBoard | null,
  linkStatus: 'idle' as 'idle' | 'connecting' | 'connected' | 'error',
  updateBoard: vi.fn(),
  setActiveBoard: vi.fn(),
  showToast: vi.fn(),
  fetchAllMyBoards: vi.fn(),
  boardsQuery: null as null | { queryKey: readonly unknown[]; queryFn: unknown; enabled?: boolean },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../MoreForm', () => ({
  MoreForm: ({ model }: { model: MoreFormModel }) => {
    captured.model = model;
    return null;
  },
}));
vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../../hooks/use-session-timer-driver', () => ({
  useSessionTimerDriver: () => ({ blockedReason: driver.blockedReason }),
}));
vi.mock('../../../../providers/queue-provider', () => ({ useQueueSessionId: () => ({ sessionId: 'session-1' }) }));
vi.mock('../../../../lib/rest-timer-cues', () => ({ isRestTimerSoundAvailable: () => sound.available }));
vi.mock('../../../../lib/rest-timer-mode-change', () => ({ changeRestTimerMode: modeChange.change }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  StyleSheet: { create: <T,>(styles: T) => styles },
  useWindowDimensions: () => ({ width: 393, height: 852, fontScale: windowSize.fontScale, scale: 3 }),
}));
vi.mock('../../../ble/TimerPairingSheet', () => ({
  TimerPairingSheet: (props: { onSelect: (timerName: string) => void; onDismiss: () => void }) => {
    pairingSheet.props = props;
    return createElement('div', { 'data-pairing-sheet': 'true' });
  },
}));
vi.mock('../../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: rogueScenario.isAuthenticated }),
}));
vi.mock('../../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => rogueScenario.viewerUserId }));
vi.mock('../../../../lib/graphql/hooks', () => ({
  fetchAllMyBoards: rogueScenario.fetchAllMyBoards,
  useUpdateBoard: () => ({ mutateAsync: rogueScenario.updateBoard }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: readonly unknown[]; queryFn: unknown; enabled?: boolean }) => {
    rogueScenario.boardsQuery = options;
    return { data: options.enabled === false ? undefined : rogueScenario.boards };
  },
}));
vi.mock('../../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: rogueScenario.activeBoard }),
  useSetActiveBoard: () => rogueScenario.setActiveBoard,
}));
vi.mock('../../../../providers/rogue-timer-context', () => ({
  useOptionalRogueTimer: () => ({ status: rogueScenario.linkStatus }),
}));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: rogueScenario.showToast }) }));
vi.mock('../../../../settings', async () => {
  const react = await import('react');
  return {
    useSetting: (key: string) => {
      const [, bump] = react.useReducer((count: number) => count + 1, 0);
      return [
        values.get(key),
        (next: unknown) => {
          values.set(key, next);
          bump();
        },
      ];
    },
  };
});

import { TimersSettingsScreen } from '../TimersSettingsScreen';

function row<T>(key: string, kind: string): T {
  const found = captured.model?.sections.flatMap((section) => section.rows).find((candidate) => candidate.key === key);
  if (found?.kind !== kind) throw new Error(`no ${kind} row ${key}`);
  return found as T;
}

beforeEach(() => {
  values.clear();
  values.set('restTimerTargetSeconds', 120);
  values.set('restTimerMode', 'afterTick');
  values.set('restTimerAutoAdvance', false);
  values.set('restTimerCountdownCues', true);
  values.set('restTimerSound', true);
  captured.model = null;
  driver.blockedReason = null;
  sound.available = false;
  analytics.track.mockClear();
  modeChange.change.mockClear();
  pairingSheet.props = null;
  windowSize.fontScale = 1;
  rogueScenario.isAuthenticated = true;
  rogueScenario.viewerUserId = 'me';
  rogueScenario.boards = undefined;
  rogueScenario.activeBoard = null;
  rogueScenario.linkStatus = 'idle';
  rogueScenario.updateBoard.mockReset();
  rogueScenario.updateBoard.mockImplementation(async (input: { boardUuid: string; timerName: string | null }) =>
    board({ uuid: input.boardUuid, timerName: input.timerName }),
  );
  rogueScenario.setActiveBoard.mockReset();
  rogueScenario.setActiveBoard.mockResolvedValue(true);
  rogueScenario.showToast.mockReset();
  rogueScenario.boardsQuery = null;
});
afterEach(cleanup);

describe('TimersSettingsScreen', () => {
  it('shows the saved rest defaults', () => {
    render(<TimersSettingsScreen />);
    expect(row<MoreSelectRow>('restLength', 'select').selectedKey).toBe('120');
    expect(row<MoreSegmentedRow>('restMode', 'segmented').selectedKey).toBe('afterTick');
    expect(row<MoreToggleRow>('autoAdvance', 'toggle').value).toBe(false);
  });

  it('saves a rest length and reports one change under the timers page', () => {
    render(<TimersSettingsScreen />);
    row<MoreSelectRow>('restLength', 'select').onSelect('300');
    expect(values.get('restTimerTargetSeconds')).toBe(300);
    expect(analytics.track).toHaveBeenCalledWith('Setting Changed', {
      page: 'timers',
      key: 'restLength',
      value: '300',
    });
  });

  it('turns Off into a null length', () => {
    render(<TimersSettingsScreen />);
    row<MoreSelectRow>('restLength', 'select').onSelect('off');
    expect(values.get('restTimerTargetSeconds')).toBeNull();
  });

  it('sends a cadence change through the shared re-arm rule', () => {
    render(<TimersSettingsScreen />);
    row<MoreSegmentedRow>('restMode', 'segmented').onSelect('onTheMinute');
    expect(modeChange.change).toHaveBeenCalledWith('onTheMinute', 'session-1');
  });

  it('reports a cadence change under the timers page', () => {
    render(<TimersSettingsScreen />);
    row<MoreSegmentedRow>('restMode', 'segmented').onSelect('onTheMinute');
    expect(analytics.track).toHaveBeenCalledWith('Setting Changed', {
      page: 'timers',
      key: 'restMode',
      value: 'onTheMinute',
    });
  });

  it('disables auto-advance and asks for a rest length when the length is Off', () => {
    values.set('restTimerTargetSeconds', null);
    render(<TimersSettingsScreen />);
    const autoAdvance = row<MoreToggleRow>('autoAdvance', 'toggle');
    expect(autoAdvance.disabled).toBe(true);
    expect(autoAdvance.subtitle).toBe('mobile.settings.timers.autoAdvanceNeedsLength');
  });

  it('saves the auto-advance toggle when it is enabled', () => {
    render(<TimersSettingsScreen />);
    const autoAdvance = row<MoreToggleRow>('autoAdvance', 'toggle');
    expect(autoAdvance.disabled).toBe(false);
    autoAdvance.onValueChange(true);
    expect(values.get('restTimerAutoAdvance')).toBe(true);
  });

  it('disables auto-advance for a crew passenger', () => {
    driver.blockedReason = 'crewPassenger';
    render(<TimersSettingsScreen />);
    expect(row<MoreToggleRow>('autoAdvance', 'toggle').disabled).toBe(true);
  });

  it('leaves the countdown row out while nothing reads it', () => {
    render(<TimersSettingsScreen />);
    expect(captured.model?.sections.flatMap((section) => section.rows).map((r) => r.key)).not.toContain(
      'countdownCues',
    );
  });

  it('leaves the sound row out when this build cannot play one', () => {
    render(<TimersSettingsScreen />);
    expect(captured.model?.sections.flatMap((section) => section.rows).map((r) => r.key)).not.toContain('sound');
  });

  it('shows and writes the sound row when it can', () => {
    sound.available = true;
    render(<TimersSettingsScreen />);
    row<MoreToggleRow>('sound', 'toggle').onValueChange(false);
    expect(values.get('restTimerSound')).toBe(false);
  });
});

function board(overrides: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'board-1',
    slug: 'home',
    ownerId: 'me',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    name: 'Home wall',
    isPublic: false,
    isUnlisted: false,
    hideLocation: true,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    timerName: null,
    ...overrides,
  };
}

function sectionKeys(): string[] {
  return captured.model?.sections.map((section) => section.key) ?? [];
}

describe('TimersSettingsScreen gym timer', () => {
  it('is hidden signed out', () => {
    rogueScenario.isAuthenticated = false;
    rogueScenario.boards = [board({})];
    render(<TimersSettingsScreen />);
    expect(sectionKeys()).not.toContain('rogue');
  });

  it('waits for the boards instead of saying there are none', () => {
    render(<TimersSettingsScreen />);
    expect(sectionKeys()).not.toContain('rogue');
  });

  it('waits for the climber id instead of saying there are no boards', () => {
    rogueScenario.viewerUserId = null;
    rogueScenario.boards = [board({})];
    render(<TimersSettingsScreen />);
    expect(sectionKeys()).not.toContain('rogue');
  });

  it("reads every page of the climber's boards, under the root updateBoard refreshes", () => {
    rogueScenario.boards = [board({})];
    render(<TimersSettingsScreen />);
    expect(rogueScenario.boardsQuery?.queryFn).toBe(rogueScenario.fetchAllMyBoards);
    expect(rogueScenario.boardsQuery?.queryKey[0]).toBe('myBoards');
    expect(rogueScenario.boardsQuery?.enabled).toBe(true);
  });

  it("lists the climber's own boards", () => {
    rogueScenario.boards = [board({ uuid: 'mine', name: 'Garage' }), board({ uuid: 'gym', ownerId: 'someone-else' })];
    render(<TimersSettingsScreen />);
    expect(row<MoreValueRow>('rogueBoard:mine', 'value').label).toBe('Garage');
    expect(captured.model?.sections.flatMap((section) => section.rows).map((r) => r.key)).not.toContain(
      'rogueBoard:gym',
    );
  });

  it('puts the timer under the board name at the largest text sizes', () => {
    rogueScenario.boards = [board({ uuid: 'mine', name: "Test User's Kilter Original 12×12 with kickboard" })];
    render(<TimersSettingsScreen />);
    expect(row<MoreValueRow>('rogueBoard:mine', 'value').valuePlacement).toBe('trailing');
    cleanup();
    windowSize.fontScale = 3.12;
    render(<TimersSettingsScreen />);
    expect(row<MoreValueRow>('rogueBoard:mine', 'value').valuePlacement).toBe('below');
  });

  it('pairs a timer to the active board and re-saves the stored copy the provider connects from', async () => {
    const active = board({ uuid: 'board-1', name: 'Garage' });
    rogueScenario.boards = [active];
    rogueScenario.activeBoard = active;
    const { container } = render(<TimersSettingsScreen />);

    act(() => row<MoreValueRow>('rogueBoard:board-1', 'value').onPress?.());
    expect(container.querySelector('[data-pairing-sheet]')).not.toBeNull();

    await act(async () => {
      pairingSheet.props?.onSelect(' Rogue Echo Gym Timer ');
    });

    expect(rogueScenario.updateBoard).toHaveBeenCalledWith({ boardUuid: 'board-1', timerName: 'Rogue Echo Gym Timer' });
    expect(rogueScenario.setActiveBoard).toHaveBeenCalledWith({ ...active, timerName: 'Rogue Echo Gym Timer' });
    expect(analytics.track).toHaveBeenCalledWith('Setting Changed', {
      page: 'timers',
      key: 'rogueTimer',
      value: 'paired',
    });
    expect(container.querySelector('[data-pairing-sheet]')).toBeNull();
  });

  it('leaves the stored active board alone when pairing another board', async () => {
    rogueScenario.boards = [board({ uuid: 'board-1' }), board({ uuid: 'board-2', name: 'Spare' })];
    rogueScenario.activeBoard = board({ uuid: 'board-1' });
    render(<TimersSettingsScreen />);

    act(() => row<MoreValueRow>('rogueBoard:board-2', 'value').onPress?.());
    await act(async () => {
      pairingSheet.props?.onSelect('Rogue Home Timer');
    });

    expect(rogueScenario.updateBoard).toHaveBeenCalledWith({ boardUuid: 'board-2', timerName: 'Rogue Home Timer' });
    expect(rogueScenario.setActiveBoard).not.toHaveBeenCalled();
  });

  it('removes a pairing by saving no timer', async () => {
    const active = board({ uuid: 'board-1', timerName: 'Rogue Echo' });
    rogueScenario.boards = [active];
    rogueScenario.activeBoard = active;
    render(<TimersSettingsScreen />);

    await act(async () => {
      row<MoreButtonRow>('rogueRemove:board-1', 'button').onPress();
    });

    expect(rogueScenario.updateBoard).toHaveBeenCalledWith({ boardUuid: 'board-1', timerName: null });
    expect(rogueScenario.setActiveBoard).toHaveBeenCalledWith({ ...active, timerName: null });
    expect(analytics.track).toHaveBeenCalledWith('Setting Changed', {
      page: 'timers',
      key: 'rogueTimer',
      value: 'removed',
    });
  });

  it('shows the row saving while the change is out', async () => {
    rogueScenario.boards = [board({ timerName: 'Rogue Echo' })];
    let finishSave: () => void = () => {};
    rogueScenario.updateBoard.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve(board({ timerName: null }));
        }),
    );
    render(<TimersSettingsScreen />);

    act(() => row<MoreButtonRow>('rogueRemove:board-1', 'button').onPress());
    expect(row<MoreValueRow>('rogueBoard:board-1', 'value').busy).toBe(true);

    await act(async () => {
      finishSave();
    });
    expect(row<MoreValueRow>('rogueBoard:board-1', 'value').busy).toBe(false);
  });

  it('says so when the save fails, and touches nothing else', async () => {
    rogueScenario.boards = [board({})];
    rogueScenario.activeBoard = board({});
    rogueScenario.updateBoard.mockRejectedValueOnce(new Error('offline'));
    render(<TimersSettingsScreen />);

    act(() => row<MoreValueRow>('rogueBoard:board-1', 'value').onPress?.());
    await act(async () => {
      pairingSheet.props?.onSelect('Rogue Echo');
    });

    expect(rogueScenario.showToast).toHaveBeenCalledWith('mobile.settings.timers.rogueSaveFailed', 'error');
    expect(rogueScenario.setActiveBoard).not.toHaveBeenCalled();
    expect(row<MoreValueRow>('rogueBoard:board-1', 'value').busy).toBe(false);
  });

  it('closes the pairing sheet without saving on dismiss', () => {
    rogueScenario.boards = [board({})];
    const { container } = render(<TimersSettingsScreen />);

    act(() => row<MoreValueRow>('rogueBoard:board-1', 'value').onPress?.());
    act(() => pairingSheet.props?.onDismiss());

    expect(container.querySelector('[data-pairing-sheet]')).toBeNull();
    expect(rogueScenario.updateBoard).not.toHaveBeenCalled();
  });

  it("says how the active board's timer link is doing", () => {
    rogueScenario.boards = [board({ timerName: 'Rogue Echo' })];
    rogueScenario.activeBoard = board({ timerName: 'Rogue Echo' });
    rogueScenario.linkStatus = 'connected';
    render(<TimersSettingsScreen />);
    expect(row<MoreValueRow>('rogueBoard:board-1', 'value').subtitle).toBe('mobile.settings.timers.rogueConnected');
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { OnboardingGateEvaluation } from '../../../lib/onboarding/onboarding-gate-analytics';

const pushMock = vi.hoisted(() => vi.fn());
const segmentsCtrl = vi.hoisted(() => ({ segments: ['(tabs)', 'climbs'] as string[] }));
const hasSeenMock = vi.hoisted(() => vi.fn());
const markSeenMock = vi.hoisted(() => vi.fn());
const getInitialURLMock = vi.hoisted(() => vi.fn());
const trackGateMock = vi.hoisted(() => vi.fn());
// The gate's real input since issue #4961: onboarding is due whenever there is
// no bound board. Only a successful read distinguishes a missing selection from
// one whose storage read is pending or failed.
const activeBoardCtrl = vi.hoisted(() => ({
  board: null as { uuid: string } | null | undefined,
  isSuccess: true,
}));
// Controllable signed-in profile: the gate keys its first-run decision on the
// profile id, so tests drive sign-out/sign-in by swapping this id.
//
// `status` stands in for the query's lifecycle: `settled` is a finished read
// with nothing in flight (with no id, that is the signed-out `profile: null`),
// `fetching` a read in flight, `error` a read that failed.
const profileCtrl = vi.hoisted(() => ({
  id: undefined as string | undefined,
  createdAt: '2026-09-20T12:00:00.000Z' as string | undefined,
  status: 'settled' as 'settled' | 'fetching' | 'error',
}));
const launchCtrl = vi.hoisted(() => ({ ready: true }));
const boardLookGateCtrl = vi.hoisted(() => ({
  lastProps: null as { ready: boolean; tourDecided: boolean; present: boolean } | null,
}));
// A controllable AppState: the stall watchdog only counts foreground time.
const appStateCtrl = vi.hoisted(() => ({
  currentState: 'active' as string,
  listeners: new Set<(state: string) => void>(),
  change(state: string) {
    appStateCtrl.currentState = state;
    for (const listener of appStateCtrl.listeners) listener(state);
  },
}));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appStateCtrl.currentState;
    },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appStateCtrl.listeners.add(listener);
      return { remove: () => appStateCtrl.listeners.delete(listener) };
    },
  },
}));
vi.mock('expo-router', () => ({
  router: { push: pushMock },
  useSegments: () => segmentsCtrl.segments,
}));
vi.mock('expo-linking', () => ({
  getInitialURL: getInitialURLMock,
}));
vi.mock('../../../lib/onboarding/onboarding-storage', () => ({
  hasSeenOnboarding: hasSeenMock,
  markOnboardingSeen: markSeenMock,
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({
    data: activeBoardCtrl.board,
    isSuccess: activeBoardCtrl.isSuccess,
  }),
}));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({
    data: profileCtrl.id ? { id: profileCtrl.id, createdAt: profileCtrl.createdAt } : undefined,
    isFetching: profileCtrl.status === 'fetching',
    isSuccess: profileCtrl.status === 'settled',
    isError: profileCtrl.status === 'error',
  }),
}));
vi.mock('../../../providers/launch-ready-context', () => ({ useLaunchReady: () => launchCtrl.ready }));
// The payload and the volume rule have their own suite; here what matters is
// that the gate hands over exactly one evaluation per decision.
vi.mock('../../../lib/onboarding/onboarding-gate-analytics', () => ({
  trackOnboardingGateEvaluated: trackGateMock,
}));
// The board-look branch has its own suite; stubbed here (it reaches the native
// render graph, which this suite has no reason to load) while still recording
// whether the tour let it run.
vi.mock('../../board-look/BoardLookStepGate', () => ({
  BoardLookStepGate: (props: { ready: boolean; tourDecided: boolean; present: boolean }) => {
    boardLookGateCtrl.lastProps = props;
    return null;
  },
}));

import {
  OnboardingGate,
  ONBOARDING_GATE_PROFILE_WAIT_MS,
  ONBOARDING_GATE_STALL_MS,
  resetOnboardingGateProcessForTests,
} from '../OnboardingGate';

function evaluations(): OnboardingGateEvaluation[] {
  return trackGateMock.mock.calls.map(([evaluation]) => evaluation as OnboardingGateEvaluation);
}

function decisions(): OnboardingGateEvaluation[] {
  return evaluations().filter((evaluation) => evaluation.outcome !== 'stalled');
}

describe('OnboardingGate', () => {
  beforeEach(() => {
    resetOnboardingGateProcessForTests();
    pushMock.mockClear();
    trackGateMock.mockClear();
    hasSeenMock.mockReset();
    markSeenMock.mockReset();
    markSeenMock.mockResolvedValue(undefined);
    getInitialURLMock.mockReset();
    // Default: no board bound, so the flow is due.
    activeBoardCtrl.board = null;
    activeBoardCtrl.isSuccess = true;
    // Default: a plain launch (no cold-start deep link).
    getInitialURLMock.mockResolvedValue(null);
    segmentsCtrl.segments = ['(tabs)', 'climbs'];
    profileCtrl.id = undefined;
    profileCtrl.createdAt = '2026-09-20T12:00:00.000Z';
    profileCtrl.status = 'settled';
    launchCtrl.ready = true;
    appStateCtrl.currentState = 'active';
    appStateCtrl.listeners.clear();
    boardLookGateCtrl.lastProps = null;
    delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
  });

  it('does nothing until the app is ready', async () => {
    hasSeenMock.mockResolvedValue(false);
    launchCtrl.ready = false;
    render(<OnboardingGate />);
    await Promise.resolve();
    expect(hasSeenMock).not.toHaveBeenCalled();
    expect(decisions()).toEqual([]);
  });

  it('decides once readiness arrives through the launch-ready context', async () => {
    hasSeenMock.mockResolvedValue(false);
    launchCtrl.ready = false;
    const { rerender } = render(<OnboardingGate />);
    await Promise.resolve();
    expect(hasSeenMock).not.toHaveBeenCalled();

    launchCtrl.ready = true;
    rerender(<OnboardingGate />);

    await waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]).toMatchObject({ outcome: 'would_present', reason: 'no_board' });
  });

  // #5654: waking this gate up must not drop every existing climber without a
  // board into a mandatory flow they have never seen. It logs instead.
  describe('evaluates and logs, and never presents', () => {
    it('logs would_present at the framing card for a genuinely new climber', async () => {
      hasSeenMock.mockResolvedValue(false);
      render(<OnboardingGate />);

      await waitFor(() => expect(decisions()).toHaveLength(1));
      expect(decisions()[0]).toMatchObject({
        outcome: 'would_present',
        reason: 'no_board',
        step: 'intro',
        hadBoard: false,
        seenFlag: false,
        trigger: 'cold_start',
        topSegment: '(tabs)',
      });
      expect(pushMock).not.toHaveBeenCalled();
    });

    // The hole the #4961 board gate closed: on iOS the seen flag survives an
    // uninstall while the board does not. A returning climber would start at
    // the board step, not the framing card.
    it('logs would_present at the board step when the board is gone but the seen flag survived', async () => {
      hasSeenMock.mockResolvedValue(true);
      render(<OnboardingGate />);

      await waitFor(() => expect(decisions()).toHaveLength(1));
      expect(decisions()[0]).toMatchObject({ outcome: 'would_present', step: 'board', seenFlag: true });
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('hands the account creation time over so the event can carry the account age', async () => {
      hasSeenMock.mockResolvedValue(false);
      profileCtrl.id = 'user-a';
      render(<OnboardingGate />);

      await waitFor(() => expect(decisions()).toHaveLength(1));
      expect(decisions()[0].accountCreatedAt).toBe('2026-09-20T12:00:00.000Z');
    });

    it('mounts the board-look branch in log-only mode', () => {
      render(<OnboardingGate />);
      expect(boardLookGateCtrl.lastProps?.present).toBe(false);
    });
  });

  it('skips a climber with a board bound', async () => {
    hasSeenMock.mockResolvedValue(true);
    activeBoardCtrl.board = { uuid: 'board-1' };
    render(<OnboardingGate />);
    await waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]).toMatchObject({ outcome: 'skipped', reason: 'has_board', hadBoard: true, seenFlag: true });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('backfills the seen flag for a climber who bound a board before this gate existed', async () => {
    hasSeenMock.mockResolvedValue(false);
    activeBoardCtrl.board = { uuid: 'board-1' };
    render(<OnboardingGate />);
    await waitFor(() => expect(markSeenMock).toHaveBeenCalledTimes(1));
    expect(decisions()[0]).toMatchObject({ outcome: 'skipped', reason: 'has_board', seenFlag: false });
  });

  it('leaves the seen flag alone when it is already set', async () => {
    hasSeenMock.mockResolvedValue(true);
    activeBoardCtrl.board = { uuid: 'board-1' };
    render(<OnboardingGate />);
    await waitFor(() => expect(hasSeenMock).toHaveBeenCalled());
    expect(markSeenMock).not.toHaveBeenCalled();
  });

  // `data: undefined` while the AsyncStorage read is in flight is indistinguishable
  // from "no board", so deciding early would flash the flow at everyone.
  it('waits for the active-board read before deciding', async () => {
    hasSeenMock.mockResolvedValue(true);
    activeBoardCtrl.isSuccess = false;
    render(<OnboardingGate />);
    await Promise.resolve();
    await Promise.resolve();
    expect(hasSeenMock).not.toHaveBeenCalled();
    expect(decisions()).toEqual([]);
  });

  it('does not decide during a failed board read and skips setup after recovery', async () => {
    hasSeenMock.mockResolvedValue(true);
    activeBoardCtrl.board = undefined;
    activeBoardCtrl.isSuccess = false;
    const { rerender } = render(<OnboardingGate />);
    await Promise.resolve();
    await Promise.resolve();

    expect(hasSeenMock).not.toHaveBeenCalled();
    expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(false);

    activeBoardCtrl.board = { uuid: 'saved-board' };
    activeBoardCtrl.isSuccess = true;
    rerender(<OnboardingGate />);

    await waitFor(() => expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(true));
    expect(hasSeenMock).toHaveBeenCalledOnce();
    expect(decisions()).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'has_board' })]);
  });

  it('decides only after a retry successfully confirms no saved board', async () => {
    hasSeenMock.mockResolvedValue(false);
    activeBoardCtrl.board = undefined;
    activeBoardCtrl.isSuccess = false;
    const { rerender } = render(<OnboardingGate />);
    await Promise.resolve();
    expect(decisions()).toEqual([]);

    activeBoardCtrl.board = null;
    activeBoardCtrl.isSuccess = true;
    rerender(<OnboardingGate />);

    await waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]).toMatchObject({ outcome: 'would_present', reason: 'no_board' });
  });

  it('stands down on a join deep-link landing, before reading anything', async () => {
    hasSeenMock.mockResolvedValue(false);
    segmentsCtrl.segments = ['join', '[sessionId]'];
    render(<OnboardingGate />);
    await waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'deep_link_segment',
      topSegment: 'join',
      seenFlag: null,
    });
    expect(getInitialURLMock).not.toHaveBeenCalled();
    expect(hasSeenMock).not.toHaveBeenCalled();
  });

  it('stands down in the auth flow', async () => {
    hasSeenMock.mockResolvedValue(false);
    segmentsCtrl.segments = ['auth', 'login'];
    render(<OnboardingGate />);
    await waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]).toMatchObject({ outcome: 'skipped', reason: 'deep_link_segment', topSegment: 'auth' });
  });

  it('stands down on a cold-start deep link that lands ON a tab', async () => {
    // The custom-scheme link resolved into the Climbs tab, so the segment guard
    // sees a normal '(tabs)' landing and wouldn't catch it — the launch URL is
    // what tells us the user arrived via an intentional deep link.
    hasSeenMock.mockResolvedValue(false);
    getInitialURLMock.mockResolvedValue('com.boardsesh.app://climbs/kilter');
    render(<OnboardingGate />);
    await waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]).toMatchObject({ outcome: 'skipped', reason: 'launched_by_url', seenFlag: null });
    expect(hasSeenMock).not.toHaveBeenCalled();
  });

  it('stands down when a deep link arrives while the reads are in flight', async () => {
    let resolveSeen: (seen: boolean) => void = () => {};
    hasSeenMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveSeen = resolve;
      }),
    );
    const { rerender } = render(<OnboardingGate />);
    await waitFor(() => expect(hasSeenMock).toHaveBeenCalled());

    segmentsCtrl.segments = ['session', 'abc'];
    rerender(<OnboardingGate />);
    await act(async () => resolveSeen(false));

    expect(decisions()).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'segment_after_reads' })]);
  });

  it('treats a launch-URL read error as a normal launch', async () => {
    hasSeenMock.mockResolvedValue(false);
    getInitialURLMock.mockRejectedValue(new Error('linking unavailable'));
    render(<OnboardingGate />);
    await waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]).toMatchObject({ outcome: 'would_present', reason: 'no_board' });
  });

  it('calls a later mount in the same process a remount, not a cold start', async () => {
    hasSeenMock.mockResolvedValue(false);
    const first = render(<OnboardingGate />);
    await waitFor(() => expect(decisions()).toHaveLength(1));
    first.unmount();

    render(<OnboardingGate />);
    await waitFor(() => expect(decisions()).toHaveLength(2));
    expect(decisions().map((evaluation) => evaluation.trigger)).toEqual(['cold_start', 'remount']);
  });

  it('re-evaluates when a different user signs in during the session', async () => {
    // User A already has a board.
    hasSeenMock.mockResolvedValue(true);
    activeBoardCtrl.board = { uuid: 'board-1' };
    profileCtrl.id = 'user-a';
    const { rerender } = render(<OnboardingGate />);
    await waitFor(() => expect(decisions()).toHaveLength(1));

    // User B signs in (different id) with the board cleared out from under them —
    // the gate must re-check rather than staying "decided" from user A.
    hasSeenMock.mockResolvedValue(false);
    activeBoardCtrl.board = null;
    profileCtrl.id = 'user-b';
    rerender(<OnboardingGate />);
    await waitFor(() => expect(decisions()).toHaveLength(2));
    expect(decisions()[1]).toMatchObject({ outcome: 'would_present', trigger: 'account_switch' });
  });

  it('does not re-decide when the same user id stays stable across rerenders', async () => {
    hasSeenMock.mockResolvedValue(true);
    activeBoardCtrl.board = { uuid: 'board-1' };
    profileCtrl.id = 'user-a';
    const { rerender } = render(<OnboardingGate />);
    await waitFor(() => expect(hasSeenMock).toHaveBeenCalledTimes(1));
    rerender(<OnboardingGate />);
    await Promise.resolve();
    expect(hasSeenMock).toHaveBeenCalledTimes(1);
    expect(decisions()).toHaveLength(1);
  });

  // A profile id appearing after a settled read that said "nobody" is the same
  // account finishing loading, not a new one, so it must not buy a second
  // decision (and a second event) once the first has landed.
  it('does not re-decide when the profile lands after the decision', async () => {
    hasSeenMock.mockResolvedValue(false);
    profileCtrl.id = undefined;
    const { rerender } = render(<OnboardingGate />);
    await waitFor(() => expect(decisions()).toHaveLength(1));

    profileCtrl.id = 'user-a';
    rerender(<OnboardingGate />);
    await Promise.resolve();
    await Promise.resolve();

    expect(decisions()).toHaveLength(1);
    expect(hasSeenMock).toHaveBeenCalledTimes(1);
  });

  // The account age is what splits new accounts from existing ones, and the
  // profile read is the only place it comes from. On a cold start and after a
  // sign-in, that read is still on the network when the local reads answer.
  describe('waiting for the profile', () => {
    it('holds the decision until the profile lands, then carries the account age', async () => {
      hasSeenMock.mockResolvedValue(false);
      profileCtrl.status = 'fetching';
      const { rerender } = render(<OnboardingGate />);
      // Every local read would have answered by now.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(decisions()).toEqual([]);
      expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(false);

      profileCtrl.id = 'user-a';
      profileCtrl.status = 'settled';
      rerender(<OnboardingGate />);

      await waitFor(() => expect(decisions()).toHaveLength(1));
      expect(decisions()[0]).toMatchObject({
        outcome: 'would_present',
        accountCreatedAt: '2026-09-20T12:00:00.000Z',
        afterStall: false,
      });
      expect(hasSeenMock).toHaveBeenCalledTimes(1);
    });

    // A sign-in keeps the login screen's cached `profile: null` while the
    // refetch that replaces it runs. That null is not an answer yet.
    it('does not take a cached empty profile for an answer while its refetch runs', async () => {
      hasSeenMock.mockResolvedValue(false);
      profileCtrl.id = undefined;
      profileCtrl.status = 'fetching';
      const { rerender } = render(<OnboardingGate />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(decisions()).toEqual([]);

      profileCtrl.id = 'user-new';
      profileCtrl.createdAt = '2026-09-21T11:00:00.000Z';
      profileCtrl.status = 'settled';
      rerender(<OnboardingGate />);

      await waitFor(() => expect(decisions()).toHaveLength(1));
      expect(decisions()[0].accountCreatedAt).toBe('2026-09-21T11:00:00.000Z');
    });

    it('decides without the age when the profile read fails', async () => {
      hasSeenMock.mockResolvedValue(false);
      profileCtrl.status = 'error';
      render(<OnboardingGate />);

      await waitFor(() => expect(decisions()).toHaveLength(1));
      expect(decisions()[0]).toMatchObject({ outcome: 'would_present', accountCreatedAt: undefined });
    });

    it('stops waiting after the bound, well before the stall watchdog', async () => {
      vi.useFakeTimers();
      hasSeenMock.mockResolvedValue(false);
      profileCtrl.status = 'fetching';
      render(<OnboardingGate />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ONBOARDING_GATE_PROFILE_WAIT_MS - 1);
      });
      expect(evaluations()).toEqual([]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(evaluations()).toEqual([
        expect.objectContaining({ outcome: 'would_present', accountCreatedAt: undefined, afterStall: false }),
      ]);

      // The watchdog was stopped by that decision.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ONBOARDING_GATE_STALL_MS * 2);
      });
      expect(evaluations()).toHaveLength(1);
    });

    it('does not re-open the wait when the profile refetches after it settled', async () => {
      let resolveSeen: (seen: boolean) => void = () => {};
      hasSeenMock.mockReturnValue(
        new Promise<boolean>((resolve) => {
          resolveSeen = resolve;
        }),
      );
      const { rerender } = render(<OnboardingGate />);
      await waitFor(() => expect(hasSeenMock).toHaveBeenCalled());

      // A refetch starts while the decision's reads are in flight. Re-opening
      // the wait would cancel the run and read everything again.
      profileCtrl.status = 'fetching';
      rerender(<OnboardingGate />);
      await act(async () => resolveSeen(false));

      expect(decisions()).toHaveLength(1);
      expect(hasSeenMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('handing off to the board-look step', () => {
    it('holds the board-look branch until the tour has finished evaluating', () => {
      // Synchronous first render: the tour's flag read is still in flight, so
      // nothing else may decide to interrupt yet.
      hasSeenMock.mockResolvedValue(true);
      activeBoardCtrl.board = { uuid: 'board-1' };
      render(<OnboardingGate />);

      expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(false);
    });

    it('releases the board-look branch once the tour stands down', async () => {
      hasSeenMock.mockResolvedValue(true);
      activeBoardCtrl.board = { uuid: 'board-1' };
      render(<OnboardingGate />);

      await waitFor(() => expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(true));
    });

    it('releases it after a would_present decision too', async () => {
      hasSeenMock.mockResolvedValue(false);
      render(<OnboardingGate />);

      await waitFor(() => expect(decisions()).toHaveLength(1));
      expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(true);
    });

    it('releases it when the tour stands down for a deep-link landing', async () => {
      segmentsCtrl.segments = ['join', 'abc'];
      render(<OnboardingGate />);

      await waitFor(() => expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(true));
    });
  });

  describe('the profile resolving mid-decision', () => {
    it('still decides, once, when userId arrives while the reads are in flight', async () => {
      // `useProfile()` resolves a tick after mount, so `userId` goes undefined ->
      // 'user-a', this effect re-runs, and its cleanup cancels the in-flight
      // read. The cancelled run decided nothing, so the re-run must go through.
      hasSeenMock.mockResolvedValue(true);
      activeBoardCtrl.board = { uuid: 'board-1' };
      profileCtrl.id = undefined;
      const { rerender } = render(<OnboardingGate />);

      profileCtrl.id = 'user-a';
      rerender(<OnboardingGate />);

      await waitFor(() => expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(true));
      await waitFor(() => expect(decisions()).toHaveLength(1));
    });

    it('keeps the board-look branch held while a cancelled run is re-reading', async () => {
      // The first run is cancelled mid-read by the profile landing. It decided
      // nothing, so it must not release the board-look branch: only the re-run,
      // once it has decided, does.
      let resolveFirstSeen: (seen: boolean) => void = () => {};
      let resolveSecondSeen: (seen: boolean) => void = () => {};
      hasSeenMock
        .mockReturnValueOnce(
          new Promise<boolean>((resolve) => {
            resolveFirstSeen = resolve;
          }),
        )
        .mockReturnValueOnce(
          new Promise<boolean>((resolve) => {
            resolveSecondSeen = resolve;
          }),
        );
      activeBoardCtrl.board = { uuid: 'board-1' };
      const { rerender } = render(<OnboardingGate />);
      await waitFor(() => expect(hasSeenMock).toHaveBeenCalledTimes(1));

      profileCtrl.id = 'user-a';
      rerender(<OnboardingGate />);
      await waitFor(() => expect(hasSeenMock).toHaveBeenCalledTimes(2));

      await act(async () => resolveFirstSeen(true));
      expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(false);
      expect(decisions()).toEqual([]);

      await act(async () => resolveSecondSeen(true));
      expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(true);
      expect(decisions()).toHaveLength(1);
    });

    it('still decides when the profile flickers back to undefined mid-read', async () => {
      // Each flip cancels the run in flight. Latching the decision on a
      // cancelled run used to leave the gate undecided for the whole launch.
      hasSeenMock.mockResolvedValue(true);
      activeBoardCtrl.board = { uuid: 'board-1' };
      profileCtrl.id = undefined;
      const { rerender } = render(<OnboardingGate />);

      profileCtrl.id = 'user-a';
      rerender(<OnboardingGate />);
      profileCtrl.id = undefined;
      rerender(<OnboardingGate />);

      await waitFor(() => expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(true));
      await waitFor(() => expect(decisions()).toHaveLength(1));
    });
  });

  // The watchdog is the part of the event that would have caught #5654 in a
  // day: it does not depend on the inputs that froze.
  describe('stall watchdog', () => {
    it('reports not_ready once when readiness never arrives within 15 s of foreground time', async () => {
      vi.useFakeTimers();
      launchCtrl.ready = false;
      render(<OnboardingGate />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ONBOARDING_GATE_STALL_MS - 1);
      });
      expect(evaluations()).toEqual([]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(evaluations()).toEqual([
        expect.objectContaining({ outcome: 'stalled', reason: 'not_ready', hadBoard: false, trigger: 'cold_start' }),
      ]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ONBOARDING_GATE_STALL_MS * 4);
      });
      expect(evaluations()).toHaveLength(1);
    });

    it('names the board read when that is what never answered', async () => {
      vi.useFakeTimers();
      activeBoardCtrl.isSuccess = false;
      render(<OnboardingGate />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ONBOARDING_GATE_STALL_MS);
      });
      expect(evaluations()).toEqual([
        expect.objectContaining({ outcome: 'stalled', reason: 'board_unresolved', hadBoard: null }),
      ]);
    });

    it('names the reads when the gate started deciding but never finished', async () => {
      vi.useFakeTimers();
      hasSeenMock.mockReturnValue(new Promise<boolean>(() => {}));
      render(<OnboardingGate />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ONBOARDING_GATE_STALL_MS);
      });
      expect(evaluations()).toEqual([expect.objectContaining({ outcome: 'stalled', reason: 'reads_pending' })]);
    });

    it('does not count time in the background', async () => {
      vi.useFakeTimers();
      launchCtrl.ready = false;
      render(<OnboardingGate />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
        appStateCtrl.change('background');
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(evaluations()).toEqual([]);

      await act(async () => {
        appStateCtrl.change('active');
        await vi.advanceTimersByTimeAsync(ONBOARDING_GATE_STALL_MS - 10_000);
      });
      expect(evaluations()).toEqual([expect.objectContaining({ outcome: 'stalled' })]);
    });

    it('marks a decision that lands after the stall report', async () => {
      vi.useFakeTimers();
      hasSeenMock.mockResolvedValue(false);
      launchCtrl.ready = false;
      const { rerender } = render(<OnboardingGate />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ONBOARDING_GATE_STALL_MS);
      });
      launchCtrl.ready = true;
      rerender(<OnboardingGate />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(evaluations()).toEqual([
        expect.objectContaining({ outcome: 'stalled', reason: 'not_ready', afterStall: false }),
        expect.objectContaining({ outcome: 'would_present', afterStall: true }),
      ]);
    });

    it('stays quiet once the gate has decided', async () => {
      vi.useFakeTimers();
      hasSeenMock.mockResolvedValue(false);
      render(<OnboardingGate />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ONBOARDING_GATE_STALL_MS * 2);
      });
      expect(evaluations()).toEqual([expect.objectContaining({ outcome: 'would_present' })]);
    });

    it('never arms in a screenshot build, which never decides on purpose', async () => {
      vi.useFakeTimers();
      process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
      render(<OnboardingGate />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ONBOARDING_GATE_STALL_MS * 2);
      });
      expect(evaluations()).toEqual([]);
    });
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const pushMock = vi.hoisted(() => vi.fn());
const segmentsCtrl = vi.hoisted(() => ({ segments: ['(tabs)', 'climbs'] as string[] }));
const hasSeenMock = vi.hoisted(() => vi.fn());
const getInitialURLMock = vi.hoisted(() => vi.fn());
// Controllable signed-in profile: the gate keys its first-run decision on the
// profile id, so tests drive sign-out/sign-in by swapping this id.
const profileCtrl = vi.hoisted(() => ({ id: undefined as string | undefined }));
const boardLookGateCtrl = vi.hoisted(() => ({
  lastProps: null as { ready: boolean; tourDecided: boolean } | null,
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
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: profileCtrl.id ? { id: profileCtrl.id } : undefined }),
}));
// The board-look branch has its own suite; stubbed here (it reaches the native
// render graph, which this suite has no reason to load) while still recording
// whether the tour let it run.
vi.mock('../../board-look/BoardLookStepGate', () => ({
  BoardLookStepGate: (props: { ready: boolean; tourDecided: boolean }) => {
    boardLookGateCtrl.lastProps = props;
    return null;
  },
}));

import { OnboardingGate } from '../OnboardingGate';

describe('OnboardingGate', () => {
  beforeEach(() => {
    pushMock.mockClear();
    hasSeenMock.mockReset();
    getInitialURLMock.mockReset();
    // Default: a plain launch (no cold-start deep link).
    getInitialURLMock.mockResolvedValue(null);
    segmentsCtrl.segments = ['(tabs)', 'climbs'];
    profileCtrl.id = undefined;
  });

  it('does nothing until the app is ready', async () => {
    hasSeenMock.mockResolvedValue(false);
    render(<OnboardingGate ready={false} />);
    await Promise.resolve();
    expect(hasSeenMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('pushes the onboarding route on a fresh, ready, non-deep-link launch', async () => {
    hasSeenMock.mockResolvedValue(false);
    render(<OnboardingGate ready />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/onboarding'));
  });

  it('does not re-show the tour once it has been seen', async () => {
    hasSeenMock.mockResolvedValue(true);
    render(<OnboardingGate ready />);
    await waitFor(() => expect(hasSeenMock).toHaveBeenCalled());
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not interrupt a join deep-link landing', async () => {
    hasSeenMock.mockResolvedValue(false);
    segmentsCtrl.segments = ['join', '[sessionId]'];
    render(<OnboardingGate ready />);
    await Promise.resolve();
    await Promise.resolve();
    // Short-circuits before reading the flag — the deep-link destination wins.
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not interrupt the auth flow', async () => {
    hasSeenMock.mockResolvedValue(false);
    segmentsCtrl.segments = ['auth', 'login'];
    render(<OnboardingGate ready />);
    await Promise.resolve();
    await Promise.resolve();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not cover a cold-start deep link that lands ON a tab', async () => {
    // The custom-scheme link resolved into the Climbs tab, so the segment guard
    // sees a normal '(tabs)' landing and wouldn't catch it — the launch URL is
    // what tells us the user arrived via an intentional deep link.
    hasSeenMock.mockResolvedValue(false);
    segmentsCtrl.segments = ['(tabs)', 'climbs'];
    getInitialURLMock.mockResolvedValue('com.boardsesh.app://climbs/kilter');
    render(<OnboardingGate ready />);
    await waitFor(() => expect(getInitialURLMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not read the seen flag when launched via a deep link', async () => {
    hasSeenMock.mockResolvedValue(false);
    getInitialURLMock.mockResolvedValue('com.boardsesh.app://climbs/tension');
    render(<OnboardingGate ready />);
    await waitFor(() => expect(getInitialURLMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(hasSeenMock).not.toHaveBeenCalled();
  });

  it('still shows once on a normal launch with no deep link', async () => {
    hasSeenMock.mockResolvedValue(false);
    getInitialURLMock.mockResolvedValue(null);
    render(<OnboardingGate ready />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/onboarding'));
  });

  it('treats a launch-URL read error as a normal launch (shows the tour)', async () => {
    hasSeenMock.mockResolvedValue(false);
    getInitialURLMock.mockRejectedValue(new Error('linking unavailable'));
    render(<OnboardingGate ready />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/onboarding'));
  });

  it('re-evaluates first-run when a different user signs in during the session', async () => {
    // User A has already seen the tour — no push.
    hasSeenMock.mockResolvedValue(true);
    profileCtrl.id = 'user-a';
    const { rerender } = render(<OnboardingGate ready />);
    await waitFor(() => expect(hasSeenMock).toHaveBeenCalledTimes(1));
    expect(pushMock).not.toHaveBeenCalled();

    // User B signs in (different id) and hasn't seen it — the gate must
    // re-check and push, rather than staying "decided" from user A.
    hasSeenMock.mockResolvedValue(false);
    profileCtrl.id = 'user-b';
    rerender(<OnboardingGate ready />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/onboarding'));
    expect(hasSeenMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-decide when the same user id stays stable across rerenders', async () => {
    hasSeenMock.mockResolvedValue(true);
    profileCtrl.id = 'user-a';
    const { rerender } = render(<OnboardingGate ready />);
    await waitFor(() => expect(hasSeenMock).toHaveBeenCalledTimes(1));
    rerender(<OnboardingGate ready />);
    await Promise.resolve();
    // Same id → the gate stays decided; no extra flag read, no push.
    expect(hasSeenMock).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();
  });

  describe('handing off to the board-look step', () => {
    it('holds the board-look branch until the tour has finished evaluating', () => {
      // Synchronous first render: the tour's flag read is still in flight, so
      // nothing else may decide to interrupt yet.
      hasSeenMock.mockResolvedValue(true);
      render(<OnboardingGate ready />);

      expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(false);
    });

    it('releases the board-look branch once the tour stands down', async () => {
      hasSeenMock.mockResolvedValue(true);
      render(<OnboardingGate ready />);

      await waitFor(() => expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(true));
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('releases it after the tour pushes too, so a fresh install is asked on the way back', async () => {
      // The tour hands off to the board picker; the board-look step has nothing
      // to preview until a board is bound, and the route guard (`onboarding` /
      // `boards` are blocked segments) is what keeps the two from overlapping —
      // NOT this flag. Latching it on "the tour is showing" would push the
      // question to the next launch instead.
      hasSeenMock.mockResolvedValue(false);
      render(<OnboardingGate ready />);

      await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/onboarding'));
      expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(true);
    });

    it('releases it when the tour stands down for a deep-link landing', async () => {
      segmentsCtrl.segments = ['join', 'abc'];
      render(<OnboardingGate ready />);

      await waitFor(() => expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(true));
      // The board-look gate has its own route guard for the same segments.
      expect(pushMock).not.toHaveBeenCalled();
    });
  });

  describe('the profile resolving mid-decision', () => {
    it('still releases the board-look branch when userId arrives after mount', async () => {
      // The regression. `useProfile()` resolves a tick after mount, so `userId`
      // goes undefined -> 'user-a', this effect re-runs, and its cleanup cancels
      // the in-flight async. That run used to bail without publishing
      // `tourDecided`, and the re-run then hit the `decidedRef` guard and
      // returned immediately — leaving the board-look step waiting on a flag
      // nothing would ever set again.
      hasSeenMock.mockResolvedValue(true);
      profileCtrl.id = undefined;
      const { rerender } = render(<OnboardingGate ready />);

      profileCtrl.id = 'user-a';
      rerender(<OnboardingGate ready />);

      await waitFor(() => expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(true));
    });

    it('releases it even when the profile flickers back to undefined', async () => {
      // A refetch can briefly clear `data`. That transition does not reset
      // `decidedRef` (it is guarded on a concrete id), so the re-run early-returns
      // — the flag must already be published by then.
      hasSeenMock.mockResolvedValue(true);
      profileCtrl.id = undefined;
      const { rerender } = render(<OnboardingGate ready />);

      profileCtrl.id = 'user-a';
      rerender(<OnboardingGate ready />);
      profileCtrl.id = undefined;
      rerender(<OnboardingGate ready />);

      await waitFor(() => expect(boardLookGateCtrl.lastProps?.tourDecided).toBe(true));
    });
  });
});

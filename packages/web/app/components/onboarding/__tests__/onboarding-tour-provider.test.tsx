// @vitest-environment jsdom
/* eslint-disable import/first -- vi.hoisted mocks must appear before the imports they mock so the test harness can intercept the module load. */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { act, renderHook } from '@testing-library/react';
import React from 'react';

// --- Module mocks ----------------------------------------------------------

const { mockUsePathname, mockUseSession, mockTrack, mockOnboardingDb } = vi.hoisted(() => ({
  mockUsePathname: vi.fn<() => string>(() => '/'),
  mockUseSession: vi.fn<() => { data: { user: { id: string } | null } | null }>(() => ({ data: null })),
  mockTrack: vi.fn(),
  mockOnboardingDb: {
    getTourProgress: vi.fn<() => Promise<unknown | null>>(async () => null),
    saveTourProgress: vi.fn<() => Promise<void>>(async () => undefined),
    clearTourProgress: vi.fn<() => Promise<void>>(async () => undefined),
    saveOnboardingStatus: vi.fn<() => Promise<void>>(async () => undefined),
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: mockUsePathname,
}));

vi.mock('next-auth/react', () => ({
  useSession: mockUseSession,
}));

vi.mock('@/app/lib/analytics', () => ({
  track: mockTrack,
}));

vi.mock('@/app/lib/onboarding-db', () => mockOnboardingDb);

// Imported AFTER mocks so they hit the mocked modules
import { OnboardingTourProvider, useOnboardingTour } from '../onboarding-tour-provider';
import { PLAY_DRAWER_EVENT } from '@/app/components/queue-control/play-drawer-event';
import { TOUR_OPEN_START_SESH_EVENT, TOUR_OPEN_DUMMY_SESH_EVENT } from '../onboarding-tour-events';
/* eslint-enable import/first */

// --- Helpers ---------------------------------------------------------------

function wrapper({ children }: { children: React.ReactNode }) {
  return <OnboardingTourProvider>{children}</OnboardingTourProvider>;
}

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Event capture helper: returns a spy that records dispatched event types. */
function captureWindowEvents(types: string[]) {
  const seen: string[] = [];
  const handlers = types.map((t) => {
    const h = () => seen.push(t);
    window.addEventListener(t, h);
    return { t, h };
  });
  return {
    seen,
    cleanup: () => handlers.forEach(({ t, h }) => window.removeEventListener(t, h)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mockUsePathname.mockReturnValue('/');
  mockUseSession.mockReturnValue({ data: null });
  mockOnboardingDb.getTourProgress.mockResolvedValue(null);
  mockOnboardingDb.saveTourProgress.mockResolvedValue(undefined);
  mockOnboardingDb.clearTourProgress.mockResolvedValue(undefined);
  mockOnboardingDb.saveOnboardingStatus.mockResolvedValue(undefined);
});

// --- Tests -----------------------------------------------------------------

describe('OnboardingTourProvider', () => {
  describe('state machine', () => {
    it('starts inactive', async () => {
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();
      expect(result.current.active).toBe(false);
      expect(result.current.currentStepId).toBeNull();
    });

    it('start() enters the first step and fires Started + Step Viewed analytics', async () => {
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();

      act(() => {
        result.current.start();
      });

      expect(result.current.active).toBe(true);
      expect(result.current.currentStepId).toBe('home-intro');
      expect(result.current.stepIndex).toBe(0);

      expect(mockTrack).toHaveBeenCalledWith(
        'Onboarding Tour Started',
        expect.objectContaining({ resumed: false, source: 'home-cta' }),
      );
      expect(mockTrack).toHaveBeenCalledWith(
        'Onboarding Tour Step Viewed',
        expect.objectContaining({ stepId: 'home-intro', stepIndex: 0 }),
      );
    });

    it('next() advances to the following step and fires Step Advanced', async () => {
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();

      act(() => result.current.start());
      mockTrack.mockClear();

      act(() => result.current.next());

      expect(result.current.currentStepId).toBe('home-pick-board');
      expect(mockTrack).toHaveBeenCalledWith(
        'Onboarding Tour Step Advanced',
        expect.objectContaining({ fromStepId: 'home-intro', toStepId: 'home-pick-board', trigger: 'next' }),
      );
    });

    it('skip() clears state, persists completion, and fires Skipped analytics', async () => {
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();
      act(() => result.current.start());

      mockTrack.mockClear();
      act(() => result.current.skip());

      expect(result.current.active).toBe(false);
      expect(result.current.currentStepId).toBeNull();
      expect(mockOnboardingDb.clearTourProgress).toHaveBeenCalled();
      expect(mockOnboardingDb.saveOnboardingStatus).toHaveBeenCalled();
      expect(mockTrack).toHaveBeenCalledWith(
        'Onboarding Tour Skipped',
        expect.objectContaining({ atStepId: 'home-intro' }),
      );
    });

    it('saveTourProgress is called on each step advance', async () => {
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();

      act(() => result.current.start());
      await flushAsync();
      expect(mockOnboardingDb.saveTourProgress).toHaveBeenCalledWith('home-intro', expect.any(String), null);

      act(() => result.current.next());
      await flushAsync();
      expect(mockOnboardingDb.saveTourProgress).toHaveBeenCalledWith('home-pick-board', expect.any(String), null);
    });
  });

  describe('restart behaviour', () => {
    it('start() with an in-flight tour resets to step 1 and clears progress', async () => {
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();

      act(() => result.current.start());
      for (let i = 0; i < 4; i++) act(() => result.current.next()); // now on 'climb-list'
      expect(result.current.currentStepId).toBe('climb-list');

      mockTrack.mockClear();
      mockOnboardingDb.clearTourProgress.mockClear();

      act(() => result.current.start());

      expect(result.current.currentStepId).toBe('home-intro');
      expect(mockTrack).toHaveBeenCalledWith(
        'Onboarding Tour Started',
        expect.objectContaining({ resumed: false, restartedFrom: 'climb-list' }),
      );
      expect(mockOnboardingDb.clearTourProgress).toHaveBeenCalled();
    });
  });

  describe('hydration from IndexedDB', () => {
    it('restores currentStepId from tourProgress on mount', async () => {
      mockOnboardingDb.getTourProgress.mockResolvedValueOnce({
        currentStepId: 'queue-bar',
        startedAt: new Date().toISOString(),
        version: 1,
      });

      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();

      expect(result.current.currentStepId).toBe('queue-bar');
      expect(result.current.active).toBe(true);
    });

    it('ignores tourProgress with a different version', async () => {
      // onboarding-db.getTourProgress itself filters by version; mock returns null here.
      mockOnboardingDb.getTourProgress.mockResolvedValueOnce(null);

      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();

      expect(result.current.currentStepId).toBeNull();
    });
  });

  describe('side effects on step entry', () => {
    it('home-pick-board dispatches TOUR_OPEN_START_SESH_EVENT on enter', async () => {
      const cap = captureWindowEvents([TOUR_OPEN_START_SESH_EVENT]);
      try {
        const { result } = renderHook(useOnboardingTour, { wrapper });
        await flushAsync();
        act(() => result.current.start());
        act(() => result.current.next()); // → home-pick-board
        expect(cap.seen).toContain(TOUR_OPEN_START_SESH_EVENT);
      } finally {
        cap.cleanup();
      }
    });
  });

  describe('notifyQueueLength', () => {
    it('advances queue-add when queue grows from 0 to 1', async () => {
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();

      // Jump straight to 'queue-add' via sequential next() calls.
      act(() => result.current.start());
      for (let i = 0; i < 5; i++) act(() => result.current.next());
      expect(result.current.currentStepId).toBe('queue-add');

      // Initial report of length 0 — no advance
      act(() => result.current.notifyQueueLength(0));
      expect(result.current.currentStepId).toBe('queue-add');

      // Length 1 — advance
      act(() => result.current.notifyQueueLength(1));
      expect(result.current.currentStepId).toBe('queue-bar');
    });

    it('does nothing when queue length changes on an unrelated step', async () => {
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();
      act(() => result.current.start()); // home-intro

      act(() => result.current.notifyQueueLength(5));
      expect(result.current.currentStepId).toBe('home-intro');
    });
  });

  describe('climb-list advance (TOUR_CLIMB_LIST_PICK_EVENT)', () => {
    it('advances on the explicit user-pick event, not on currentClimb changes', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      // Reach climb-list (after home-intro, home-pick-board, and the two
      // grid/list view-mode steps).
      act(() => result.current.start());
      for (let i = 0; i < 4; i++) act(() => result.current.next());
      expect(result.current.currentStepId).toBe('climb-list');

      // A currentClimb change alone (e.g. async queue hydration) must NOT
      // advance climb-list.
      act(() => result.current.notifyCurrentClimb('climb-hydrated'));
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(result.current.currentStepId).toBe('climb-list');

      // Explicit user-pick signal advances after the grace period.
      act(() => {
        window.dispatchEvent(new CustomEvent('onboarding:climb-list-pick'));
      });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current.currentStepId).toBe('queue-add');
      vi.useRealTimers();
    });

    it('ignores pick events when not on climb-list', async () => {
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();
      act(() => result.current.start()); // home-intro

      act(() => {
        window.dispatchEvent(new CustomEvent('onboarding:climb-list-pick'));
      });
      expect(result.current.currentStepId).toBe('home-intro');
    });
  });

  describe('notifyCurrentClimb (queue-bar)', () => {
    it('advances after grace period when a climb is set', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      // Reach queue-bar — fast-forward past earlier auto-advance gates.
      act(() => result.current.start());
      for (let i = 0; i < 6; i++) act(() => result.current.next());
      expect(result.current.currentStepId).toBe('queue-bar');

      act(() => result.current.notifyCurrentClimb('climb-x'));
      expect(result.current.currentStepId).toBe('queue-bar');

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current.currentStepId).toBe('queue-thumbnail');
      vi.useRealTimers();
    });
  });

  describe('notifyViewMode (climb-list grid/list steps)', () => {
    it('advances climb-list-grid-view after grace period when user switches to grid', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      // Reach climb-list-grid-view (home-intro → home-pick-board → climb-list-grid-view).
      act(() => result.current.start());
      for (let i = 0; i < 2; i++) act(() => result.current.next());
      expect(result.current.currentStepId).toBe('climb-list-grid-view');

      // Mount-time notify with the default 'list' mode is a no-op for this step.
      act(() => result.current.notifyViewMode('list'));
      expect(result.current.currentStepId).toBe('climb-list-grid-view');

      // User switches to grid — schedules the grace timer (still within
      // CURRENT_CLIMB_GRACE_MS of step entry, so the advance is deferred).
      act(() => result.current.notifyViewMode('grid'));
      expect(result.current.currentStepId).toBe('climb-list-grid-view');

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current.currentStepId).toBe('climb-list-back-to-list');
      vi.useRealTimers();
    });

    it('advances climb-list-back-to-list after grace period when user switches back to list', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      // Reach climb-list-back-to-list.
      act(() => result.current.start());
      for (let i = 0; i < 3; i++) act(() => result.current.next());
      expect(result.current.currentStepId).toBe('climb-list-back-to-list');

      act(() => result.current.notifyViewMode('list'));
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current.currentStepId).toBe('climb-list');
      vi.useRealTimers();
    });

    it('debounces rapid view-mode toggles into a single advance per transition', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      act(() => result.current.start());
      for (let i = 0; i < 2; i++) act(() => result.current.next());
      expect(result.current.currentStepId).toBe('climb-list-grid-view');

      // User toggles back and forth rapidly — only the final 'grid' notify
      // should result in an advance, and only once.
      act(() => {
        result.current.notifyViewMode('grid');
        result.current.notifyViewMode('list'); // no-op for this step
        result.current.notifyViewMode('grid');
      });

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current.currentStepId).toBe('climb-list-back-to-list');

      // Further notifies on the new step's unrelated mode are no-ops.
      act(() => result.current.notifyViewMode('grid'));
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current.currentStepId).toBe('climb-list-back-to-list');
      vi.useRealTimers();
    });

    it('cancels a pending grid-view advance when user toggles back to list before grace elapses', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      act(() => result.current.start());
      for (let i = 0; i < 2; i++) act(() => result.current.next());
      expect(result.current.currentStepId).toBe('climb-list-grid-view');

      // User taps grid → schedules advance timer.
      act(() => result.current.notifyViewMode('grid'));

      // User changes their mind and toggles back to list before the grace
      // window elapses — the pending advance must be dropped so the tour
      // doesn't skip ahead based on the stale "switched to grid" intent.
      act(() => result.current.notifyViewMode('list'));

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current.currentStepId).toBe('climb-list-grid-view');
      vi.useRealTimers();
    });

    it('is a no-op on unrelated steps', async () => {
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();
      act(() => result.current.start()); // home-intro

      act(() => result.current.notifyViewMode('grid'));
      act(() => result.current.notifyViewMode('list'));
      expect(result.current.currentStepId).toBe('home-intro');
    });
  });

  describe('pathname change advance', () => {
    it('home-pick-board auto-advances to climb-list when the path matches a board list route', async () => {
      const { result, rerender } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();
      act(() => result.current.start()); // home-intro
      act(() => result.current.next()); // home-pick-board
      expect(result.current.currentStepId).toBe('home-pick-board');

      // Simulate router navigation into a board-list route.
      mockUsePathname.mockReturnValue('/kilter/10/5/1,2/40/list');
      rerender();
      await flushAsync();

      expect(result.current.currentStepId).toBe('climb-list-grid-view');
    });
  });

  describe('PLAY_DRAWER_EVENT advance', () => {
    it('queue-thumbnail advances to play-view when the play drawer opens', async () => {
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();
      act(() => result.current.start());
      for (let i = 0; i < 7; i++) act(() => result.current.next());
      expect(result.current.currentStepId).toBe('queue-thumbnail');

      act(() => {
        window.dispatchEvent(new CustomEvent(PLAY_DRAWER_EVENT));
      });

      expect(result.current.currentStepId).toBe('play-view');
    });
  });

  describe('complete() from final step', () => {
    it('next() on the final step fires Completed and clears progress', async () => {
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await flushAsync();
      act(() => result.current.start());
      // Advance until we're on sesh-analytics
      // 0=home-intro, 1=home-pick-board, ..., last=sesh-analytics
      while (result.current.currentStepId !== 'sesh-analytics') {
        act(() => result.current.next());
      }

      mockTrack.mockClear();
      mockOnboardingDb.clearTourProgress.mockClear();
      mockOnboardingDb.saveOnboardingStatus.mockClear();

      act(() => result.current.next());

      expect(result.current.active).toBe(false);
      expect(result.current.currentStepId).toBeNull();
      expect(mockTrack).toHaveBeenCalledWith(
        'Onboarding Tour Completed',
        expect.objectContaining({ durationSeconds: expect.any(Number) }),
      );
      expect(mockOnboardingDb.clearTourProgress).toHaveBeenCalled();
      expect(mockOnboardingDb.saveOnboardingStatus).toHaveBeenCalled();
    });

    it('sesh-analytics onExit fires close-dummy-sesh when completing', async () => {
      const cap = captureWindowEvents(['onboarding:close-dummy-sesh']);
      try {
        const { result } = renderHook(useOnboardingTour, { wrapper });
        await flushAsync();
        act(() => result.current.start());
        while (result.current.currentStepId !== 'sesh-analytics') {
          act(() => result.current.next());
        }
        cap.seen.length = 0;
        act(() => result.current.next()); // complete
        expect(cap.seen).toContain('onboarding:close-dummy-sesh');
      } finally {
        cap.cleanup();
      }
    });
  });

  describe('sesh-invite opens the dummy drawer on enter', () => {
    it('dispatches TOUR_OPEN_DUMMY_SESH_EVENT', async () => {
      const cap = captureWindowEvents([TOUR_OPEN_DUMMY_SESH_EVENT]);
      try {
        const { result } = renderHook(useOnboardingTour, { wrapper });
        await flushAsync();
        act(() => result.current.start());
        while (result.current.currentStepId !== 'sesh-invite') {
          act(() => result.current.next());
        }
        expect(cap.seen).toContain(TOUR_OPEN_DUMMY_SESH_EVENT);
      } finally {
        cap.cleanup();
      }
    });
  });

  describe('grace-period timer lifecycle', () => {
    it('skip() while a grace-period timer is in flight does not resurrect the tour', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      // Reach climb-list.
      act(() => result.current.start());
      for (let i = 0; i < 4; i++) act(() => result.current.next());
      expect(result.current.currentStepId).toBe('climb-list');

      // Fire a user-pick event — schedules a grace timer but don't let it elapse.
      act(() => {
        window.dispatchEvent(new CustomEvent('onboarding:climb-list-pick'));
      });
      expect(result.current.currentStepId).toBe('climb-list');

      // User hits Skip.
      act(() => result.current.skip());
      expect(result.current.active).toBe(false);

      // Let the scheduled timer fire. It must not re-activate the tour.
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(result.current.active).toBe(false);
      expect(result.current.currentStepId).toBeNull();
      vi.useRealTimers();
    });

    it('complete() also cancels any in-flight grace timer', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      // Reach queue-bar; setting a current climb schedules the grace timer.
      act(() => result.current.start());
      for (let i = 0; i < 6; i++) act(() => result.current.next());
      expect(result.current.currentStepId).toBe('queue-bar');
      act(() => result.current.notifyCurrentClimb('climb-x'));

      // Complete before the grace elapses.
      act(() => result.current.complete());
      expect(result.current.active).toBe(false);

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(result.current.active).toBe(false);
      expect(result.current.currentStepId).toBeNull();
      vi.useRealTimers();
    });

    it('rapid climb-list pick events advance only once per step transition', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(useOnboardingTour, { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      act(() => result.current.start());
      for (let i = 0; i < 4; i++) act(() => result.current.next());
      expect(result.current.currentStepId).toBe('climb-list');

      // Pile up pick events before grace elapses. Provider should debounce
      // them onto a single advance.
      act(() => {
        window.dispatchEvent(new CustomEvent('onboarding:climb-list-pick'));
        window.dispatchEvent(new CustomEvent('onboarding:climb-list-pick'));
        window.dispatchEvent(new CustomEvent('onboarding:climb-list-pick'));
      });

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current.currentStepId).toBe('queue-add');

      // Further picks after leaving climb-list are a no-op — the listener
      // guards on the live step.
      act(() => {
        window.dispatchEvent(new CustomEvent('onboarding:climb-list-pick'));
      });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current.currentStepId).toBe('queue-add');
      vi.useRealTimers();
    });
  });
});

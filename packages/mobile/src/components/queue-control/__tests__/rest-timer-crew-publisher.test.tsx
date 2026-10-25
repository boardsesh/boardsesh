// @vitest-environment jsdom
//
// RestTimerCrewPublisher's wiring (#5382): what it hooks up while a session is
// live and tears down after. What it sends, and when, is pinned in
// lib/__tests__/crew-rest-publisher.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';

const harness = vi.hoisted(() => ({
  sessionId: 'session-1' as string | null,
  participantId: 'participant-me' as string | null,
  currentQueueItemUuid: 'queue-current',
  nowMs: Date.parse('2026-10-24T10:00:00.000Z'),
  settings: {} as Record<string, unknown>,
  sent: [] as Array<Record<string, unknown>>,
  isCrewSession: false,
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: harness.sessionId }),
  useQueueSessionControls: () => ({ participantId: harness.participantId }),
  useIsCrewSession: () => harness.isCrewSession,
  useQueueActions: () => ({
    getQueueSnapshot: () => ({ currentClimbQueueItem: { uuid: harness.currentQueueItemUuid } }),
    setSessionRestCadence: async (input: Record<string, unknown>) => {
      harness.sent.push(input);
      return null;
    },
  }),
}));

vi.mock('../../../settings', () => ({
  useSetting: (key: string) => [harness.settings[key], vi.fn()],
  getSetting: (key: string) => harness.settings[key],
}));
vi.mock('../../../lib/clock', () => ({ nowMs: () => harness.nowMs }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));

import {
  editCrewRestPacing,
  handleCrewCadenceChange,
  getLastCrewCadenceSnapshot,
  resetCrewCadenceForTests,
} from '../../../lib/crew-rest-cadence';
import { CREW_CONFIGURE_DEBOUNCE_MS } from '../../../lib/crew-rest-publisher';
import {
  adoptCrewCadence,
  armRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  resetRestTimerStoreForTests,
} from '../../../lib/rest-timer-store';
import { getServerClockOffsetMs, noteServerTimeFromEvent, resetServerClock } from '../../../lib/server-clock';
import { RestTimerCrewPublisher } from '../RestTimerCrewPublisher';

const T0 = harness.nowMs;

async function flush() {
  await act(async () => {
    for (let round = 0; round < 10; round++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRestTimerStoreForTests();
  resetCrewCadenceForTests();
  resetServerClock();
  harness.sessionId = 'session-1';
  harness.participantId = 'participant-me';
  harness.currentQueueItemUuid = 'queue-current';
  harness.sent = [];
  harness.isCrewSession = false;
  harness.settings = { restTimerTargetSeconds: 60, restTimerMode: 'afterTick', restTimerAutoAdvance: true };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RestTimerCrewPublisher', () => {
  it('renders nothing and sends nothing without a session', async () => {
    harness.sessionId = null;
    const { container } = render(<RestTimerCrewPublisher />);
    armRestTimer('afterTick', T0, null);
    await flush();
    expect(container.innerHTML).toBe('');
    expect(harness.sent).toEqual([]);
  });

  it('sends this phone’s actions in the session', async () => {
    render(<RestTimerCrewPublisher />);
    armRestTimer('afterTick', T0, 'session-1');
    await flush();
    expect(harness.sent.map((input) => input.action)).toEqual(['ARM']);
  });

  it('sends a settings edit once it settles, but not the settings it mounted with', async () => {
    const { rerender } = render(<RestTimerCrewPublisher />);
    armRestTimer('afterTick', T0, 'session-1');
    await flush();
    harness.sent = [];
    act(() => {
      vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    });
    await flush();
    expect(harness.sent).toEqual([]);

    harness.settings = { ...harness.settings, restTimerTargetSeconds: 150 };
    rerender(<RestTimerCrewPublisher />);
    act(() => {
      vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    });
    await flush();
    expect(harness.sent).toEqual([
      {
        action: 'CONFIGURE',
        config: { mode: 'afterTick', targetSeconds: 150, autoAdvance: true, advanceOn: 'deadline', source: 'settings' },
        anchor: 'KEEP',
      },
    ]);
  });

  it('sends no settings edit in a crew: the shared clock changes only from the timer’s controls', async () => {
    harness.isCrewSession = true;
    const { rerender } = render(<RestTimerCrewPublisher />);
    armRestTimer('afterTick', T0, 'session-1');
    await flush();
    harness.sent = [];

    harness.settings = { ...harness.settings, restTimerTargetSeconds: 150, restTimerMode: 'onTheMinute' };
    rerender(<RestTimerCrewPublisher />);
    act(() => {
      vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    });
    await flush();
    expect(harness.sent).toEqual([]);
  });

  it('sends a crew pacing edit at once with only that change, and lets the draft go on the answer', async () => {
    harness.isCrewSession = true;
    render(<RestTimerCrewPublisher />);
    adoptCrewCadence({
      sessionId: 'session-1',
      revision: 7,
      config: {
        mode: 'afterTick',
        targetSeconds: 120,
        autoAdvance: true,
        advanceOn: 'send',
        source: 'stage',
        setByParticipantId: 'participant-sam',
      },
      isRunning: true,
      anchorMs: T0,
      pausedElapsedSeconds: 0,
      lastFiredBeatMs: null,
      lastTick: null,
      anchorServerMs: T0,
      lastFiredBeatServerMs: null,
    });
    harness.sent = [];

    expect(editCrewRestPacing({ targetSeconds: 150 })).toBe(true);
    expect(getRestTimerState().crewPacingDraft?.targetSeconds).toBe(150);
    await flush();
    expect(harness.sent).toEqual([
      {
        action: 'CONFIGURE',
        config: { mode: 'afterTick', targetSeconds: 150, autoAdvance: true, advanceOn: 'send', source: 'settings' },
        anchor: 'KEEP',
      },
    ]);
    // The send got no answer here (no session reply), so the draft goes and the controls show the crew's again.
    expect(getRestTimerState().crewPacingDraft).toBeNull();
  });

  it('arms the server from the seed for a timer armed before the session', async () => {
    armRestTimer('onTheMinute', T0, 'session-1');
    render(<RestTimerCrewPublisher />);
    harness.sent = [];
    act(() => {
      handleCrewCadenceChange(
        { restCadence: null, revision: 0, serverNow: String(T0), isSnapshot: true, action: null },
        { sessionId: 'session-1', ownParticipantId: 'participant-me', receivedAtMs: T0 },
      );
    });
    await flush();
    expect(harness.sent.map((input) => input.action)).toEqual(['ARM']);
  });

  it('reads the climb on the wall for a crew clock’s tick rule', () => {
    render(<RestTimerCrewPublisher />);
    adoptCrewCadence({
      sessionId: 'session-1',
      revision: 2,
      config: {
        mode: 'afterTick',
        targetSeconds: 60,
        autoAdvance: true,
        advanceOn: 'tick',
        source: 'stage',
        setByParticipantId: 'participant-sam',
      },
      isRunning: true,
      anchorMs: T0,
      pausedElapsedSeconds: 0,
      lastFiredBeatMs: null,
      lastTick: { status: 'send', queueItemUuid: 'queue-current' },
      anchorServerMs: T0,
      lastFiredBeatServerMs: null,
    });
    act(() => {
      noteRestTimerTick(new Date(T0).toISOString(), 'afterTick', T0 + 1_000, {
        status: 'attempt',
        queueItemUuid: 'queue-previous',
      });
    });
    expect(getRestTimerState().lastTick).toEqual({ status: 'send', queueItemUuid: 'queue-current' });
  });

  it('forgets the session’s seed, floor and clock samples when the session goes', () => {
    const { rerender } = render(<RestTimerCrewPublisher />);
    act(() => {
      handleCrewCadenceChange(
        { restCadence: null, revision: 0, serverNow: String(T0), isSnapshot: true, action: null },
        { sessionId: 'session-1', ownParticipantId: 'participant-me', receivedAtMs: T0 },
      );
      noteServerTimeFromEvent({ serverNowMs: T0 + 1_000, receivedAtMs: T0 });
    });
    expect(getLastCrewCadenceSnapshot()).not.toBeNull();
    harness.sessionId = null;
    rerender(<RestTimerCrewPublisher />);
    expect(getLastCrewCadenceSnapshot()).toBeNull();
    expect(getServerClockOffsetMs()).toBeNull();
  });

  it('lets go of a crew clock this app cannot run when the session goes', () => {
    const { rerender } = render(<RestTimerCrewPublisher />);
    act(() => {
      handleCrewCadenceChange(
        {
          restCadence: {
            mode: 'everyOtherMinute',
            targetSeconds: 60,
            autoAdvance: true,
            advanceOn: 'deadline',
            source: 'settings',
            isRunning: true,
            anchorAt: String(T0),
            pausedElapsedSeconds: 0,
            setByParticipantId: 'participant-sam',
          },
          revision: 3,
          serverNow: String(T0),
          isSnapshot: true,
          action: null,
        },
        { sessionId: 'session-1', ownParticipantId: 'participant-me', receivedAtMs: T0 },
      );
    });
    // Held on an unarmed phone: the "needs a newer version" note reads it.
    expect(getRestTimerState().crew?.config).toBeNull();
    expect(getRestTimerState().armed).toBe(false);
    harness.sessionId = null;
    rerender(<RestTimerCrewPublisher />);
    expect(getRestTimerState().crew).toBeNull();
  });
});

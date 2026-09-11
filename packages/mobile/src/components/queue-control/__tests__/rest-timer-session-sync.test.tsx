// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

let sessionId: string | null = null;
let userId: string | undefined = 'me';
let sessionDetail: { ticks: { userId: string; climbedAt: string }[] } | undefined;
let currentNowMs = Date.parse('2026-09-11T10:00:00.000Z');

vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId }),
}));

vi.mock('../../../lib/graphql/hooks/use-session-detail', () => ({
  useSessionDetail: () => ({ data: sessionDetail }),
}));

vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId, isLoading: false }),
}));

vi.mock('../../../settings', () => ({ getSetting: () => 'afterTick' }));

vi.mock('../../../lib/clock', () => ({ nowMs: () => currentNowMs }));

import {
  armRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  resetRestTimerStoreForTests,
} from '../../../lib/rest-timer-store';
import { RestTimerSessionSync } from '../RestTimerSessionSync';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');

beforeEach(() => {
  resetRestTimerStoreForTests();
  sessionId = null;
  userId = 'me';
  sessionDetail = undefined;
  currentNowMs = T0;
});

describe('binding an arm to a session', () => {
  it('carries a pre-session arm into the session that starts', () => {
    armRestTimer('afterTick', T0, null);
    const { rerender } = render(<RestTimerSessionSync />);
    expect(getRestTimerState().armedForSessionId).toBeNull();

    sessionId = 'session-1';
    rerender(<RestTimerSessionSync />);
    expect(getRestTimerState().armedForSessionId).toBe('session-1');
  });

  it('disarms when the session ends', () => {
    armRestTimer('afterTick', T0, 'session-1');
    const { rerender } = render(<RestTimerSessionSync />);

    sessionId = null;
    rerender(<RestTimerSessionSync />);
    expect(getRestTimerState().armed).toBe(false);
  });

  it('disarms when the climber joins a different session', () => {
    sessionId = 'session-1';
    armRestTimer('afterTick', T0, 'session-1');
    const { rerender } = render(<RestTimerSessionSync />);

    sessionId = 'session-2';
    rerender(<RestTimerSessionSync />);
    expect(getRestTimerState().armed).toBe(false);
  });

  it('leaves a solo pre-session arm alone rather than tearing it down', () => {
    armRestTimer('afterTick', T0, null);
    render(<RestTimerSessionSync />);
    expect(getRestTimerState().armed).toBe(true);
  });
});

describe('cold-start hydration', () => {
  it('anchors on the climber own latest session tick', () => {
    sessionId = 'session-1';
    sessionDetail = { ticks: [{ userId: 'me', climbedAt: '2026-09-11T09:59:30.000Z' }] };
    armRestTimer('afterTick', T0, 'session-1');

    render(<RestTimerSessionSync />);
    expect(getRestTimerState().anchorMs).toBe(Date.parse('2026-09-11T09:59:30.000Z'));
  });

  it('ignores a crew-mate tick, so their send cannot restart your rest', () => {
    sessionId = 'session-1';
    sessionDetail = { ticks: [{ userId: 'crew-mate', climbedAt: '2026-09-11T09:59:30.000Z' }] };
    armRestTimer('afterTick', T0, 'session-1');

    render(<RestTimerSessionSync />);
    expect(getRestTimerState().anchorMs).toBeNull();
  });

  it('never lets a stale server read rewind a live local anchor', () => {
    sessionId = 'session-1';
    sessionDetail = { ticks: [{ userId: 'me', climbedAt: '2026-09-11T09:50:00.000Z' }] };
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick('2026-09-11T09:59:50.000Z', 'afterTick', T0);

    render(<RestTimerSessionSync />);
    expect(getRestTimerState().anchorMs).toBe(Date.parse('2026-09-11T09:59:50.000Z'));
  });

  it('does nothing while disarmed', () => {
    sessionId = 'session-1';
    sessionDetail = { ticks: [{ userId: 'me', climbedAt: '2026-09-11T09:59:30.000Z' }] };

    render(<RestTimerSessionSync />);
    expect(getRestTimerState().anchorMs).toBeNull();
  });
});

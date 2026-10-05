import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../analytics', () => ({ track: analytics.track }));

import {
  isSessionPreviewEnded,
  joinScreenDeadEnd,
  trackSessionJoinOutcome,
  type JoinScreenState,
} from '../session-join-analytics';
import type { JoinSessionPreview } from '../graphql/hooks/use-session-detail';

function session(overrides: Partial<JoinSessionPreview> = {}): JoinSessionPreview {
  return {
    id: 'session-1',
    name: null,
    boardPath: 'kilter/1/10/1,20/40',
    color: null,
    goal: null,
    isPublic: true,
    startedAt: null,
    endedAt: null,
    users: [],
    ...overrides,
  };
}

function state(overrides: Partial<JoinScreenState> = {}): JoinScreenState {
  return { isAuthenticated: true, isLoading: false, isError: false, session: session(), ...overrides };
}

beforeEach(() => {
  analytics.track.mockClear();
});

describe('joinScreenDeadEnd', () => {
  it('is null for a session that can be joined', () => {
    expect(joinScreenDeadEnd(state())).toBeNull();
  });

  it('is null for a dormant session: it is joinable, not missing', () => {
    expect(
      joinScreenDeadEnd(state({ session: session({ invite: { state: 'dormant', hostName: 'Alex' } }) })),
    ).toBeNull();
  });

  it('is null while the invite is still loading', () => {
    expect(joinScreenDeadEnd(state({ isLoading: true, session: undefined }))).toBeNull();
  });

  it('is sign_in_needed for a signed-out climber, whatever else is true', () => {
    expect(joinScreenDeadEnd(state({ isAuthenticated: false }))).toBe('sign_in_needed');
    expect(joinScreenDeadEnd(state({ isAuthenticated: false, isLoading: true }))).toBe('sign_in_needed');
    expect(joinScreenDeadEnd(state({ isAuthenticated: false, isError: true }))).toBe('sign_in_needed');
  });

  it('is error when the invite failed to load', () => {
    expect(joinScreenDeadEnd(state({ isError: true, session: undefined }))).toBe('error');
  });

  it('is not_found when neither query knows the session', () => {
    expect(joinScreenDeadEnd(state({ session: null }))).toBe('not_found');
  });

  it('is ended by the timestamp or by the invite preview', () => {
    expect(joinScreenDeadEnd(state({ session: session({ endedAt: '2026-10-05T10:00:00Z' }) }))).toBe('ended');
    expect(joinScreenDeadEnd(state({ session: session({ invite: { state: 'ended', hostName: null } }) }))).toBe(
      'ended',
    );
  });
});

describe('isSessionPreviewEnded', () => {
  it('is false for a running session, connected or not', () => {
    expect(isSessionPreviewEnded(session())).toBe(false);
    expect(isSessionPreviewEnded(session({ invite: { state: 'dormant', hostName: null } }))).toBe(false);
  });
});

describe('trackSessionJoinOutcome', () => {
  it('sends the outcome with the session and the stage it stopped at', () => {
    trackSessionJoinOutcome('session-1', 'error', 'join');

    expect(analytics.track).toHaveBeenCalledWith('Session Join Outcome', {
      sessionId: 'session-1',
      outcome: 'error',
      stage: 'join',
    });
  });
});

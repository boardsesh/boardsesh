import { describe, expect, it } from 'vitest';
import {
  climbStatuses,
  endSession,
  formatElapsed,
  isSession,
  startSession,
  summarizeSession,
  withServerUuid,
  withTick,
  withoutTick,
  type SessionTick,
} from './session';

const start = new Date('2026-09-29T18:00:00Z');

function tick(overrides: Partial<SessionTick>): SessionTick {
  return {
    id: 'tick-1',
    serverUuid: null,
    climbUuid: 'climb-1',
    climbName: 'Pinch me',
    difficultyId: 18,
    status: 'send',
    attempts: 2,
    loggedAt: '2026-09-29T18:10:00Z',
    ...overrides,
  };
}

describe('session', () => {
  const empty = startSession({ id: 'session-1', now: start, boardLabel: 'MoonBoard 2016', angle: 40 });

  it('summarises sends, flashes, attempts and the hardest send', () => {
    let session = withTick(empty, tick({ id: 'a', status: 'flash', attempts: 1, difficultyId: 17 }));
    session = withTick(session, tick({ id: 'b', status: 'send', attempts: 4, difficultyId: 20 }));
    session = withTick(
      session,
      tick({ id: 'c', climbUuid: 'climb-2', status: 'attempt', attempts: 6, difficultyId: 24 }),
    );

    const summary = summarizeSession(session, new Date('2026-09-29T19:30:00Z'));
    expect(summary).toEqual({
      durationMs: 90 * 60 * 1000,
      sends: 2,
      flashes: 1,
      attempts: 11,
      climbs: 2,
      // The 7b attempt was never sent, so it doesn't count.
      hardestSendDifficultyId: 20,
    });
  });

  it('keeps a send as the climb status when attempts come after it', () => {
    const statuses = climbStatuses([
      tick({ id: 'a', status: 'attempt' }),
      tick({ id: 'b', status: 'send' }),
      tick({ id: 'c', status: 'attempt' }),
      tick({ id: 'd', climbUuid: 'climb-2', status: 'attempt' }),
    ]);
    expect(statuses.get('climb-1')).toBe('send');
    expect(statuses.get('climb-2')).toBe('attempt');
    expect(statuses.has('climb-3')).toBe(false);
  });

  it('stops the clock when the session ends', () => {
    const ended = endSession(empty, new Date('2026-09-29T18:45:00Z'));
    expect(summarizeSession(ended, new Date('2026-09-29T23:00:00Z')).durationMs).toBe(45 * 60 * 1000);
    // Ending twice keeps the first end time.
    expect(endSession(ended, new Date('2026-09-29T20:00:00Z')).endedAt).toBe(ended.endedAt);
  });

  it('removes a tick and records the saved uuid', () => {
    const session = withTick(withTick(empty, tick({ id: 'a' })), tick({ id: 'b' }));
    expect(withoutTick(session, 'a').ticks.map((entry) => entry.id)).toEqual(['b']);
    expect(withServerUuid(session, 'b', 'server-b').ticks[1].serverUuid).toBe('server-b');
  });

  it('only restores well-formed stored sessions', () => {
    expect(isSession(withTick(empty, tick({})))).toBe(true);
    expect(isSession({ ...empty, ticks: [{ ...tick({}), status: 'topped' }] })).toBe(false);
    expect(isSession(null)).toBe(false);
  });

  it('formats the session clock', () => {
    expect(formatElapsed(247_000)).toBe('4:07');
    expect(formatElapsed(3_909_000)).toBe('1:05:09');
    expect(formatElapsed(0)).toBe('0:00');
  });
});

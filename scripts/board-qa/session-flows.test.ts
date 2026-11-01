import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFlow } from './drivers';
import { selectorPredicate } from '../lib/mobile-profile-wda';

const sessionId = '11111111-2222-4333-8444-555555555555';
const variables = {
  APP_ID: 'com.boardsesh.app',
  RECORD_URL: 'com.boardsesh.app://record',
  SESSION_URL: `com.boardsesh.app://join/${sessionId}`,
  SESSION_ID: sessionId,
  EXPECTED_ROSTER_COUNT: '2',
  USER_ID: 'qa-user',
  SESSION_EXIT_LABEL: 'End session',
};
const flow = (name: string) => readFlow(resolve(`packages/mobile/.maestro/board-qa/${name}.yaml`), variables);

describe('visible session leaf flow contracts', () => {
  it('starts with the real Start control and waits for the visible one-climber session leaf', () => {
    const commands = flow('start-session');
    expect(commands).toContainEqual({ tapOn: { id: 'session-start' } });
    expect(commands.at(-1)).toEqual({
      extendedWaitUntil: { visible: { id: 'session-presence-[0-9a-fA-F-]{36}-1' }, timeout: 30000 },
    });
  });
  it('requires the exact invited session and two-climber count after the real Join confirmation', () => {
    const commands = flow('join-session');
    expect(commands).toContainEqual({ tapOn: { id: 'session-join-confirm' } });
    expect(commands.at(-1)).toEqual({
      extendedWaitUntil: { visible: { id: `session-presence-${sessionId}-2` }, timeout: 30000 },
    });
  });
  it('binds the visible roster count to the exact session while retaining the native user identity/state check', () => {
    expect(flow('open-roster')).toEqual([
      { openLink: variables.RECORD_URL },
      { extendedWaitUntil: { visible: { id: `session-presence-${sessionId}-2` }, timeout: 30000 } },
      { assertVisible: { id: 'session-user-qa-user-CONNECTED' } },
    ]);
    const exact = new RegExp(`^session-presence-${sessionId}-2$`);
    expect(exact.test(`session-presence-${sessionId}-1`)).toBe(false);
    expect(exact.test('session-presence-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee-2')).toBe(false);
  });
  it.each(['leave-session', 'end-session'])('keeps the %s visible binding and real exit controls', (name) => {
    const commands = flow(name);
    expect(commands[1]).toEqual({
      extendedWaitUntil: { visible: { id: `session-presence-${sessionId}-[1-9][0-9]*` }, timeout: 30000 },
    });
    expect(commands[2]).toEqual({ tapOn: variables.SESSION_EXIT_LABEL });
    expect(commands).toContainEqual({ tapOn: { id: 'sheet-top-bar-trailing' } });
    expect(commands.at(-1)).toEqual({ extendedWaitUntil: { visible: { id: 'session-start' }, timeout: 30000 } });
    if (name === 'end-session')
      expect(commands).toContainEqual({
        extendedWaitUntil: { notVisible: { id: `session-presence-${sessionId}-[1-9][0-9]*` }, timeout: 30000 },
      });
  });
  it('keeps the global native visibility predicate and never asks metadata containers to prove visible session UI', () => {
    for (const name of ['start-session', 'join-session', 'open-roster', 'leave-session', 'end-session']) {
      const serialized = JSON.stringify(flow(name));
      expect(serialized).not.toContain('session-active-');
      expect(serialized).not.toContain('session-roster-');
      expect(serialized).toContain('session-presence-');
    }
    expect(selectorPredicate({ id: `session-presence-${sessionId}-2` })).toContain('visible == 1');
  });
});

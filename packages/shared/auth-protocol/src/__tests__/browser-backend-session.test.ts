import { describe, expect, it } from 'vitest';
import { readBrowserBackendSessionScope, browserBackendSessionKey } from '../browser-backend-session';

function session() {
  return {
    user: { id: 'owned-user', email: 'owned@example.test', name: 'Owned climber' },
    expires: '2026-11-14T00:00:00.000Z',
    authSessionId: 'owned-login',
    authGeneration: 0,
    browserSelection: {
      userId: 'owned-user',
      authSessionId: 'owned-login',
      generation: 0,
      cursor: { bindingId: 'a'.repeat(64), version: 1 },
    },
  };
}
describe('public selected session scope', () => {
  it('captures exact public identity and nested cursor without retaining profile data', () => {
    const response = session();
    const scope = readBrowserBackendSessionScope(response);
    expect(scope).toEqual({ status: 'selected', owner: response.browserSelection });
    if (scope.status !== 'selected') throw new Error('Owned scope missing');
    response.browserSelection.cursor.version = 7;
    expect(scope.owner.cursor.version).toBe(1);
    expect(Object.isFrozen(scope.owner.cursor)).toBe(true);
    expect(JSON.stringify(scope)).not.toContain('owned@example.test');
  });
  it.each(['UID', 'SID', 'generation', 'private-cursor', 'missing-expiry'] as const)(
    'refuses a malformed or mismatched %s instead of classifying it as legacy',
    (change) => {
      const response = session();
      if (change === 'UID') response.user.id = 'other-user';
      if (change === 'SID') response.authSessionId = 'other-login';
      if (change === 'generation') response.authGeneration += 1;
      if (change === 'private-cursor')
        Object.assign(response.browserSelection.cursor, { bindingExpiresAt: response.expires });
      if (change === 'missing-expiry') response.expires = '';
      expect(readBrowserBackendSessionScope(response)).toEqual({ status: 'invalid' });
    },
  );
  it.each([undefined, false, null, {}, { cursor: { version: 1 } }])(
    'never falls through on present invalid selection metadata %j',
    (browserSelection) => {
      expect(readBrowserBackendSessionScope({ ...session(), browserSelection })).toEqual({ status: 'invalid' });
    },
  );
  it('retains the exact legacy/anonymous signals and refuses nonobjects', () => {
    expect(readBrowserBackendSessionScope({ user: { id: 'owned-user' } })).toEqual({ status: 'legacy' });
    expect(readBrowserBackendSessionScope({})).toEqual({ status: 'anonymous' });
    expect(readBrowserBackendSessionScope(null)).toEqual({ status: 'anonymous' });
    for (const invalid of [undefined, 'session', 1, []])
      expect(readBrowserBackendSessionScope(invalid)).toEqual({ status: 'invalid' });
  });
  it('keys every identity dimension without separator collisions', () => {
    const original = session().browserSelection;
    const key = browserBackendSessionKey(original);
    for (const changed of [
      { ...original, userId: 'owned-user:other' },
      { ...original, authSessionId: 'owned-login:other' },
      { ...original, generation: 1 },
      { ...original, cursor: { ...original.cursor, version: 2 } },
      { ...original, cursor: { ...original.cursor, bindingId: 'b'.repeat(64) } },
    ])
      expect(browserBackendSessionKey(changed)).not.toBe(key);
    expect(browserBackendSessionKey({ ...original, cursor: { ...original.cursor } })).toBe(key);
  });
});

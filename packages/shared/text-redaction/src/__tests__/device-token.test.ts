import { describe, expect, it } from 'vite-plus/test';
import { redactPasswordRecoveryUrls, scrubPasswordRecoveryEvent } from '../password-recovery';

// The native sign-in device token (#7656): `deviceToken` in a reply body and
// `x-boardsesh-device-token` on the credentials request. Shaped like a real v1
// token so the free-text pattern is exercised too.
const deviceToken = `v1.${'A'.repeat(22)}.1763424000.${'b'.repeat(43)}`;

describe('device token redaction', () => {
  it('redacts the reply field and the request header in structured events', () => {
    const event = {
      request: { headers: { 'X-Boardsesh-Device-Token': deviceToken, accept: 'application/json' } },
      contexts: { reply: { deviceToken, userId: 'user-1' } },
      breadcrumbs: [{ data: { headerPairs: [['x-boardsesh-device-token', deviceToken]] } }],
      named: { name: 'x-boardsesh-device-token', value: deviceToken },
    };
    const result = scrubPasswordRecoveryEvent(event);
    expect(JSON.stringify(result)).not.toContain(deviceToken);
    expect(result.request.headers.accept).toBe('application/json');
    expect(result.contexts.reply.userId).toBe('user-1');
    // The input is never mutated.
    expect(event.contexts.reply.deviceToken).toBe(deviceToken);
  });

  it('redacts a serialized reply body and free-text mentions', () => {
    const event = {
      serialized: JSON.stringify({ jwt: 'j', deviceToken }),
      message: `sent x-boardsesh-device-token: ${deviceToken} to backend`,
      bare: `token was ${deviceToken}.`,
      unknownShape: 'deviceToken=opaque-future-value',
    };
    const result = scrubPasswordRecoveryEvent(event);
    expect(JSON.stringify(result)).not.toContain(deviceToken);
    expect(result.unknownShape).not.toContain('opaque-future-value');
    expect(JSON.parse(result.serialized)).toEqual({ jwt: 'j', deviceToken: '[redacted]' });
  });

  it.each([
    [
      'https://www.boardsesh.com/auth/reset-password?token=private-capability',
      'https://www.boardsesh.com/auth/reset-password?[redacted]',
    ],
    [`device ${deviceToken}`, 'device [redacted]'],
    ['private pr1_capability', 'private [redacted]'],
  ])('redacts credentials when a serialized map uses a secret-bearing key %s', (key, redactedKey) => {
    const serialized = JSON.stringify({ [key]: { password: 'private-password' }, safe: 'keep' });

    const result = scrubPasswordRecoveryEvent({ serialized });

    expect(JSON.parse(result.serialized)).toEqual({
      [redactedKey]: { password: '[redacted]' },
      safe: 'keep',
    });
    expect(result.serialized).not.toContain('private-capability');
    expect(result.serialized).not.toContain('private-password');
    expect(result.serialized).not.toContain(deviceToken);
    expect(JSON.parse(serialized)[key]).toEqual({ password: 'private-password' });
  });

  it('leaves text without a device token byte-for-byte unchanged', () => {
    const text = 'v1.short.123.abc and a device that is not a token';
    expect(redactPasswordRecoveryUrls(text)).toBe(text);
    const event = { message: 'Signed in', request: { headers: { 'x-boardsesh-client': 'ios' } } };
    expect(scrubPasswordRecoveryEvent(event)).toBe(event);
  });

  it.each([null, 42, false, ['unexpected'], { nested: 'unexpected' }])(
    'redacts sibling credentials before handling a malformed device token %j',
    (malformedToken) => {
      const event = {
        serialized: JSON.stringify({
          deviceToken: malformedToken,
          password: 'private-password',
          token: 'private-token',
        }),
        headers: JSON.stringify({ 'x-boardsesh-device-token': malformedToken, password: 'private-password' }),
      };

      const result = scrubPasswordRecoveryEvent(event);

      expect(JSON.stringify(result)).not.toContain('private-password');
      expect(JSON.stringify(result)).not.toContain('private-token');
      expect(JSON.parse(result.serialized)).toEqual({
        deviceToken: malformedToken === null ? null : '[redacted]',
        password: '[redacted]',
        token: '[redacted]',
      });
      expect(JSON.parse(result.headers)).toEqual({
        'x-boardsesh-device-token': malformedToken === null ? null : '[redacted]',
        password: '[redacted]',
      });
    },
  );
});

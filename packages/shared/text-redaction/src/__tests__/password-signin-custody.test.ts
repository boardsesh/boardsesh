import { describe, expect, it } from 'vite-plus/test';
import { scrubPasswordRecoveryEvent } from '../password-recovery';

describe('ordinary password candidate custody redaction', () => {
  it.each(['password-signin', 'password-signin-pending'])(
    'redacts %s cookies in every retained SDK representation',
    (family) => {
      const name = `__Host-boardsesh.${family}.${'a'.repeat(64)}.0`,
        secret = 'actual-encrypted-candidate-and-operation-capabilities';
      const event = {
        request: {
          headers: {
            cookie: `${name}=${secret}; ordinary=retained`,
            'set-cookie': `${name}=${secret}; Secure; HttpOnly`,
          },
          cookies: { [name]: secret },
          cookiePairs: [[name, secret]],
          parsedCookie: { name, value: secret },
        },
        serialized: JSON.stringify({ [name]: secret }),
        escapedName: { [name.replaceAll('.', '%2E')]: secret },
      };
      const result = scrubPasswordRecoveryEvent(event);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.request.headers.cookie).toContain('ordinary=retained');
      expect(event.request.cookies[name]).toBe(secret);
    },
  );
  it('preserves ordinary non-capability events by reference', () => {
    const event = { message: 'Password sign-in opened', request: { headers: { cookie: 'ordinary=retained' } } };
    expect(scrubPasswordRecoveryEvent(event)).toBe(event);
  });
});

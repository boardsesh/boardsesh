import { describe, expect, it } from 'vite-plus/test';
import { redactPasswordRecoveryUrls, scrubPasswordRecoveryEvent } from '../index';

const names = [
  '__Secure-boardsesh.session_token',
  '__Secure-boardsesh.bridged_session_token',
  'boardsesh.session_token',
  'boardsesh.bridged_session_token',
];
const secret = 'Xr4kD9mQ2vLp8sTn6wYb3cFh7jKz1aEu.' + 'S'.repeat(43);

describe.each(names)('browser session cookie %s in telemetry', (name) => {
  it('scrubs Cookie and Set-Cookie strings while keeping unrelated pairs', () => {
    expect(redactPasswordRecoveryUrls(`Cookie: ordinary=kept; ${name}=${secret}; next=kept`)).toBe(
      `Cookie: ordinary=kept; ${name}=[redacted]; next=kept`,
    );
    expect(
      redactPasswordRecoveryUrls(`Set-Cookie: ${name}=${secret}; Path=/; Domain=.boardsesh.com; HttpOnly; Secure`),
    ).toBe(`Set-Cookie: ${name}=[redacted]; Path=/; Domain=.boardsesh.com; HttpOnly; Secure`);
  });

  it.each([
    { request: { headers: { Cookie: `${name}=${secret}` } } },
    { request: { cookies: { [name]: secret } } },
    { request: { cookies: [[name, secret]] } },
    { request: { cookies: [{ name, value: secret, path: '/' }] } },
    { request: { cookies: { [name.replaceAll('_', '%255f').replaceAll('.', '%252e')]: secret } } },
    { breadcrumb: JSON.stringify({ cookies: { [name]: secret } }) },
  ])('scrubs structured SDK representation %j', (event) => {
    const result = scrubPasswordRecoveryEvent(event);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain('[redacted]');
    expect(JSON.stringify(event)).toContain(secret);
  });

  it('is idempotent', () => {
    const redacted = scrubPasswordRecoveryEvent({ Cookie: `${name}=${secret}` });
    expect(scrubPasswordRecoveryEvent(redacted)).toBe(redacted);
  });
});

describe('browser session cookie redaction leaves other cookies alone', () => {
  it.each(['boardsesh.theme=dark', 'session_token=kept', 'better-auth.session_token=kept'])('keeps %s', (pair) => {
    expect(redactPasswordRecoveryUrls(`Cookie: ${pair}`)).toBe(`Cookie: ${pair}`);
  });

  it('returns an unrelated event unchanged', () => {
    const event = { request: { cookies: { 'boardsesh.theme': 'dark' } } };
    expect(scrubPasswordRecoveryEvent(event)).toBe(event);
  });
});

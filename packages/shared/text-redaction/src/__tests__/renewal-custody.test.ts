import { describe, expect, it } from 'vite-plus/test';
import { redactPasswordRecoveryUrls, scrubPasswordRecoveryEvent } from '../index';
const name = '__Host-boardsesh.browser-renewal.' + 'a'.repeat(64) + '.0';
const secret = 'v1.actual-encrypted-old-and-new-credential-custody.tag';
describe('actual renewal credential cookie telemetry boundary', () => {
  it('scrubs free text and Cookie/Set-Cookie strings while keeping unrelated pairs', () => {
    expect(redactPasswordRecoveryUrls(`Cookie: ordinary=kept; ${name}=${secret}; next=kept`)).toBe(
      `Cookie: ordinary=kept; ${name}=[redacted]; next=kept`,
    );
    expect(redactPasswordRecoveryUrls(`Set-Cookie: ${name}=${secret}; HttpOnly; Secure`)).toBe(
      `Set-Cookie: ${name}=[redacted]; HttpOnly; Secure`,
    );
  });
  it.each([
    { request: { headers: { Cookie: `${name}=${secret}` } } },
    { request: { cookies: { [name]: secret } } },
    { request: { cookies: [[name, secret]] } },
    { request: { cookies: [{ name, value: secret, path: '/' }] } },
    { request: { cookies: [{ name, content: secret }] } },
    { request: { cookies: { [name.replaceAll('_', '%255f').replaceAll('.', '%252e')]: secret } } },
    { breadcrumb: JSON.stringify({ cookies: { [name]: secret } }) },
  ])('scrubs structured SDK representation%j without retaining actual custody', (event) => {
    const result = scrubPasswordRecoveryEvent(event);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain('[redacted]');
    expect(JSON.stringify(event)).toContain(secret);
  });
  it('retains ordinary control metadata and idempotence', () => {
    const event = {
      operationKey: 'a'.repeat(64),
      status: 'prepared',
      cursor: { bindingId: 'b'.repeat(64), version: 3 },
    };
    expect(scrubPasswordRecoveryEvent(event)).toBe(event);
    const redacted = scrubPasswordRecoveryEvent({ Cookie: `${name}=${secret}` });
    expect(scrubPasswordRecoveryEvent(redacted)).toBe(redacted);
  });
});

import { describe, expect, it } from 'vitest';
import { providerSecurityResumeSchema, providerSecurityResumeUrl } from '../provider-security-resume';

const operationKey = 'a'.repeat(64);
const metadata = {
  providerSecurityResumeVersion: 1,
  outcome: 'resumable',
  operationKey,
  actorContextKey: 'b'.repeat(64),
  provider: 'apple',
  reauthenticationReady: false,
  action: 'link',
  methodId: null,
};
describe('provider Settings resumption metadata', () => {
  it('carries UI selectors without accepting actor credentials or proof capabilities', () => {
    expect(providerSecurityResumeSchema.parse(metadata)).toEqual(metadata);
    for (const name of ['credential', 'intentToken', 'reauthenticationToken', 'userId'])
      expect(providerSecurityResumeSchema.safeParse({ ...metadata, [name]: 'not-public' }).success).toBe(false);
  });
  it('requires the exact unlink method selector and excludes Facebook', () => {
    expect(providerSecurityResumeSchema.safeParse({ ...metadata, action: 'unlink' }).success).toBe(false);
    expect(
      providerSecurityResumeSchema.safeParse({ ...metadata, action: 'unlink', methodId: 'c'.repeat(64) }).success,
    ).toBe(true);
    expect(providerSecurityResumeSchema.safeParse({ ...metadata, provider: 'facebook' }).success).toBe(false);
  });
  it.each(['en-US', 'es', 'fr', 'de', 'it'])('uses the configured canonical %s Settings destination only', (locale) => {
    const expectedPath = locale === 'en-US' ? '/settings' : `/${locale}/settings`;
    expect(providerSecurityResumeUrl('https://www.example.test', operationKey, locale)).toBe(
      `https://www.example.test${expectedPath}?providerSecurityResume=${operationKey}`,
    );
  });
  it.each([
    'http://www.example.test',
    'https://user@www.example.test',
    'https://www.example.test/path',
    'https://www.example.test?host=foreign',
  ])('refuses noncanonical destination configuration %s', (origin) => {
    expect(() => providerSecurityResumeUrl(origin, operationKey)).toThrow();
  });
});

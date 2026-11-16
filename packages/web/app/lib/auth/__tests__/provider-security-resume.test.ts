import { describe, expect, it } from 'vitest';
import { providerSecurityResumeUrl } from '../provider-security-resume';

const operationKey = 'a'.repeat(64);
describe('provider Settings resume destination', () => {
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

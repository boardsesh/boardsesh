import { describe, expect, it } from 'vitest';
import {
  chineseTranslationOnboardingKey,
  getChineseTerminologyFormUrl,
  isChineseTranslationLocale,
} from '../chinese-translation';

describe('Chinese translation invitation', () => {
  it('targets the shipped Simplified Chinese locale', () => {
    expect(isChineseTranslationLocale('zh-CN')).toBe(true);
    expect(isChineseTranslationLocale('zh-cn')).toBe(true);
    expect(isChineseTranslationLocale('zh-TW')).toBe(false);
    expect(isChineseTranslationLocale('en-US')).toBe(false);
  });

  it('accepts Google Forms respondent links', () => {
    expect(getChineseTerminologyFormUrl(' https://forms.gle/nativeTerms ')).toBe('https://forms.gle/nativeTerms');
    expect(getChineseTerminologyFormUrl('https://docs.google.com/forms/d/e/nativeTerms/viewform')).toBe(
      'https://docs.google.com/forms/d/e/nativeTerms/viewform',
    );
  });

  it('uses the published questionnaire when no environment override is configured', () => {
    expect(getChineseTerminologyFormUrl(undefined)).toBe(
      'https://docs.google.com/forms/d/e/1FAIpQLSewiiQkpQG5bT2UVYEdqDRmeSSs26h50xJLrR-rYORuZIj17g/viewform',
    );
  });

  it.each([
    '',
    'soon',
    'javascript:alert(1)',
    'http://forms.gle/test',
    'https://forms.gle.evil.test/test',
    'https://docs.google.com/document/d/test',
    'https://someone@forms.gle/test',
  ])('does not expose a missing or invalid form: %s', (configuredUrl) => {
    expect(getChineseTerminologyFormUrl(configuredUrl)).toBeNull();
  });

  it('invites early visitors again once the real form is available', () => {
    expect(chineseTranslationOnboardingKey(null)).not.toBe(
      chineseTranslationOnboardingKey('https://forms.gle/nativeTerms'),
    );
    expect(chineseTranslationOnboardingKey('https://forms.gle/nativeTerms')).toBe(
      chineseTranslationOnboardingKey('https://forms.gle/updatedTerms'),
    );
  });
});

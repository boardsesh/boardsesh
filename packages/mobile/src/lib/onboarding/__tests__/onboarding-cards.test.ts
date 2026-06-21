import { describe, it, expect } from 'vitest';
import { iconMap } from '../../../components/icon-map';
import { ONBOARDING_PROMPT_CARD, ONBOARDING_TOTAL_STEPS } from '../onboarding-cards';
import commonEn from '@boardsesh/i18n/locales/en-US/common.json';

function resolveKey(catalog: unknown, dottedKey: string): unknown {
  return dottedKey.split('.').reduce<unknown>((node, segment) => {
    if (node && typeof node === 'object') {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

const PROMPT_COPY_KEYS = ['title', 'body', 'footnote', 'findBoard', 'lookAround'];

describe('ONBOARDING_PROMPT_CARD', () => {
  it('is a single framing step', () => {
    expect(ONBOARDING_TOTAL_STEPS).toBe(1);
    expect(ONBOARDING_PROMPT_CARD.id).toBe('welcome');
  });

  it('references a real icon-map glyph (no synthesized imagery)', () => {
    expect(iconMap).toHaveProperty(ONBOARDING_PROMPT_CARD.icon);
  });

  it('has prompt copy in the en-US common catalog', () => {
    for (const key of PROMPT_COPY_KEYS) {
      expect(typeof resolveKey(commonEn, `mobile.onboarding.prompt.${key}`)).toBe('string');
    }
  });
});

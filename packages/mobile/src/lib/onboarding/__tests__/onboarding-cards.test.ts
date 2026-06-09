import { describe, it, expect } from 'vitest';
import { iconMap } from '../../../components/icon-map';
import { ONBOARDING_CARDS, ONBOARDING_TOTAL_STEPS } from '../onboarding-cards';
import commonEn from '@boardsesh/i18n/locales/en-US/common.json';

function resolveKey(catalog: unknown, dottedKey: string): unknown {
  return dottedKey.split('.').reduce<unknown>((node, segment) => {
    if (node && typeof node === 'object') {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

describe('ONBOARDING_CARDS', () => {
  it('has exactly four cards (the welcome carousel scope)', () => {
    expect(ONBOARDING_CARDS).toHaveLength(4);
    expect(ONBOARDING_TOTAL_STEPS).toBe(4);
  });

  it('keeps the spec page order: welcome → connect → find → play', () => {
    expect(ONBOARDING_CARDS.map((card) => card.id)).toEqual(['welcome', 'connect', 'find', 'play']);
  });

  it('has unique ids (stable analytics keys)', () => {
    const ids = ONBOARDING_CARDS.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('references real icon-map glyphs (no synthesized imagery)', () => {
    for (const card of ONBOARDING_CARDS) {
      expect(iconMap).toHaveProperty(card.icon);
    }
  });

  it('has title + body copy for every card id in the en-US common catalog', () => {
    for (const card of ONBOARDING_CARDS) {
      expect(typeof resolveKey(commonEn, `mobile.onboarding.cards.${card.id}.title`)).toBe('string');
      expect(typeof resolveKey(commonEn, `mobile.onboarding.cards.${card.id}.body`)).toBe('string');
    }
  });
});

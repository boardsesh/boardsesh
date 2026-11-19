import { describe, expect, it } from 'vite-plus/test';
import { selectI18nResources } from '../select-resources';

describe('page translation resources', () => {
  it('keeps only the client islands while leaving server catalogs unchanged', () => {
    const resources = {
      common: { back: 'Back' },
      marketing: {
        home: { hero: { title: 'Climb' }, cards: { title: 'Next' } },
        legal: { title: 'Legal' },
        privacy: { title: 'Privacy' },
      },
    };
    const selected = selectI18nResources(resources, { marketing: ['home.hero'] });
    expect(selected).toEqual({ common: { back: 'Back' }, marketing: { home: { hero: { title: 'Climb' } } } });
    expect(JSON.stringify(selected)).not.toContain('Legal');
    expect(resources.marketing.legal.title).toBe('Legal');
  });

  it('refuses a missing branch instead of silently shipping raw keys', () => {
    expect(() => selectI18nResources({ marketing: { home: {} } }, { marketing: ['home.missing'] })).toThrow(
      'Missing translation branch',
    );
  });

  it('rejects prototype paths', () => {
    expect(() => selectI18nResources({ marketing: {} }, { marketing: ['__proto__.title'] })).toThrow(
      'Invalid translation branch',
    );
  });
});

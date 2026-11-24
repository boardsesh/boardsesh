import { describe, expect, it } from 'vite-plus/test';
import { needsAppGuideDocumentNavigation } from '../published-locales';

describe('app guide language boundaries', () => {
  it.each([
    ['/boards', '/apps/kilter', 'en-US', 'en-US', undefined, false],
    ['/boards', '/apps/kilter', 'en-US', 'en-US', 'fr', false],
    ['/apps/kilter', '/boards', 'en-US', 'en-US', undefined, false],
    ['/apps/kilter', '/boards', 'en-US', 'en-US', 'en-US', false],
    ['/fr/boards', '/apps/kilter', 'fr', 'en-US', 'fr', true],
    ['/apps/kilter', '/boards', 'en-US', 'en-US', 'fr', true],
    ['/apps/kilter', '/fr/boards', 'en-US', 'fr', undefined, true],
    ['/apps/kilter', '/apps/aurora', 'en-US', 'en-US', 'fr', false],
    ['/apps/kilter', '/compare/spray-wall-apps', 'en-US', 'en-US', 'fr', false],
    ['/fr/boards', '/fr/help', 'fr', 'fr', 'fr', false],
  ] as const)(
    '%s → %s reloads only when the document language changes',
    (source, target, current, next, saved, expected) => {
      expect(needsAppGuideDocumentNavigation(source, target, current, next, saved)).toBe(expected);
    },
  );
});

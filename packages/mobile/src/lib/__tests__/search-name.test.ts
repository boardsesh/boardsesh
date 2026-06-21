import { describe, expect, it } from 'vitest';
import { normalizeSearchName, visibleSearchTextNeedsSync } from '../search-name';

describe('normalizeSearchName', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeSearchName('  Moonage Daydream  ')).toBe('Moonage Daydream');
  });

  it('normalizes whitespace-only searches to empty', () => {
    expect(normalizeSearchName('   ')).toBe('');
  });
});

describe('visibleSearchTextNeedsSync', () => {
  it('treats an in-progress trailing space as in sync (no re-seed)', () => {
    // The user typed "crimp " (raw) and the debounce committed "crimp" (trimmed).
    // The trailing space must NOT be yanked back out of the field.
    expect(visibleSearchTextNeedsSync('crimp ', 'crimp')).toBe(false);
  });

  it('treats a leading space the same way', () => {
    expect(visibleSearchTextNeedsSync(' crimp', 'crimp')).toBe(false);
  });

  it('reports a real external change as needing sync', () => {
    // Board restore / recent pill / cancel committed a different name.
    expect(visibleSearchTextNeedsSync('crimp', 'jugs')).toBe(true);
    expect(visibleSearchTextNeedsSync('crimp ', '')).toBe(true);
  });
});

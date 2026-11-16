import { describe, expect, it } from 'vite-plus/test';
import { developerDocsIndexable, getDeveloperDocsState } from '../docs-access';

describe('getDeveloperDocsState', () => {
  it.each([
    [undefined, 'unavailable'],
    ['', 'unavailable'],
    ['off', 'unavailable'],
    ['hold', 'unavailable'],
    ['opne', 'unavailable'],
    ['allowlist', 'invitation'],
    [' Allowlist ', 'invitation'],
    ['open', 'open'],
    ['OPEN', 'open'],
  ])('reads %j as %s', (mode, state) => {
    expect(getDeveloperDocsState(mode)).toBe(state);
  });

  it('is indexable only when outsiders can act', () => {
    expect(developerDocsIndexable('off')).toBe(false);
    expect(developerDocsIndexable('hold')).toBe(false);
    expect(developerDocsIndexable('allowlist')).toBe(false);
    expect(developerDocsIndexable('open')).toBe(true);
  });
});

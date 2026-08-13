import { describe, it, expect } from 'vitest';
import { stripLocalePrefix } from '../strip-locale-prefix';

describe('stripLocalePrefix', () => {
  it('drops a locale segment from a tuple board URL', () => {
    expect(stripLocalePrefix('/es/kilter/1/10/1,20/40/list')).toBe('/kilter/1/10/1,20/40/list');
  });

  it('drops a locale segment from a named board URL', () => {
    expect(stripLocalePrefix('/fr/b/the-gym/40/list')).toBe('/b/the-gym/40/list');
  });

  it.each(['de', 'es', 'fr'])('handles every non-root locale (%s)', (locale) => {
    expect(stripLocalePrefix(`/${locale}/kilter/1/10/1,20/40/list`)).toBe('/kilter/1/10/1,20/40/list');
  });

  it('leaves a path with no locale prefix alone', () => {
    expect(stripLocalePrefix('/kilter/1/10/1,20/40/list')).toBeNull();
  });

  // A locale has to be a WHOLE segment. Chopping a prefix off a word would
  // invent a route nobody asked for.
  it.each(['/estonia/kilter/1/10/1,20/40/list', '/es-419/kilter/1/10/1,20/40/list', '/esp/b/the-gym'])(
    'does not strip a segment that merely starts with a locale (%s)',
    (path) => {
      expect(stripLocalePrefix(path)).toBeNull();
    },
  );

  // `en-US` is the ROOT locale on web — it never appears in a path, so a literal
  // `/en-US/...` is not a link we issue and stripping it would be a guess.
  it('strips the root locale only if it really is a whole segment', () => {
    expect(stripLocalePrefix('/en-US/kilter/1/10/1,20/40/list')).toBe('/kilter/1/10/1,20/40/list');
  });

  // A bare locale carries no destination, so the caller keeps its normal
  // not-found handling rather than being sent to `/`.
  it.each(['/de', '/de/', '/', ''])('reports nothing to strip for a bare locale or root (%s)', (path) => {
    expect(stripLocalePrefix(path)).toBeNull();
  });

  it('tolerates a missing leading slash', () => {
    expect(stripLocalePrefix('es/kilter/1/10/1,20/40/list')).toBe('/kilter/1/10/1,20/40/list');
  });

  it.each([null, undefined])('reports nothing to strip for %s', (path) => {
    expect(stripLocalePrefix(path)).toBeNull();
  });
});

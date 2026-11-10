import { describe, expect, it } from 'vitest';
import { isChromeLessPath } from '../chrome-less-routes';
import { stripLocalePrefix } from '../i18n/locale-href';

describe('isChromeLessPath', () => {
  it('matches kiosk routes at any depth', () => {
    expect(isChromeLessPath('/kiosk')).toBe(true);
    expect(isChromeLessPath('/kiosk/my-gym')).toBe(true);
    expect(isChromeLessPath('/kiosk/my-gym/front-tv')).toBe(true);
  });

  it('matches embed routes (pre-gated for the embeds PR)', () => {
    expect(isChromeLessPath('/embed')).toBe(true);
    expect(isChromeLessPath('/embed/board/abc-123')).toBe(true);
  });

  it('matches the printable gym poster, and only that leaf', () => {
    // The fixed header prints on top of the sheet and the footer pushes it onto
    // page two, so this one is functional rather than cosmetic (#4379).
    expect(isChromeLessPath('/gym/boulderwelt-ost/poster')).toBe(true);
    expect(isChromeLessPath('/gym/boulderwelt-ost')).toBe(false);
    expect(isChromeLessPath('/gym/boulderwelt-ost/manage')).toBe(false);
    expect(isChromeLessPath('/gym/boulderwelt-ost/poster/extra')).toBe(false);
    expect(isChromeLessPath('/gym/poster')).toBe(false);
  });

  it('matches the printable board poster, in every locale once the prefix is stripped', () => {
    // Same reason as the gym poster: the fixed header prints over the sheet (#4415).
    expect(isChromeLessPath('/poster/b/garage-wall')).toBe(true);
    expect(isChromeLessPath(stripLocalePrefix('/es/poster/b/garage-wall', 'es'))).toBe(true);
    expect(isChromeLessPath('/b/garage-wall')).toBe(false);
    expect(isChromeLessPath('/posters')).toBe(false);
  });

  it('matches the partner app sign-in and consent pages, whose site links would drop the request', () => {
    expect(isChromeLessPath('/oauth/sign-in')).toBe(true);
    expect(isChromeLessPath('/oauth/consent')).toBe(true);
    expect(isChromeLessPath(stripLocalePrefix('/fr/oauth/consent', 'fr'))).toBe(true);
    expect(isChromeLessPath('/oauthentication')).toBe(false);
  });

  it('does not match lookalike prefixes', () => {
    expect(isChromeLessPath('/kiosks')).toBe(false);
    expect(isChromeLessPath('/embedded')).toBe(false);
    expect(isChromeLessPath('/kiosk-manager')).toBe(false);
  });

  it('does not match unrelated routes', () => {
    expect(isChromeLessPath('/')).toBe(false);
    expect(isChromeLessPath('/you')).toBe(false);
    expect(isChromeLessPath('/gym/my-gym')).toBe(false);
  });

  it('expects locale-stripped input (locale prefixes are the caller contract)', () => {
    // usePathnameWithoutLocale strips /es → callers never pass this shape,
    // documented here as the contract rather than handled.
    expect(isChromeLessPath('/es/kiosk/my-gym')).toBe(false);
  });
});

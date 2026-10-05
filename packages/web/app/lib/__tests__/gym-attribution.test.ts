import { describe, it, expect } from 'vite-plus/test';
import { SITE_URL } from '@/app/lib/seo/base-url';
import { boardQrUrl, gymQrAttributionQuery, gymQrUrl } from '../gym-attribution';

describe('gymQrUrl', () => {
  it('builds the absolute poster URL a printed code encodes', () => {
    // Spelled out in full rather than assembled from the constants: this exact
    // string gets laminated and stuck to a wall, where a wrong character cannot
    // be patched afterwards.
    expect(gymQrUrl('boulderwelt-munich')).toBe(`${SITE_URL}/gym/boulderwelt-munich?src=qr&medium=poster`);
  });

  it('takes a non-poster medium for a code aimed at a gym page from elsewhere', () => {
    expect(gymQrUrl('boulderwelt-munich', 'kiosk')).toBe(`${SITE_URL}/gym/boulderwelt-munich?src=qr&medium=kiosk`);
  });

  it('percent-encodes a slug that is not URL-safe', () => {
    // Slugs are generated lowercase-and-hyphens today. A rule that loosens
    // later must not silently print a URL with a raw space or `#` in it — a
    // fragment in the path would eat the params entirely.
    expect(gymQrUrl('café münchen')).toBe(`${SITE_URL}/gym/caf%C3%A9%20m%C3%BCnchen?src=qr&medium=poster`);
    expect(gymQrUrl('boulder#1')).toBe(`${SITE_URL}/gym/boulder%231?src=qr&medium=poster`);
  });
});

describe('boardQrUrl', () => {
  it('builds the kiosk per-board URL', () => {
    expect(boardQrUrl('main-kilter', 'kiosk')).toBe(`${SITE_URL}/b/main-kilter?src=qr&medium=kiosk`);
  });

  it('builds a per-wall board URL', () => {
    expect(boardQrUrl('main-kilter', 'board')).toBe(`${SITE_URL}/b/main-kilter?src=qr&medium=board`);
  });

  it('percent-encodes a slug that is not URL-safe', () => {
    expect(boardQrUrl('kilter 45', 'kiosk')).toBe(`${SITE_URL}/b/kilter%2045?src=qr&medium=kiosk`);
  });
});

describe('gymQrAttributionQuery', () => {
  it('re-emits both params for a real scan', () => {
    expect(gymQrAttributionQuery({ src: 'qr', medium: 'poster' })).toBe('?src=qr&medium=poster');
    expect(gymQrAttributionQuery({ src: 'qr', medium: 'kiosk' })).toBe('?src=qr&medium=kiosk');
  });

  it('returns an empty string — not a bare "?" — for a plain visit', () => {
    // The return value is concatenated straight onto a redirect target, so
    // anything other than `''` here publishes a URL ending in a dangling `?`.
    expect(gymQrAttributionQuery({})).toBe('');
  });

  it('returns an empty string when only one half of the pair is present', () => {
    expect(gymQrAttributionQuery({ src: 'qr' })).toBe('');
    expect(gymQrAttributionQuery({ medium: 'poster' })).toBe('');
  });

  it('returns an empty string for a medium outside the vocabulary', () => {
    expect(gymQrAttributionQuery({ src: 'qr', medium: 'evil' })).toBe('');
    expect(gymQrAttributionQuery({ src: 'qr', medium: 'POSTER' })).toBe('');
    expect(gymQrAttributionQuery({ src: 'email', medium: 'poster' })).toBe('');
  });

  it('returns an empty string for an array-valued param', () => {
    // `?medium=poster&medium=kiosk` is a hand-edited or crawler-mangled URL, not
    // a scan. Picking one would let a crafted link choose its own attribution.
    expect(gymQrAttributionQuery({ src: 'qr', medium: ['poster', 'kiosk'] })).toBe('');
    expect(gymQrAttributionQuery({ src: ['qr'], medium: 'poster' })).toBe('');
  });

  it('drops every param that is not src or medium', () => {
    // The allowlist is the security property: this string is appended to a
    // redirect target, so nothing a caller typed may ride through it.
    expect(
      gymQrAttributionQuery({
        src: 'qr',
        medium: 'poster',
        utm_campaign: 'someone-elses',
        tab: 'members',
        claim: '1',
        redirect: 'https://evil.example.com',
      }),
    ).toBe('?src=qr&medium=poster');
  });
});

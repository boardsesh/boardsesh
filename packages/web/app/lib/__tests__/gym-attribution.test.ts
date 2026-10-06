import { describe, it, expect } from 'vite-plus/test';
import { SITE_URL } from '@/app/lib/seo/base-url';
import { boardQrUrl, gymQrAttributionQuery, gymQrUrl, gymRedirectAttributionQuery } from '../gym-attribution';

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

describe('gymRedirectAttributionQuery', () => {
  it('returns an empty string for a plain visit', () => {
    expect(gymRedirectAttributionQuery({})).toBe('');
  });

  it('carries the QR pair exactly as gymQrAttributionQuery does', () => {
    expect(gymRedirectAttributionQuery({ src: 'qr', medium: 'poster' })).toBe('?src=qr&medium=poster');
    expect(gymRedirectAttributionQuery({ src: 'qr', medium: 'evil' })).toBe('');
  });

  it("carries a tagged visit's campaign params", () => {
    expect(gymRedirectAttributionQuery({ utm_source: 'instagram', utm_medium: 'social' })).toBe(
      '?utm_source=instagram&utm_medium=social',
    );
  });

  it('carries all six, in the reported order, after the QR pair', () => {
    expect(
      gymRedirectAttributionQuery({
        gclid: 'EAIaIQobChMI',
        utm_term: 'kilter',
        utm_content: 'creative-7',
        utm_campaign: 'spray-launch',
        utm_medium: 'cpc',
        utm_source: 'google',
        medium: 'poster',
        src: 'qr',
      }),
    ).toBe(
      '?src=qr&medium=poster&utm_source=google&utm_medium=cpc&utm_campaign=spray-launch&utm_content=creative-7&utm_term=kilter&gclid=EAIaIQobChMI',
    );
  });

  it('drops every param outside the two allowlists', () => {
    expect(
      gymRedirectAttributionQuery({
        utm_source: 'instagram',
        tab: 'members',
        claim: '1',
        next: 'https://evil.example.com',
        redirect: 'https://evil.example.com',
        utm_id: '42',
        fbclid: 'abc',
      }),
    ).toBe('?utm_source=instagram');
  });

  it('re-encodes a value, so it cannot open a fragment or add a param of its own', () => {
    expect(gymRedirectAttributionQuery({ utm_source: 'a&next=https://evil.example.com#frag' })).toBe(
      '?utm_source=a%26next%3Dhttps%3A%2F%2Fevil.example.com%23frag',
    );
  });

  it('trims and caps a value the way the landing parser does', () => {
    expect(gymRedirectAttributionQuery({ utm_source: '  instagram  ' })).toBe('?utm_source=instagram');
    expect(gymRedirectAttributionQuery({ utm_source: 'x'.repeat(500) })).toBe(`?utm_source=${'x'.repeat(200)}`);
  });

  it('drops a blank param and keeps the first of a repeated one', () => {
    expect(gymRedirectAttributionQuery({ utm_source: '   ', utm_medium: 'social' })).toBe('?utm_medium=social');
    expect(gymRedirectAttributionQuery({ utm_source: ['instagram', 'reddit'] })).toBe('?utm_source=instagram');
    expect(gymRedirectAttributionQuery({ utm_source: [] })).toBe('');
  });
});

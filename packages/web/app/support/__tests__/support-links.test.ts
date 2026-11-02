import { describe, it, expect } from 'vite-plus/test';
import {
  DEFAULT_SUPPORT_SRC,
  MAX_MONTHLY_OPTIONS,
  buildSupportPageOptions,
  defaultSupportCurrency,
  hasMonthlyLinks,
  parseCurrencyParam,
  parseMonthlyLinks,
  parseStripeUrl,
  readSupportLinksConfig,
  sanitizeSupportSrc,
  withSupportSource,
} from '../support-links';

// Placeholder labels: real ones live only in the Railway env, and name amounts.
const LINK_A = 'https://buy.stripe.com/test_aaa';
const LINK_B = 'https://buy.stripe.com/test_bbb';
const MONTHLY_JSON = JSON.stringify([
  { label: 'Tier A', url: LINK_A },
  { label: 'Tier B', url: LINK_B },
]);

describe('parseStripeUrl', () => {
  it.each([LINK_A, 'https://donate.stripe.com/abc123'])('passes the Payment Link %s through', (url) => {
    expect(parseStripeUrl(url)).toBe(url);
  });

  it.each([undefined, ''])('treats %j as unset', (rawValue) => {
    expect(parseStripeUrl(rawValue)).toBeUndefined();
  });

  // A misconfigured value must hide the button, never point it somewhere else.
  it.each([
    'http://buy.stripe.com/abc',
    '//buy.stripe.com/abc',
    'buy.stripe.com/abc',
    'true',
    'javascript:alert(1)',
    'https://evil.example/abc',
    'https://buy.stripe.com.evil.example/abc',
    'https://user:pass@buy.stripe.com/abc',
    'https://buy.stripe.com:8443/abc',
    'https://billing.stripe.com/p/login/abc',
  ])('refuses %s', (rawValue) => {
    expect(parseStripeUrl(rawValue)).toBeUndefined();
  });
});

describe('parseMonthlyLinks', () => {
  it('reads a list of labelled Payment Links', () => {
    expect(parseMonthlyLinks(MONTHLY_JSON)).toEqual([
      { label: 'Tier A', url: LINK_A },
      { label: 'Tier B', url: LINK_B },
    ]);
  });

  it('treats a missing var as no monthly list', () => {
    expect(parseMonthlyLinks(undefined)).toBeUndefined();
    expect(parseMonthlyLinks('  ')).toBeUndefined();
  });

  // All or nothing: one bad URL drops the whole list.
  it('drops the whole list when one URL is not a Payment Link', () => {
    const json = JSON.stringify([
      { label: 'Tier A', url: LINK_A },
      { label: 'Tier B', url: 'https://evil.example/pay' },
    ]);
    expect(parseMonthlyLinks(json)).toBeUndefined();
  });

  it.each([
    ['not JSON', '{label: x}'],
    ['an object, not an array', JSON.stringify({ label: 'Tier A', url: LINK_A })],
    ['an empty array', '[]'],
    ['a blank label', JSON.stringify([{ label: '  ', url: LINK_A }])],
    ['a missing url', JSON.stringify([{ label: 'Tier A' }])],
    [
      'too many options',
      JSON.stringify(Array.from({ length: MAX_MONTHLY_OPTIONS + 1 }, () => ({ label: 'x', url: LINK_A }))),
    ],
  ])('refuses %s', (_name, rawValue) => {
    expect(parseMonthlyLinks(rawValue)).toBeUndefined();
  });
});

describe('readSupportLinksConfig', () => {
  it('falls back to the one-off page when no monthly var is set', () => {
    const config = readSupportLinksConfig({ STRIPE_DONATE_URL: LINK_A });
    expect(hasMonthlyLinks(config)).toBe(false);
    expect(config.once.aud).toBe(LINK_A);
  });

  it('turns monthly on when either currency has a list', () => {
    expect(hasMonthlyLinks(readSupportLinksConfig({ SUPPORT_MONTHLY_LINKS_USD: MONTHLY_JSON }))).toBe(true);
  });

  it('accepts only a billing.stripe.com portal link', () => {
    expect(
      readSupportLinksConfig({ STRIPE_BILLING_PORTAL_URL: 'https://billing.stripe.com/p/login/x' }).billingPortalUrl,
    ).toBe('https://billing.stripe.com/p/login/x');
    expect(readSupportLinksConfig({ STRIPE_BILLING_PORTAL_URL: LINK_A }).billingPortalUrl).toBeUndefined();
  });
});

describe('sanitizeSupportSrc', () => {
  it.each([
    [undefined, DEFAULT_SUPPORT_SRC],
    ['', DEFAULT_SUPPORT_SRC],
    ['web-home-banner', 'web-home-banner'],
    ['App-Home', 'app-home'],
    ['reddit_kilter board!', 'redditkilterboard'],
    ['<script>', 'script'],
    ['---', DEFAULT_SUPPORT_SRC],
    [['first', 'second'], 'first'],
  ])('%j becomes %s', (rawValue, expected) => {
    expect(sanitizeSupportSrc(rawValue)).toBe(expected);
  });

  it('caps the length at 40 characters', () => {
    expect(sanitizeSupportSrc('a'.repeat(100))).toHaveLength(40);
  });
});

describe('withSupportSource', () => {
  it('sets client_reference_id and utm_source', () => {
    const tagged = new URL(withSupportSource(LINK_A, 'web-home-banner'));
    expect(tagged.searchParams.get('client_reference_id')).toBe('web-home-banner');
    expect(tagged.searchParams.get('utm_source')).toBe('web-home-banner');
  });

  it('replaces values already on the link', () => {
    const tagged = new URL(withSupportSource(`${LINK_A}?utm_source=old&locale=en`, 'web-support'));
    expect(tagged.searchParams.getAll('utm_source')).toEqual(['web-support']);
    expect(tagged.searchParams.get('locale')).toBe('en');
  });
});

describe('defaultSupportCurrency', () => {
  it('picks USD for a visitor placed in the US', () => {
    expect(defaultSupportCurrency('US', ['aud', 'usd'])).toBe('usd');
  });

  it.each(['AU', 'CA', 'DE', null])('picks AUD for %s', (country) => {
    expect(defaultSupportCurrency(country, ['aud', 'usd'])).toBe('aud');
  });

  it('skips a currency that has no link', () => {
    expect(defaultSupportCurrency('US', ['aud'])).toBe('aud');
    expect(defaultSupportCurrency('AU', ['usd'])).toBe('usd');
  });
});

describe('parseCurrencyParam', () => {
  it.each([
    ['usd', 'usd'],
    ['AUD', 'aud'],
    ['eur', undefined],
    [undefined, undefined],
  ])('%j reads as %j', (rawValue, expected) => {
    expect(parseCurrencyParam(rawValue)).toBe(expected);
  });
});

describe('buildSupportPageOptions', () => {
  const config = readSupportLinksConfig({
    SUPPORT_MONTHLY_LINKS_AUD: MONTHLY_JSON,
    SUPPORT_MONTHLY_LINKS_USD: MONTHLY_JSON,
    STRIPE_DONATE_URL: LINK_A,
  });

  it('tags every link with src', () => {
    const options = buildSupportPageOptions({ config, src: 'web-home-banner', country: 'AU' });
    const urls = [...(options.monthly.aud ?? []).map((link) => link.url), options.once.aud ?? ''];
    for (const url of urls) {
      expect(new URL(url).searchParams.get('client_reference_id')).toBe('web-home-banner');
    }
  });

  it('defaults by country, and a ?currency= param wins', () => {
    expect(buildSupportPageOptions({ config, src: 'x', country: 'US' }).defaultCurrency).toBe('usd');
    expect(buildSupportPageOptions({ config, src: 'x', country: 'US', currencyParam: 'aud' }).defaultCurrency).toBe(
      'aud',
    );
  });

  it('lists only currencies with a link', () => {
    const audOnly = readSupportLinksConfig({ STRIPE_DONATE_URL: LINK_A });
    const options = buildSupportPageOptions({ config: audOnly, src: 'x', country: 'US' });
    expect(options.currencies).toEqual(['aud']);
    expect(options.defaultCurrency).toBe('aud');
    expect(options.monthlyFirst).toBe(false);
  });
});

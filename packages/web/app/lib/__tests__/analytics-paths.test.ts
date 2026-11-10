import { describe, expect, it } from 'vite-plus/test';
import {
  analyticsPathname,
  isAdminAnalyticsUrl,
  isEmbedAnalyticsUrl,
  isPartnerOAuthAnalyticsUrl,
  isProductAnalyticsFreeUrl,
  stripAnalyticsLocalePrefix,
} from '../analytics-paths';

describe('analyticsPathname', () => {
  it('keeps only the pathname for absolute and relative URLs', () => {
    expect(analyticsPathname('https://boardsesh.com/b/kilter?session=abc#top')).toBe('/b/kilter');
    expect(analyticsPathname('/b/kilter?session=abc')).toBe('/b/kilter');
  });
});

describe('stripAnalyticsLocalePrefix', () => {
  it('strips supported non-default locale prefixes', () => {
    expect(stripAnalyticsLocalePrefix('/es/admin')).toBe('/admin');
    expect(stripAnalyticsLocalePrefix('/fr/admin/retention')).toBe('/admin/retention');
  });

  it('leaves unprefixed paths alone', () => {
    expect(stripAnalyticsLocalePrefix('/admin')).toBe('/admin');
    expect(stripAnalyticsLocalePrefix('/b/admin')).toBe('/b/admin');
  });
});

describe('isAdminAnalyticsUrl', () => {
  it('matches admin paths with optional locale prefixes', () => {
    expect(isAdminAnalyticsUrl('/admin')).toBe(true);
    expect(isAdminAnalyticsUrl('/admin/retention?range=30')).toBe(true);
    expect(isAdminAnalyticsUrl('/es/admin')).toBe(true);
    expect(isAdminAnalyticsUrl('https://boardsesh.com/fr/admin/retention')).toBe(true);
  });

  it('does not match lookalikes or query-only admin URLs', () => {
    expect(isAdminAnalyticsUrl('/administrator')).toBe(false);
    expect(isAdminAnalyticsUrl('/admin_panel')).toBe(false);
    expect(isAdminAnalyticsUrl('/b/admin')).toBe(false);
    expect(isAdminAnalyticsUrl('/fr/admin_panel')).toBe(false);
    expect(isAdminAnalyticsUrl('/?next=/admin')).toBe(false);
  });
});

describe('isEmbedAnalyticsUrl', () => {
  it('matches embed widget paths — no analytics inside third-party iframes', () => {
    expect(isEmbedAnalyticsUrl('/embed')).toBe(true);
    expect(isEmbedAnalyticsUrl('/embed/board/abc?x=1')).toBe(true);
    expect(isEmbedAnalyticsUrl('https://boardsesh.com/embed/gym/abc/leaderboard?period=day')).toBe(true);
  });

  it('is case-insensitive, mirroring the case-insensitive header matchers', () => {
    // Next's header source patterns compile case-insensitively, so
    // /EMBED/board/x receives the frameable embed headers — the analytics
    // suppression must cover the same set of paths.
    expect(isEmbedAnalyticsUrl('/EMBED/board/abc')).toBe(true);
    expect(isEmbedAnalyticsUrl('/Embed/gym/abc/leaderboard')).toBe(true);
  });

  it('does not match lookalikes or the kiosk (kiosk keeps first-party telemetry)', () => {
    expect(isEmbedAnalyticsUrl('/embedded')).toBe(false);
    expect(isEmbedAnalyticsUrl('/kiosk/some-gym')).toBe(false);
    expect(isEmbedAnalyticsUrl('/?next=/embed/board/abc')).toBe(false);
  });
});

describe('isPartnerOAuthAnalyticsUrl', () => {
  it('matches the partner sign-in and consent pages in every locale and case', () => {
    expect(isPartnerOAuthAnalyticsUrl('/oauth/consent?client_id=bsk_app&sig=signed')).toBe(true);
    expect(isPartnerOAuthAnalyticsUrl('https://www.boardsesh.com/de/oauth/sign-in?client_id=bsk_app')).toBe(true);
    expect(isPartnerOAuthAnalyticsUrl('/OAuth/Consent')).toBe(true);
    expect(isPartnerOAuthAnalyticsUrl('/oauth')).toBe(true);
  });

  it('does not match lookalikes, a query that names the page, or the NextAuth routes', () => {
    expect(isPartnerOAuthAnalyticsUrl('/oauthentication')).toBe(false);
    expect(isPartnerOAuthAnalyticsUrl('/auth/login?callbackUrl=/oauth/sign-in')).toBe(false);
    expect(isPartnerOAuthAnalyticsUrl('/api/auth/callback/google')).toBe(false);
  });
});

describe('isProductAnalyticsFreeUrl', () => {
  it('covers embeds, the kiosk and the partner OAuth pages, and nothing else', () => {
    expect(isProductAnalyticsFreeUrl('/embed/board/abc')).toBe(true);
    expect(isProductAnalyticsFreeUrl('/kiosk/some-gym')).toBe(true);
    expect(isProductAnalyticsFreeUrl('/es/oauth/consent')).toBe(true);
    expect(isProductAnalyticsFreeUrl('/gyms')).toBe(false);
    expect(isProductAnalyticsFreeUrl('/admin')).toBe(false);
  });
});

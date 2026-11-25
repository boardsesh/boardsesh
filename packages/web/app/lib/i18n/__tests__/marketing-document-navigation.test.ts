import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { needsMarketingDocumentNavigation, navigateAcrossMarketingDocument } from '../marketing-document-navigation';
import { __resetSessionInboundCampaignForTests } from '@/app/lib/inbound-campaign';

const assign = vi.fn();
const replace = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  __resetSessionInboundCampaignForTests();
  vi.stubGlobal('window', {
    location: {
      href: 'https://www.boardsesh.com/?utm_source=crew&gclid=private-click',
      origin: 'https://www.boardsesh.com',
      pathname: '/',
      search: '?utm_source=crew&gclid=private-click',
      assign,
      replace,
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('marketing document boundaries', () => {
  it.each([
    ['/', '/auth/login', true],
    ['/', '/settings', true],
    ['/auth/login', '/', true],
    ['/settings', '/', true],
    ['/apps/kilter', '/playlists', true],
    ['/fr', '/fr/settings', true],
    ['/fr/settings', '/fr', true],
    ['/', '/apps/kilter', false],
    ['/apps/kilter', '/compare/spray-wall-apps', false],
    ['/auth/login', '/settings', false],
    ['/profile/climber', '/profile/climber/statistics', false],
  ])('%s → %s requires a new document: %s', (source, target, expected) => {
    expect(needsMarketingDocumentNavigation(source as string, target as string)).toBe(expected);
  });

  it('navigates across shells with campaign labels and no persisted ad click IDs', () => {
    expect(navigateAcrossMarketingDocument('/auth/login?callbackUrl=%2Fsettings')).toBe(true);
    const destination = new URL(String(assign.mock.calls[0][0]));
    expect(destination.pathname).toBe('/auth/login');
    expect(destination.searchParams.get('callbackUrl')).toBe('/settings');
    expect(destination.searchParams.get('utm_source')).toBe('crew');
    expect(destination.searchParams.has('gclid')).toBe(false);
  });

  it('preserves replace semantics and destination campaign labels', () => {
    expect(navigateAcrossMarketingDocument('/settings?utm_source=direct', true)).toBe(true);
    expect(new URL(String(replace.mock.calls[0][0])).searchParams.get('utm_source')).toBe('direct');
    expect(assign).not.toHaveBeenCalled();
  });

  it('keeps navigation within one shell on the client router', () => {
    expect(navigateAcrossMarketingDocument('/apps/kilter')).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

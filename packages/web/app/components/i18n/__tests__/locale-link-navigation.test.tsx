import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import LocaleLink from '../locale-link';
import { __resetSessionInboundCampaignForTests } from '@/app/lib/inbound-campaign';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en-US' } }) }));
vi.mock('next/link', () => ({ default: () => null }));
const assign = vi.fn();
beforeEach(() => {
  assign.mockReset();
  __resetSessionInboundCampaignForTests();
  vi.stubGlobal('window', {
    location: {
      href: 'https://www.boardsesh.com/',
      origin: 'https://www.boardsesh.com',
      pathname: '/',
      search: '',
      assign,
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('LocaleLink document navigation', () => {
  it.each(['/auth/login', '/settings'])('replaces the marketing document before rendering %s', (href) => {
    const preventDefault = vi.fn();
    const link = LocaleLink({ href });
    expect(link.props.prefetch).toBe(false);
    link.props.onNavigate({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(new URL(String(assign.mock.calls[0][0])).pathname).toBe(href);
  });

  it('keeps same-shell navigation in Next', () => {
    const preventDefault = vi.fn();
    LocaleLink({ href: '/apps/kilter' }).props.onNavigate({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});

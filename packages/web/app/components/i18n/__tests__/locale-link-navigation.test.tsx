import type { ComponentProps, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import NextLink from 'next/link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import LocaleLink from '../locale-link';
import { __resetSessionInboundCampaignForTests } from '@/app/lib/inbound-campaign';
import { DocumentLocaleProvider } from '@/app/lib/i18n/document-locale-context';
import type { Locale } from '@/app/lib/i18n/config';

vi.mock('next/link', () => ({
  default: vi.fn(({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>),
}));

const assign = vi.fn();
function setLocation(path: string) {
  const url = new URL(path, 'https://www.boardsesh.com');
  vi.stubGlobal('window', {
    location: { href: url.href, origin: url.origin, pathname: url.pathname, search: url.search, assign },
  });
}

function renderLink(documentLocale: Locale, props: ComponentProps<typeof LocaleLink>) {
  const html = renderToStaticMarkup(
    <DocumentLocaleProvider locale={documentLocale}>
      <LocaleLink {...props}>Destination</LocaleLink>
    </DocumentLocaleProvider>,
  );
  const linkProps = vi.mocked(NextLink).mock.lastCall?.[0];
  if (!linkProps?.onNavigate) throw new Error('Expected Next link navigation handler');
  return { html, prefetch: linkProps.prefetch, navigate: linkProps.onNavigate };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSessionInboundCampaignForTests();
  setLocation('/');
});
afterEach(() => vi.unstubAllGlobals());

describe('LocaleLink document navigation', () => {
  it.each(['/auth/login', '/settings'])('replaces the marketing document before rendering %s', (href) => {
    const preventDefault = vi.fn();
    setLocation('/fr?utm_source=poster&gclid=click-id');
    const link = renderLink('fr', { href });
    expect(link.html).toContain(`href="/fr${href}"`);
    expect(link.prefetch).toBe(false);
    link.navigate({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledOnce();
    expect(String(assign.mock.calls[0][0])).toBe(`https://www.boardsesh.com/fr${href}?utm_source=poster`);
  });

  it('keeps same-shell navigation in Next', () => {
    const preventDefault = vi.fn();
    const onNavigate = vi.fn();
    renderLink('en-US', { href: '/apps/kilter', onNavigate }).navigate({ preventDefault });
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('reloads an explicitly English guide from a French marketing document', () => {
    setLocation('/fr');
    const link = renderLink('fr', { href: '/apps/kilter', locale: 'en-US' });
    expect(link.html).toContain('href="/apps/kilter"');
    const preventDefault = vi.fn();
    link.navigate({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(String(assign.mock.calls[0][0])).toBe('https://www.boardsesh.com/apps/kilter');
  });

  it('honors a cancelled navigation across documents', () => {
    const preventDefault = vi.fn();
    const link = renderLink('en-US', { href: '/settings', onNavigate: (event) => event.preventDefault() });
    link.navigate({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(assign).not.toHaveBeenCalled();
  });
});

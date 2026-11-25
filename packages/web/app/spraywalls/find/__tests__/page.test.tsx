import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const { fetchDirectory, locale } = vi.hoisted(() => ({ fetchDirectory: vi.fn(), locale: { current: 'en-US' } }));
vi.mock('../directory-data', () => ({ fetchSprayDirectory: fetchDirectory }));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    locale: locale.current,
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
  }),
}));
vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('../spray-directory-explorer', () => ({
  default: ({ children, filters }: { children: React.ReactNode; filters: React.ReactNode }) => (
    <>
      {filters}
      {children}
    </>
  ),
}));
const { default: Page, generateMetadata } = await import('@/app/(site)/spraywalls/find/page');
const wall = {
  uuid: 'wall-1',
  slug: 'crew-wall',
  name: 'Crew wall',
  angle: 40,
  locationName: 'Amsterdam',
  gymName: null,
  latitude: 52,
  longitude: 4,
  distanceMeters: null,
};

beforeEach(() => {
  locale.current = 'en-US';
  fetchDirectory
    .mockReset()
    .mockResolvedValue({ ok: true, connection: { boards: [wall], totalCount: 25, hasMore: true } });
});

describe('spray wall directory SSR', () => {
  it('renders useful text, wall links and pagination before hydration', async () => {
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ angle: '40' }) }));
    const container = document.createElement('div');
    container.innerHTML = html;
    expect(container.querySelector('h1')?.textContent).toBe('Find a spray wall');
    expect(container.querySelector('a[href="/b/crew-wall"]')?.textContent).toBe('Crew wall');
    expect(container.textContent).toContain('Amsterdam');
    expect(container.querySelector('a[rel="next"]')?.getAttribute('href')).toBe('/spraywalls/find?angle=40&page=2');
    expect(container.querySelectorAll('a[href="/spraywalls"]').length).toBeGreaterThan(0);
    expect(container.querySelector('script[type="application/ld+json"]')?.textContent).toContain('BreadcrumbList');
  });

  it('distinguishes an outage from no matching walls, including on later pages', async () => {
    fetchDirectory.mockResolvedValue({ ok: false });
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ page: '2' }) }));
    expect(html).toContain('Spray walls could not load');
    expect(html).not.toContain('0 spray walls');
    expect(html).toContain('/spraywalls/find?page=2');
    fetchDirectory.mockResolvedValue({ ok: true, connection: { boards: [], totalCount: 0, hasMore: false } });
    expect(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }))).toContain(
      'No spray walls here yet',
    );
    await expect(Page({ searchParams: Promise.resolve({ page: '2' }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('rejects deep crawl pages without querying the backend', async () => {
    await expect(Page({ searchParams: Promise.resolve({ page: '41' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(fetchDirectory).not.toHaveBeenCalled();
  });

  it('indexes only the clean page and localizes canonical and social metadata', async () => {
    expect((await generateMetadata({ searchParams: Promise.resolve({}) })).robots).toEqual({
      index: true,
      follow: true,
    });
    locale.current = 'es';
    const metadata = await generateMetadata({ searchParams: Promise.resolve({ q: 'crew', page: '2' }) });
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe('/es/spraywalls/find');
    expect(metadata.openGraph?.url).toBe('/es/spraywalls/find');
    expect(metadata.alternates?.languages).toHaveProperty('zh-CN');
  });
});

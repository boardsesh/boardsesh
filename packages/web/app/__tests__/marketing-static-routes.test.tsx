import { describe, expect, it, vi } from 'vite-plus/test';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '@/app/lib/i18n/config';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: () => {
    throw new Error('Static marketing must not read request headers');
  },
}));
vi.mock('next/font/local', () => ({ default: () => ({ variable: '--font-display' }) }));

const englishRoot = await import('@/app/(marketing)/layout');
const englishHome = await import('@/app/(marketing)/page');
const localizedRoot = await import('@/app/(localized-home)/[board_name]/layout');
const localizedHome = await import('@/app/(localized-home)/[board_name]/page');
const guide = await import('@/app/(marketing)/apps/[slug]/page');

describe('static marketing route inputs', () => {
  it('enforces static English marketing and bounded guide slugs', async () => {
    expect(englishRoot.dynamic).toBe('error');
    expect(englishHome.revalidate).toBe(900);
    expect(guide.dynamicParams).toBe(false);
    expect(guide.generateStaticParams().map(({ slug }) => slug)).toContain('kilter');
    const homeMetadata = await englishHome.generateMetadata();
    expect(homeMetadata.alternates?.canonical).toBe('/');
    expect(new URL(String((await englishRoot.generateMetadata()).metadataBase)).origin).toBe(
      'https://www.boardsesh.com',
    );
  });

  it('enumerates only supported non-default locale homepage URLs', () => {
    expect(localizedHome.generateStaticParams()).toEqual(
      SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE).map((locale) => ({ board_name: locale })),
    );
    expect(localizedRoot.dynamic).toBe('error');
    expect(localizedHome.dynamicParams).toBe(false);
    expect(localizedHome.revalidate).toBe(900);
  });

  it.each(['es', 'fr', 'de', 'it'])(
    'renders /%s with explicit locale metadata and no request reads',
    async (locale) => {
      const params = Promise.resolve({ board_name: locale });
      const metadata = await localizedHome.generateMetadata({ params });
      expect(metadata.alternates?.canonical).toBe(`/${locale}`);
      expect(metadata.other?.['apple-itunes-app']).toContain(`app-argument=https://www.boardsesh.com/${locale}`);
      const document = await localizedRoot.default({ children: null, params });
      expect(document.props.locale).toBe(locale);
      expect((await localizedHome.default({ params })).props.locale).toBe(locale);
    },
  );

  it.each(['kilter', 'en-US', 'xx'])('does not create an extra homepage for /%s', async (segment) => {
    await expect(localizedHome.default({ params: Promise.resolve({ board_name: segment }) })).rejects.toThrow(
      'NEXT_HTTP_ERROR_FALLBACK;404',
    );
  });
});

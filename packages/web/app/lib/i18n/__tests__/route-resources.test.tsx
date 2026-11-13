// @vitest-environment node
import React from 'react';
import { gzipSync } from 'node:zlib';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { useTranslation } from 'react-i18next';
import { loadCatalog } from '@boardsesh/i18n/catalog-loader';
import BoardSlugLayout from '@/app/b/[board_slug]/[angle]/layout';
import ServerI18nProvider from '@/app/components/providers/i18n-provider';
import SiteFooter from '@/app/components/site-chrome/site-footer';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';
import { I18nProvider } from '../client';
import { SUPPORTED_LOCALES, type Locale, type SeedNamespace } from '../config';
import { reportMissingI18nKey } from '../missing-key-reporter';
import { getServerTranslationForLocale } from '../server';

const request = vi.hoisted(() => ({ locale: 'en-US' as Locale }));

vi.mock('server-only', () => ({}));
vi.mock('../get-locale', () => ({ getLocale: async () => request.locale }));
vi.mock('../missing-key-reporter', () => ({ reportMissingI18nKey: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/b/test-board/40/view/test-climb',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/app/components/consent/consent-provider', () => ({
  useConsent: () => ({ granted: true, openChoices: () => {} }),
}));

// The catalogs shipped before route scoping. Keep this baseline independent of
// the new provider defaults so adding unused catalogs cannot pass unnoticed.
const LEGACY_ROOT_NAMESPACES: readonly SeedNamespace[] = [
  'common',
  'consent',
  'playlists',
  'session',
  'auth',
  'settings',
  'boards',
  'climbs',
  'profile',
  'feed',
];

const TRANSLATION_KEYS = [
  'common:header.startClimbing',
  'auth:modal.title',
  'consent:privacyChoices',
  'climbs:frontDoor.cta.climbThis',
  'feed:activityFeed.signInPrompt',
] as const;

function ClimbTranslations() {
  const { t } = useTranslation(['common', 'auth', 'consent', 'climbs', 'feed']);
  return TRANSLATION_KEYS.map((key) => <p key={key}>{t(key)}</p>);
}

function collectResources(node: React.ReactNode): unknown[] {
  if (Array.isArray(node)) return node.flatMap(collectResources);
  if (!React.isValidElement(node)) return [];
  const element = node as React.ReactElement<{
    children?: React.ReactNode;
    resources?: Record<string, Record<string, unknown>>;
  }>;
  return [
    ...(element.type === I18nProvider ? [element.props.resources] : []),
    ...collectResources(element.props.children),
  ];
}

beforeEach(() => vi.clearAllMocks());

describe.each(SUPPORTED_LOCALES)('public climb translations in %s', (locale) => {
  it('renders route copy and shared footer copy in the first HTML', async () => {
    request.locale = locale;
    const tree = await resolveServerTree(
      <ServerI18nProvider locale={locale}>
        <BoardSlugLayout>
          <ClimbTranslations />
        </BoardSlugLayout>
        <SiteFooter />
      </ServerI18nProvider>,
    );
    const html = renderToString(<>{tree}</>);
    const { t } = await getServerTranslationForLocale(locale, ['common', 'auth', 'consent', 'climbs', 'feed']);

    for (const key of TRANSLATION_KEYS) {
      expect(html).toContain(renderToString(<p>{t(key)}</p>));
    }
    expect(html).toContain(t('common:footer.links.gyms'));
    expect(html).toContain(t('consent:privacyChoices'));
    expect(reportMissingI18nKey).not.toHaveBeenCalled();
  });

  it('ships less than half the former compressed translation payload', async () => {
    request.locale = locale;
    const tree = await resolveServerTree(
      <ServerI18nProvider locale={locale}>
        <BoardSlugLayout />
      </ServerI18nProvider>,
    );
    const resources = collectResources(tree);
    const previousResources = Object.fromEntries(
      await Promise.all(
        LEGACY_ROOT_NAMESPACES.map(async (namespace) => [namespace, (await loadCatalog(locale, namespace)).default]),
      ),
    );
    const currentBytes = gzipSync(JSON.stringify(resources)).byteLength;
    const previousBytes = gzipSync(JSON.stringify(previousResources)).byteLength;

    expect(currentBytes).toBeLessThan(previousBytes / 2);
  });
});

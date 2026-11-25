// @vitest-environment node
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadCatalog } from '@boardsesh/i18n/catalog-loader';
import { SUPPORTED_LOCALES } from '@/app/lib/i18n/config';
import { getLocale } from '@/app/lib/i18n/get-locale';
import ServerI18nProvider from '@/app/components/providers/i18n-provider';
import type { Gym } from '@boardsesh/shared-schema';

const { executeAuthenticatedGraphQL } = vi.hoisted(() => ({ executeAuthenticatedGraphQL: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: vi.fn() }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: vi.fn(async () => undefined) }));
vi.mock('@/app/lib/server-board-discovery', () => ({ getBoardDiscovery: vi.fn(async () => []) }));
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/app/components/social/comment-section', () => ({
  default: ({ title }: { title: string }) => <section data-comment-section="true">{title}</section>,
}));
vi.mock('../gym-follow-button', () => ({ default: () => null }));
vi.mock('../gym-install-cta', () => ({ default: () => null }));
vi.mock('../gym-owner-prompts', () => ({ default: () => null }));
vi.mock('../gym-report-duplicate-cta', () => ({ default: () => null }));
vi.mock('../gym-claim-cta', () => ({ default: () => null }));
vi.mock('../gym-claim-param-cleanup', () => ({ default: () => null }));
const GymPage = (await import('@/app/(site)/gym/[gym_slug]/page')).default;

function discussionCopy(catalog: unknown): string | undefined {
  if (!catalog || typeof catalog !== 'object') return;
  const gymPage = (catalog as { gymPage?: unknown }).gymPage;
  if (!gymPage || typeof gymPage !== 'object') return;
  const copy = (gymPage as { startDiscussion?: unknown }).startDiscussion;
  return typeof copy === 'string' ? copy : undefined;
}

beforeEach(() => {
  executeAuthenticatedGraphQL.mockReset();
});

describe.each(SUPPORTED_LOCALES)('fresh gym SSR discussion in %s', (locale) => {
  it.each([0, 2])('renders the correct discussion state with %i comments', async (commentCount) => {
    vi.mocked(getLocale).mockResolvedValue(locale);
    const slug = `discussion-${locale}-${commentCount}`;
    const gym = {
      uuid: `uuid-${slug}`,
      slug,
      name: 'Local climbing gym',
      isPublic: true,
      isClaimed: true,
      canClaim: false,
      canEdit: false,
      boardCount: 0,
      memberCount: 0,
      followerCount: 0,
      commentCount,
    } as Gym;
    executeAuthenticatedGraphQL.mockImplementation(async (document: unknown) => {
      const operation = String(document);
      if (operation.includes('gymBySlug')) return { gymBySlug: gym };
      if (operation.includes('gymSprayWalls')) return { gymSprayWalls: [] };
      if (operation.includes('gymBoards')) return { gymBoards: [] };
      return {};
    });
    const kioskCatalog = await loadCatalog(locale, 'kiosk');
    const gymsCatalog = await loadCatalog(locale, 'gyms');
    const expected = discussionCopy(kioskCatalog.default) ?? discussionCopy(gymsCatalog.default);
    expect(expected).toBeTruthy();
    // Use the real server translators/catalog loader and a fresh server-rendered provider.
    const route = await GymPage({ params: Promise.resolve({ gym_slug: slug }), searchParams: Promise.resolve({}) });
    if (!React.isValidElement<Parameters<typeof ServerI18nProvider>[0]>(route)) throw new Error('Missing gym provider');
    const serialized = await ServerI18nProvider(route.props);
    const html = renderToStaticMarkup(serialized);
    expect(html.match(/data-comment-section="true"/g)).toHaveLength(1);
    expect(html).not.toContain('gymPage.startDiscussion');
    if (commentCount === 0) expect(html).toContain(expected);
    else expect(html).not.toContain(expected);
  });
});

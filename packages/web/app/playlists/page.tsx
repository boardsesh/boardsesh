import React from 'react';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { cachedCommunityPlaylists } from '@/app/lib/graphql/server-cached-client';
import { PageSection, PageShell, StatePanel } from '@/app/components/ui/page-shell';
import PlaylistGrid from './playlist-grid';
import { getPlaylistLcpPreloadUrl } from '@/app/lib/lcp-preload-url';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('playlists');
  return createPageMetadata({
    title: t('metadata.library.title'),
    description: t('metadata.library.description'),
    path: '/playlists',
    locale,
  });
}

/**
 * The public playlists directory.
 *
 * It used to be the signed-out state of the app's library: a client component
 * that read the session, fetched the viewer's own boards and playlists, and led
 * with a "Sign in to use your library" banner in front of content that needs no
 * account. It had no `<h1>` and no `<main>` either, on a page that is indexed
 * and sits in the sitemap.
 *
 * Dropping the personal section took every hook that forced `'use client'` with
 * it, so this is a plain server component now. The only thing the session is
 * still read for is excluding the viewer's own playlists from a page about other
 * people's — and that happens in the query, not in the markup.
 */
export default async function PlaylistsPage() {
  const locale = await getLocale();
  const { t } = await getServerTranslation('playlists');

  // Present only to keep the viewer's own playlists out of a discovery surface.
  // A signed-out visitor — every crawler, and most first-time readers — skips it
  // entirely and shares one warm cache entry.
  //
  // `auth-options` is imported dynamically and only behind the cookie check on
  // purpose: it reaches the database adapter at module load, so a static import
  // would put a DATABASE_URL requirement on this page's module graph — including
  // for `generateMetadata`, which needs no session and no database at all.
  const authToken = await getServerAuthToken();
  let viewerId: string | null = null;
  if (authToken) {
    const [{ getServerSession }, { authOptions }] = await Promise.all([
      import('next-auth/next'),
      import('@/app/lib/auth/auth-options'),
    ]);
    viewerId = (await getServerSession(authOptions))?.user?.id ?? null;
  }

  const streams = await cachedCommunityPlaylists(viewerId);
  const curated = streams?.curated ?? [];
  const community = streams?.community ?? [];
  const lcpPreloadUrl = getPlaylistLcpPreloadUrl(curated[0] ?? community[0]);

  const total = streams?.communityTotalCount ?? 0;
  const lead =
    streams === null || total === 0
      ? t('directory.leadNoCount')
      : t('directory.lead', { count: total, formattedCount: new Intl.NumberFormat(locale).format(total) });

  return (
    <I18nProvider locale={locale} namespaces={['playlists', 'climbs', 'feed']}>
      {lcpPreloadUrl && <link rel="preload" as="image" href={lcpPreloadUrl} fetchPriority="high" />}
      <PageShell width="wide" title={t('directory.h1')} lead={lead}>
        {/* The generated cohort lists lead, and the heading says they are
            generated. They are the best content on the page — 50 climbs each,
            rebuilt nightly — and under the old climb-count sort they ranked
            below every 600-climb "favorites" dump, so nobody ever saw them.
            Hidden entirely when a board has no cohort rather than rendering an
            empty section: coverage is Kilter and Tension only until #5581. */}
        {curated.length > 0 && (
          <PageSection title={t('directory.curated.title')} lead={t('directory.curated.lead')}>
            <PlaylistGrid playlists={curated} priorityCount={4} />
          </PageSection>
        )}

        <PageSection title={t('directory.community.title')} lead={t('directory.community.lead')}>
          {community.length > 0 ? (
            <PlaylistGrid playlists={community} priorityCount={curated.length > 0 ? 0 : 4} />
          ) : (
            <StatePanel
              tone="brand"
              icon={<SearchOutlined />}
              title={t('directory.empty.title')}
              body={t('directory.empty.body')}
              actions={null}
            />
          )}
        </PageSection>
      </PageShell>
    </I18nProvider>
  );
}

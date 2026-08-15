import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/app/lib/auth/auth-options';
import ProfilePageContent from './profile-page-content';
import ProfileJsonLd from './profile-json-ld';
import { getProfileData } from './server-profile-data';
import { fetchProfileStatsData } from './server-profile-stats';
import { getUserBetaLinks } from '@/app/lib/server-user-beta-links';
import { buildVersionedOgImagePath } from '@/app/lib/seo/og';
import { createNoIndexMetadata, createPageMetadata } from '@/app/lib/seo/metadata';
import { getProfileOgSummary } from '@/app/lib/seo/dynamic-og-data';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';

type PageProps = {
  params: Promise<{ user_id: string }>;
};

/**
 * Public profiles stay **indexable**, deliberately: the repo's SEO rules name
 * "public profile" as a search surface, `user_profiles` carries no privacy flag,
 * and the page `notFound()`s for real when the row is missing. What changes here
 * is that the two accidental-index paths close — a profile that 404s and a
 * profile whose data fetch threw are both `noindex, follow` now, where the catch
 * branch used to emit a canonical and no robots at all.
 *
 * Profiles are not sitemapped: they stay link-discovered, so a profile only
 * enters the index once something on the site links to it.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { user_id } = await params;
  // `locale` is load-bearing: without it /es, /fr and /de profiles canonicalise
  // onto their en-US twins.
  const { t, locale } = await getServerTranslation('profile');
  const path = `/profile/${encodeURIComponent(user_id)}`;

  try {
    const summary = await getProfileOgSummary(user_id);

    if (!summary) {
      return createNoIndexMetadata({
        title: t('metadata.profile.notFoundTitle'),
        description: t('metadata.profile.notFoundDescription'),
        path,
        locale,
        imagePath: null,
      });
    }

    const displayName = summary.displayName;
    // Lead with what people search for — a climber's name plus the board they
    // actually climb on — instead of a bare "{name} | Boardsesh".
    const title = summary.topBoardType
      ? t('metadata.profile.titleWithBoard', {
          name: displayName,
          board: formatBoardDisplayName(summary.topBoardType),
        })
      : t('metadata.profile.title', { name: displayName });

    return createPageMetadata({
      title,
      description: t('metadata.profile.description', { name: displayName }),
      path,
      locale,
      openGraphType: 'profile',
      imagePath: buildVersionedOgImagePath('/api/og/profile', { user_id }, summary.version),
      imageAlt: t('metadata.profile.ogAlt', { name: displayName }),
    });
  } catch {
    return createNoIndexMetadata({
      title: t('metadata.profile.fallbackTitle'),
      description: t('metadata.profile.fallbackDescription'),
      path,
      locale,
      imagePath: null,
    });
  }
}

export default async function ProfilePage({ params }: PageProps) {
  const { user_id } = await params;

  // Only check session if auth cookie exists (skip for anonymous visitors)
  const authToken = await getServerAuthToken();
  let viewerUserId: string | undefined;
  if (authToken) {
    const session = await getServerSession(authOptions);
    viewerUserId = session?.user?.id;
  }

  const initialProfile = await getProfileData(user_id, viewerUserId);

  if (!initialProfile) {
    notFound();
  }

  const [statsData, initialUserBeta, locale] = await Promise.all([
    fetchProfileStatsData(user_id),
    getUserBetaLinks(user_id),
    getLocale(),
  ]);

  return (
    <I18nProvider locale={locale} namespaces={['profile', 'feed']}>
      {/* Success path only — the notFound() above and the metadata catch branch
          are both `noindex, follow`, and neither reaches here. */}
      <ProfileJsonLd
        userId={user_id}
        displayName={initialProfile.profile?.displayName || initialProfile.name || null}
        locale={locale}
      />
      <ProfilePageContent
        userId={user_id}
        initialProfile={initialProfile}
        initialProfileStats={statsData.initialProfileStats}
        initialPercentile={statsData.initialPercentile}
        initialAllBoardsTicks={statsData.initialAllBoardsTicks}
        initialLogbook={statsData.initialLogbook}
        initialIsOwnProfile={viewerUserId === user_id}
        initialUserBeta={initialUserBeta}
      />
    </I18nProvider>
  );
}

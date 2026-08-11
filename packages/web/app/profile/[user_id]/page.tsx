import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/app/lib/auth/auth-options';
import ProfilePageContent from './profile-page-content';
import { getProfileData } from './server-profile-data';
import { fetchProfileStatsData } from './server-profile-stats';
import { getUserBetaLinks } from '@/app/lib/server-user-beta-links';
import { buildVersionedOgImagePath, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from '@/app/lib/seo/og';
import { getProfileOgSummary } from '@/app/lib/seo/dynamic-og-data';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';

type PageProps = {
  params: Promise<{ user_id: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { user_id } = await params;
  const { t } = await getServerTranslation('profile');

  try {
    const summary = await getProfileOgSummary(user_id);

    if (!summary) {
      return {
        title: `${t('metadata.profile.notFoundTitle')} | Boardsesh`,
        description: t('metadata.profile.notFoundDescription'),
        robots: { index: false, follow: false },
      };
    }

    const displayName = summary.displayName;
    const description = t('metadata.profile.description', { name: displayName });
    const ogImagePath = buildVersionedOgImagePath('/api/og/profile', { user_id }, summary.version);

    return {
      title: `${displayName} | Boardsesh`,
      description,
      alternates: { canonical: `/profile/${user_id}` },
      openGraph: {
        title: `${displayName} | Boardsesh`,
        description,
        type: 'profile',
        url: `/profile/${user_id}`,
        images: [
          {
            url: ogImagePath,
            width: OG_IMAGE_WIDTH,
            height: OG_IMAGE_HEIGHT,
            alt: t('metadata.profile.ogAlt', { name: displayName }),
          },
        ],
      },
      twitter: {
        card: 'summary_large_image',
        title: `${displayName} | Boardsesh`,
        description,
        images: [ogImagePath],
      },
    };
  } catch {
    return {
      title: `${t('metadata.profile.fallbackTitle')} | Boardsesh`,
      description: t('metadata.profile.fallbackDescription'),
      alternates: { canonical: `/profile/${user_id}` },
    };
  }
}

export default async function ProfilePage({ params }: PageProps) {
  const { user_id } = await params;

  // Only check session if auth cookie exists (skip for anonymous visitors)
  const authToken = await getServerAuthToken();
  let viewerUserId: string | undefined;
  let viewerEmail: string | undefined;
  if (authToken) {
    const session = await getServerSession(authOptions);
    viewerUserId = session?.user?.id;
    viewerEmail = session?.user?.email ?? undefined;
  }

  // The backend derives isFollowedByMe from the bearer token, so the viewer's
  // token is what the read needs. viewerUserId only seeds the client's
  // "is this me?" flag and the own-profile email below.
  const publicProfile = await getProfileData(user_id, authToken ?? undefined);

  if (!publicProfile) {
    notFound();
  }

  const isOwnProfile = viewerUserId === user_id;
  // `publicProfile` never carries an email — on your own profile it comes from
  // your session instead, which is the only place it's rendered.
  const initialProfile = isOwnProfile ? { ...publicProfile, email: viewerEmail } : publicProfile;

  const [statsData, initialUserBeta, locale] = await Promise.all([
    fetchProfileStatsData(user_id),
    getUserBetaLinks(user_id),
    getLocale(),
  ]);

  return (
    <I18nProvider locale={locale} namespaces={['profile', 'feed']}>
      <ProfilePageContent
        userId={user_id}
        initialProfile={initialProfile}
        initialProfileStats={statsData.initialProfileStats}
        initialPercentile={statsData.initialPercentile}
        initialAllBoardsTicks={statsData.initialAllBoardsTicks}
        initialLogbook={statsData.initialLogbook}
        initialIsOwnProfile={isOwnProfile}
        initialUserBeta={initialUserBeta}
      />
    </I18nProvider>
  );
}

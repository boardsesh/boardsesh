import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { getAdmittedServerSession } from '@/app/lib/auth/admitted-session.server';
import ProfilePageContent from './profile-page-content';
import ProfileJsonLd from './profile-json-ld';
import { getProfileData } from './server-profile-data';
import { fetchProfileStatsData } from './server-profile-stats';
import { getUserBetaLinks } from '@/app/lib/server-user-beta-links';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { createNoIndexMetadata, createPageMetadata } from '@/app/lib/seo/metadata';
import { getProfileOgSummary, type ProfileOgSummary } from '@/app/lib/seo/dynamic-og-data';
import { buildOgFamilyImageUrl } from '@/app/lib/seo/og-family';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';

type PageProps = {
  params: Promise<{ user_id: string }>;
};

type ProfileTranslate = Awaited<ReturnType<typeof getServerTranslation>>['t'];

/**
 * What a chat app shows above the card: the hardest send, as the card's hero
 * does. Separate from the search title, which leads with what people type.
 */
function buildProfileShareCopy(
  summary: ProfileOgSummary,
  displayName: string,
  locale: string,
  t: ProfileTranslate,
): { ogTitle: string; ogDescription: string } {
  const boards = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
    summary.sentBoardTypes.map(boardTypeLabel),
  );
  const count = summary.sentClimbCount;
  const { hardestSend } = summary;

  if (hardestSend?.grade) {
    return {
      ogTitle: t('metadata.profile.ogTitleSent', { name: displayName, grade: hardestSend.grade }),
      ogDescription: t('metadata.profile.ogDescriptionHardest', { count, climb: hardestSend.climbName, boards }),
    };
  }
  const ogTitle = t('metadata.profile.ogTitleNoSends', { name: displayName });
  // Sends with none to name: every one can be on a community-hidden climb,
  // which a card never features but the public stats still count.
  if (count > 0) return { ogTitle, ogDescription: t('metadata.profile.ogDescriptionCount', { count, boards }) };
  return { ogTitle, ogDescription: t('metadata.profile.ogDescriptionNoSends') };
}

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

    const displayName = summary.displayName ?? t('page.displayNameFallback');
    // Lead with what people search for — a climber's name plus the board they
    // actually climb on — instead of a bare "{name} | Boardsesh".
    const title = summary.topBoardType
      ? t('metadata.profile.titleWithBoard', {
          name: displayName,
          board: formatBoardDisplayName(summary.topBoardType),
        })
      : t('metadata.profile.title', { name: displayName });

    const { ogTitle, ogDescription } = buildProfileShareCopy(summary, displayName, locale, t);
    // A private profile returned null above, which is the backend card's own gate.
    const imageUrl = buildOgFamilyImageUrl('profile', { user_id }, summary.version);

    return createPageMetadata({
      title,
      description: t('metadata.profile.description', { name: displayName }),
      ogTitle,
      ogDescription,
      path,
      locale,
      openGraphType: 'profile',
      ...(imageUrl ? { imagePath: imageUrl } : {}),
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
    const session = await getAdmittedServerSession();
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
      {!initialProfile.isPrivate && (
        <ProfileJsonLd
          userId={user_id}
          displayName={initialProfile.profile?.displayName || initialProfile.name || null}
          locale={locale}
        />
      )}
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

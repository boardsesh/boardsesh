import React from 'react';
import type { Metadata } from 'next';
import JoinRedirect from './join-redirect';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from '@/app/lib/seo/og';
import { getSessionOgSummary } from '@/app/lib/seo/dynamic-og-data';
import { buildSessionJoinShareCopy, buildSessionOgImageUrl } from '@/app/lib/seo/session-share-copy';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';

type Props = {
  params: Promise<{ sessionId: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { sessionId: rawSessionId } = await params;
  const sessionId = decodeURIComponent(rawSessionId);
  const { t, locale } = await getServerTranslation('session');

  try {
    const summary = await getSessionOgSummary(sessionId);

    if (!summary.found) {
      return { title: `${t('metadata.detail.notFoundTitle')} | Boardsesh` };
    }

    // A live session invites; an ended one recaps, and never says Join.
    const { ogTitle, ogDescription } = buildSessionJoinShareCopy(summary, locale, t);
    const title = `${ogTitle} | Boardsesh`;
    const ogImageUrl = buildSessionOgImageUrl(sessionId, summary, 'join');

    return {
      title,
      description: ogDescription,
      robots: { index: false, follow: true },
      openGraph: {
        title: ogTitle,
        description: ogDescription,
        type: 'website',
        url: `/join/${sessionId}`,
        images: ogImageUrl
          ? [
              {
                url: ogImageUrl,
                width: OG_IMAGE_WIDTH,
                height: OG_IMAGE_HEIGHT,
                alt: ogTitle,
              },
            ]
          : undefined,
      },
      twitter: {
        card: 'summary_large_image',
        title: ogTitle,
        description: ogDescription,
        images: ogImageUrl ? [ogImageUrl] : undefined,
      },
    };
  } catch {
    return {
      title: `${t('metadata.join.title')} | Boardsesh`,
      description: t('metadata.join.description'),
      robots: { index: false, follow: true },
    };
  }
}

export default async function JoinSessionPage({ params }: Props) {
  const { sessionId: rawSessionId } = await params;
  const sessionId = decodeURIComponent(rawSessionId);
  const locale = await getLocale();

  const joinUrl = `/api/internal/join/${encodeURIComponent(sessionId)}`;

  return (
    <I18nProvider locale={locale} namespaces={['session']}>
      <noscript>
        <meta httpEquiv="refresh" content={`0;url=${joinUrl}`} />
      </noscript>
      <JoinRedirect sessionId={sessionId} />
    </I18nProvider>
  );
}

import React from 'react';
import type { Metadata } from 'next';
import { GraphQLClient } from 'graphql-request';
import { getGraphQLHttpUrl } from '@/app/lib/graphql/client';
import { GET_SESSION_DETAIL, type GetSessionDetailQueryResponse } from '@boardsesh/graphql/operations/activity-feed';
import SessionDetailContent from './session-detail-content';
import { buildVersionedOgImagePath } from '@/app/lib/seo/og';
import { createNoIndexMetadata, createPageMetadata } from '@/app/lib/seo/metadata';
import { getSessionOgSummary } from '@/app/lib/seo/dynamic-og-data';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';

type Props = {
  params: Promise<{ sessionId: string }>;
};

const fetchSessionDetail = React.cache(async (sessionId: string) => {
  const url = getGraphQLHttpUrl();
  const client = new GraphQLClient(url);
  try {
    const data = await client.request<GetSessionDetailQueryResponse>(GET_SESSION_DETAIL, {
      sessionId,
    });
    return data.sessionDetail;
  } catch (err) {
    console.error('[SessionDetailPage] Failed to fetch session:', sessionId, err);
    return null;
  }
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { sessionId: rawSessionId } = await params;
  const sessionId = decodeURIComponent(rawSessionId);
  const summary = await getSessionOgSummary(sessionId);
  const { t, locale } = await getServerTranslation('session');
  const path = `/session/${encodeURIComponent(sessionId)}`;

  if (!summary.found) {
    return createNoIndexMetadata({
      title: t('metadata.detail.notFoundTitle'),
      description: t('metadata.detail.notFoundDescription'),
      path,
      locale,
      imagePath: null,
    });
  }

  const participantNames = summary.participantNames.join(', ');
  const sessionName = summary.sessionName;

  let description: string;
  if (summary.totalSends > 0) {
    const stats = t('detail.subtitleSends', { count: summary.totalSends });
    description = participantNames ? `${participantNames} — ${stats}` : stats;
  } else {
    description = participantNames
      ? t('detail.participantsClimbing', { names: participantNames })
      : t('detail.sessionNameOnBoardsesh', { name: sessionName });
  }

  // Indexability is deliberately unchanged: this is the kept public share
  // surface, so flipping it to noindex is a product decision, not a hreflang
  // fix. All that changes here is that the canonical now carries its locale and
  // the full alternates set.
  return createPageMetadata({
    title: sessionName,
    description,
    path,
    locale,
    imagePath: buildVersionedOgImagePath('/api/og/session', { sessionId }, summary.version),
    imageAlt: sessionName,
  });
}

export default async function SessionDetailPage({ params }: Props) {
  const { sessionId: rawSessionId } = await params;
  const sessionId = decodeURIComponent(rawSessionId);
  const session = await fetchSessionDetail(sessionId);
  const locale = await getLocale();

  // `climbs` is seeded alongside `session` because StaticClimbRow's ClimbTitle
  // reads that namespace on the server. Without it the share page's first HTML
  // carries raw `card.title.*` keys until the lazy catalog fetch lands.
  return (
    <I18nProvider locale={locale} namespaces={['session', 'climbs']}>
      <SessionDetailContent session={session} sessionId={sessionId} />
    </I18nProvider>
  );
}

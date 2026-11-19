import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  RESOLVE_PARTNER_SESSION_HISTORY,
  type ResolvePartnerSessionHistoryResponse,
} from '@boardsesh/graphql/operations/partner-session-history';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';

type Props = { params: Promise<{ exportId: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { exportId } = await params;
  const { t, locale } = await getServerTranslation('session');
  return createNoIndexMetadata({
    title: t('partnerHistory.title'),
    description: t('partnerHistory.description'),
    path: `/history/session/${encodeURIComponent(exportId)}`,
    locale,
  });
}

export default async function PartnerSessionHistoryPage({ params }: Props) {
  const { exportId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(exportId)) notFound();
  const { locale } = await getServerTranslation('session');
  const token = await getServerAuthToken();
  if (!token) {
    const returnPath = localeHref(`/history/session/${exportId}`, locale);
    redirect(`${localeHref('/auth/login', locale)}?callbackUrl=${encodeURIComponent(returnPath)}`);
  }
  const response = await executeAuthenticatedGraphQL<ResolvePartnerSessionHistoryResponse>(
    RESOLVE_PARTNER_SESSION_HISTORY,
    { exportId },
    token,
  );
  if (!response.resolvePartnerSessionHistory) notFound();
  // Only the authenticated owner/participant receives the internal detail ID.
  // The partner URL remains an opaque reference and can never join a session.
  redirect(localeHref(`/session/${encodeURIComponent(response.resolvePartnerSessionHistory)}`, locale));
}

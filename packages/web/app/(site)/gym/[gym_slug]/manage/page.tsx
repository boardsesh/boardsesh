import React, { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, redirect, permanentRedirect } from 'next/navigation';
import Container from '@mui/material/Container';
import type { Gym, MyGymClaim } from '@boardsesh/shared-schema';
import {
  GET_GYM,
  GET_GYM_BY_SLUG,
  GET_GYM_PENDING_CLAIM,
  type GetGymQueryResponse,
  type GetGymBySlugQueryResponse,
  type GetGymPendingClaimQueryResponse,
} from '@boardsesh/graphql/operations';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { looksLikeGymUuid } from '@/app/components/gym-entity/manage/slug-utils';
import ManageGymContent from '@/app/gym/[gym_slug]/manage/manage-gym-content';
import ManageNoAccess from '@/app/gym/[gym_slug]/manage/manage-no-access';
import { gymClaimOpenToViewer } from '@/app/gym/[gym_slug]/manage/manage-no-access-logic';
import { isDirectoryReportsEnabled } from '@/app/lib/directory-reports/directory-reports-flag';
import { getGymMcpAvailability } from '@/app/lib/gym-mcp/availability.server';

// Per-user, cookie-gated management surface — never static, never indexed.
export const dynamic = 'force-dynamic';

type ManageGymRouteProps = {
  params: Promise<{ gym_slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * Resolve the gym for the manage shell by slug first, then by UUID. Slug-less
 * (legacy) gyms are addressed by UUID so their slug-guard banner is reachable;
 * generated slugs are never UUID-shaped, so the two never collide. Request-deduped
 * so generateMetadata and the page body share one round-trip.
 */
const resolveManageGym = cache(async (slugOrUuid: string, token: string): Promise<Gym | null> => {
  try {
    const bySlug = await executeAuthenticatedGraphQL<GetGymBySlugQueryResponse>(
      GET_GYM_BY_SLUG,
      { slug: slugOrUuid },
      token,
    );
    if (bySlug.gymBySlug) {
      return bySlug.gymBySlug;
    }
  } catch (error) {
    console.error('resolveManageGym by slug failed:', error);
  }

  if (looksLikeGymUuid(slugOrUuid)) {
    try {
      const byUuid = await executeAuthenticatedGraphQL<GetGymQueryResponse>(GET_GYM, { gymUuid: slugOrUuid }, token);
      return byUuid.gym ?? null;
    } catch (error) {
      console.error('resolveManageGym by uuid failed:', error);
    }
  }
  return null;
});

/**
 * The viewer's own claim in flight, for the lock state: its own document and its
 * own catch, as on the public gym page, so a backend that can't answer it costs
 * the notice and nothing else. Only asked where a Claim button could show, so
 * never on a gym its staff run.
 */
async function fetchMyPendingClaim(gym: Gym, token: string): Promise<MyGymClaim | null> {
  if (!gymClaimOpenToViewer(gym) || !gym.slug) return null;
  try {
    const response = await executeAuthenticatedGraphQL<GetGymPendingClaimQueryResponse>(
      GET_GYM_PENDING_CLAIM,
      { slug: gym.slug },
      token,
    );
    return response.gymBySlug?.myPendingClaim ?? null;
  } catch (error) {
    console.error('manage fetchMyPendingClaim failed:', error);
    return null;
  }
}

export async function generateMetadata(props: ManageGymRouteProps): Promise<Metadata> {
  const { gym_slug } = await props.params;
  const { t, locale } = await getServerTranslation('kiosk');
  const token = await getServerAuthToken();
  const gym = token ? await resolveManageGym(gym_slug, token) : null;
  // Only editors get the gym's name in the title — gymBySlug returns private
  // gyms to any authenticated viewer, and the name must not leak through
  // metadata for a page whose body 404s them.
  const title = gym && gym.canEdit ? t('manage.title', { gymName: gym.name }) : t('metadata.fallbackTitle');
  return createNoIndexMetadata({
    title,
    description: t('metadata.fallbackDescription'),
    path: `/gym/${gym_slug}/manage`,
    locale,
  });
}

export default async function ManageGymPage(props: ManageGymRouteProps) {
  const { gym_slug } = await props.params;
  const { tab } = await props.searchParams;
  const token = await getServerAuthToken();

  if (!token) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(`/gym/${gym_slug}/manage`)}`);
  }

  const gym = await resolveManageGym(gym_slug, token);
  // Match the public page's visibility contract: a private gym must be
  // indistinguishable from a missing one for viewers who can't edit it — a 403
  // here would confirm the gym exists.
  if (!gym || (!gym.isPublic && !gym.canEdit)) {
    notFound();
  }

  // A merged twin's slug resolved to the canonical gym under a different slug:
  // redirect the manage URL onto the canonical slug. Skip when the URL segment is
  // a UUID — that's the deliberate slug-less-gym-by-uuid addressing path, not a
  // stale twin slug. Carry the ?tab= param so a tab-carrying deep-link (e.g. a
  // stale ?tab=members link) lands on the right tab after the redirect.
  if (gym.slug && gym.slug !== gym_slug && !looksLikeGymUuid(gym_slug)) {
    const tabQuery = typeof tab === 'string' && tab ? `?tab=${encodeURIComponent(tab)}` : '';
    permanentRedirect(`/gym/${gym.slug}/manage${tabQuery}`);
  }

  const locale = await getLocale();

  // Public gym, but this viewer can't manage it: who can, and what to do instead.
  if (!gym.canEdit) {
    const [reportsEnabled, pendingClaim] = await Promise.all([
      isDirectoryReportsEnabled(),
      fetchMyPendingClaim(gym, token),
    ]);
    return (
      <I18nProvider locale={locale} namespaces={['common', 'boards', 'kiosk', 'gyms']}>
        <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
          <ManageNoAccess gym={gym} reportsEnabled={reportsEnabled} pendingClaim={pendingClaim} />
        </Container>
      </I18nProvider>
    );
  }

  const aiAssistants = await getGymMcpAvailability();
  return (
    <I18nProvider locale={locale} namespaces={['common', 'boards', 'kiosk', 'gyms']}>
      <ManageGymContent
        initialGym={gym}
        aiAssistantsAvailable={aiAssistants.enabled}
        aiAssistantsInvitationRequired={aiAssistants.invitationRequired}
      />
    </I18nProvider>
  );
}

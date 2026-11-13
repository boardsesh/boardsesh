'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Container from '@mui/material/Container';
import {
  GET_GYM,
  GET_GYM_BY_SLUG,
  type GetGymQueryResponse,
  type GetGymBySlugQueryResponse,
} from '@boardsesh/graphql/operations';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
import { browserBackendSessionKey } from '@boardsesh/auth-protocol/browser-backend-session';
import SelectedPrivateView from '@/app/components/auth/selected-private-view';
import { looksLikeGymUuid } from '@/app/components/gym-entity/manage/slug-utils';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import ManageGymContent from './manage-gym-content';

function SelectedGymLoader({ slugOrUuid }: { slugOrUuid: string }) {
  const { t } = useTranslation('kiosk');
  const router = useRouter();
  const { token } = useWsAuthToken();
  const { data: gym } = useQuery({
    queryKey: ['selected-manage-gym', slugOrUuid],
    enabled: token !== null,
    queryFn: async () => {
      const client = createGraphQLHttpClient(token);
      const bySlug = await client.request<GetGymBySlugQueryResponse>(GET_GYM_BY_SLUG, { slug: slugOrUuid });
      if (bySlug.gymBySlug) return bySlug.gymBySlug;
      if (!looksLikeGymUuid(slugOrUuid)) return null;
      const byUuid = await client.request<GetGymQueryResponse>(GET_GYM, { gymUuid: slugOrUuid });
      return byUuid.gym;
    },
  });
  useEffect(() => {
    if (!gym?.canEdit || !gym.slug || gym.slug === slugOrUuid || looksLikeGymUuid(slugOrUuid)) return;
    // Preserve the tab and locale from the current URL, without accepting an
    // origin or navigation target from a backend response.
    const destination = new URL(window.location.href);
    const segments = destination.pathname.split('/');
    segments[segments.length - 2] = encodeURIComponent(gym.slug);
    destination.pathname = segments.join('/');
    router.replace(`${destination.pathname}${destination.search}`, { scroll: false });
  }, [gym, router, slugOrUuid]);
  if (gym === undefined) return null;
  if (!gym || !gym.canEdit)
    return (
      <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
        <Alert severity="error">{t('manage.accessDenied')}</Alert>
      </Container>
    );
  return <ManageGymContent initialGym={gym} />;
}

/** Only public route metadata crosses Flight; the owned HTTP transport checks
 * this client's original receipt before/after headers and body consumption. */
export default function SelectedManageGym({
  slugOrUuid,
  owner,
}: {
  slugOrUuid: string;
  owner: BrowserBackendLeaseOwner;
}) {
  return (
    <SelectedPrivateView expectedOwner={owner}>
      <SelectedGymLoader key={browserBackendSessionKey(owner)} slugOrUuid={slugOrUuid} />
    </SelectedPrivateView>
  );
}

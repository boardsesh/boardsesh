'use client';

import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useBrowserSession } from '@/app/components/providers/session-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { GET_RECENT_BETA_LINKS } from '@boardsesh/graphql/operations/beta-links';
import { mapBetaLinkRow } from '@/app/lib/beta-video-url';
import { getDefaultClimbViewPath } from '@/app/lib/default-board-configs';
import type { BoardName } from '@/app/lib/types';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import type { RecentBetaLinkRow } from '@/app/lib/server-recent-beta-links';
import BoardseshBetaList from './boardsesh-beta-list';
import MarketingQueryProvider from '../marketing/marketing-query-provider';

const RECENT_BETA_LIMIT = 20;
const RECENT_BETA_STALE_TIME_MS = 5 * 60 * 1000;

type RecentBetaResponse = {
  recentBetaLinks: RecentBetaLinkRow[];
};

export default function HomeRecentBetaContent() {
  return (
    <MarketingQueryProvider>
      <RecentBetaContent />
    </MarketingQueryProvider>
  );
}

function RecentBetaContent() {
  const { data: session, status } = useBrowserSession();
  const { token, isLoading: isTokenLoading } = useWsAuthToken(status === 'authenticated');
  const sessionUserId = session?.user?.id ?? null;
  const authSessionId = session?.authSessionId ?? null;
  const canFetch = status === 'unauthenticated' || (status === 'authenticated' && token !== null);
  const { data: rows = [], isPending } = useQuery<RecentBetaLinkRow[]>({
    queryKey: ['recentBetaLinks', status, sessionUserId, authSessionId],
    queryFn: async () => {
      const client = createGraphQLHttpClient(status === 'authenticated' ? token : null);
      const result = await client.request<RecentBetaResponse>(GET_RECENT_BETA_LINKS, { limit: RECENT_BETA_LIMIT });
      return result.recentBetaLinks;
    },
    enabled: canFetch,
    staleTime: RECENT_BETA_STALE_TIME_MS,
  });
  const isLoading = status === 'loading' || isTokenLoading || (canFetch && isPending);

  const { links, climbNameByLink, climbHrefByLink } = useMemo(() => {
    const mapped: BetaLink[] = [];
    const nameByLink = new Map<string, string | null>();
    const hrefByLink = new Map<string, string | null>();
    for (const row of rows) {
      const link = mapBetaLinkRow(row.betaLink);
      if (!link.thumbnail) continue;
      mapped.push(link);
      nameByLink.set(link.link, row.climbName);
      const href =
        row.layoutId != null && link.angle != null
          ? getDefaultClimbViewPath(
              row.boardType as BoardName,
              row.layoutId,
              link.angle,
              link.climb_uuid,
              row.climbName ?? undefined,
            )
          : null;
      hrefByLink.set(link.link, href);
    }
    return { links: mapped, climbNameByLink: nameByLink, climbHrefByLink: hrefByLink };
  }, [rows]);

  if (!isLoading && links.length === 0) return null;

  return (
    <BoardseshBetaList
      links={links}
      isLoading={isLoading}
      source="home"
      getClimbName={(link) => climbNameByLink.get(link.link)}
      getClimbHref={(link) => climbHrefByLink.get(link.link)}
    />
  );
}

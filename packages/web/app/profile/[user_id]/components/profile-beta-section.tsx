'use client';

import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { themeTokens } from '@/app/theme/theme-config';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_USER_BETA_LINKS } from '@boardsesh/graphql/operations/beta-links';
import { mapBetaLinkRow } from '@/app/lib/beta-video-url';
import { getDefaultClimbViewPath } from '@/app/lib/default-board-configs';
import type { BoardName } from '@/app/lib/types';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import type { RecentBetaLinkRow } from '@/app/lib/server-recent-beta-links';
import BoardseshBetaList from '@/app/components/beta-videos/boardsesh-beta-list';

type ProfileBetaSectionProps = {
  userId: string;
  initialBeta: RecentBetaLinkRow[];
};

const USER_BETA_LIMIT = 50;
const USER_BETA_STALE_TIME_MS = 5 * 60 * 1000;

type UserBetaResponse = {
  userBetaLinks: RecentBetaLinkRow[];
};

export default function ProfileBetaSection({ userId, initialBeta }: ProfileBetaSectionProps) {
  const { t } = useTranslation('profile');
  const { token } = useWsAuthToken();

  const { data: rows = [] } = useQuery<RecentBetaLinkRow[]>({
    queryKey: ['userBetaLinks', userId],
    queryFn: async ({ signal }) => {
      const client = createGraphQLHttpClient(token);
      const result = await client.request<UserBetaResponse>({
        document: GET_USER_BETA_LINKS,
        variables: { userId, limit: USER_BETA_LIMIT },
        signal,
      });
      return result.userBetaLinks;
    },
    initialData: initialBeta,
    staleTime: USER_BETA_STALE_TIME_MS,
  });

  const { links, climbNameByLink, climbHrefByLink } = useMemo(() => {
    const mapped: BetaLink[] = [];
    const nameByLink = new Map<string, string | null>();
    const hrefByLink = new Map<string, string | null>();
    for (const row of rows) {
      const link = mapBetaLinkRow(row.betaLink);
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

  if (links.length === 0) return null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, width: '100%' }}>
      <Typography
        variant="body2"
        fontWeight={themeTokens.typography.fontWeight.semibold}
        sx={{
          color: themeTokens.neutral[400],
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontSize: themeTokens.typography.fontSize.xs,
          px: 0.5,
        }}
      >
        {t('page.betaVideos')}
      </Typography>
      <BoardseshBetaList
        links={links}
        isLoading={false}
        source="profile"
        getClimbName={(link) => climbNameByLink.get(link.link)}
        getClimbHref={(link) => climbHrefByLink.get(link.link)}
      />
    </Box>
  );
}

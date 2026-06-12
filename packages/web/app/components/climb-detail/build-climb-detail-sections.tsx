'use client';

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import VideocamOutlined from '@mui/icons-material/VideocamOutlined';
import Box from '@mui/material/Box';
import type { CollapsibleSectionConfig } from '@/app/components/collapsible-section/collapsible-section';
import { LogbookSection, useLogbookSummary } from '@/app/components/logbook/logbook-section';
import { CrewLogbookView } from '@/app/components/logbook/crew-logbook-view';
import ClimbSocialSection from '@/app/components/social/climb-social-section';
import ClimbAnalytics from '@/app/components/charts/climb-analytics';
import BoardseshBetaList from '@/app/components/beta-videos/boardsesh-beta-list';
import BoardseshBetaAddPanel from '@/app/components/beta-videos/boardsesh-beta-add-panel';
import BoardseshBetaAddButton from '@/app/components/beta-videos/boardsesh-beta-add-button';
import SimilarClimbsList from '@/app/components/similar-climbs/similar-climbs-list';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_BETA_LINKS } from '@boardsesh/graphql/operations/beta-links';
import { dedupeBetaLinks, mapBetaLinksResponse } from '@/app/lib/beta-video-url';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import type { BoardDetails, BoardName, Climb } from '@/app/lib/types';

type BuildClimbDetailSectionsProps = {
  climb: Climb;
  climbUuid: string;
  boardType: string;
  angle: number;
  /** Route-supplied layout id. In single-board contexts `climb.layoutId` is
   *  intentionally absent (it's only populated in multi-board listings), so the
   *  section relies on the caller passing the layout from the URL params. */
  layoutId: number;
  /** Route-supplied board details (size + sets + layout). Drives the
   *  similar-climbs section's thumbnail rendering — compatible candidates
   *  render at the viewer's wall config, incompatible ones fall back to
   *  the layout's default config. */
  viewerBoardDetails?: BoardDetails;
  currentClimbDifficulty?: string;
  boardName?: string;
  /** When false, returns empty sections immediately. Used to defer below-fold
   *  rendering until after the drawer open animation completes. */
  enabled?: boolean;
};

export function useBuildClimbDetailSections({
  climb,
  climbUuid,
  boardType,
  angle,
  layoutId,
  viewerBoardDetails,
  currentClimbDifficulty,
  boardName,
  enabled: enabledProp = true,
}: BuildClimbDetailSectionsProps): CollapsibleSectionConfig[] {
  const { t } = useTranslation('climbs');
  const betaLabel = (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
      <VideocamOutlined sx={{ fontSize: 16 }} />
      {t('detail.sections.beta')}
    </Box>
  );
  const betaTitle = (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      <VideocamOutlined sx={{ fontSize: 22 }} />
      {t('detail.sections.beta')}
    </Box>
  );
  const searchParams = useSearchParams();
  const highlightProposalUuid = searchParams.get('proposalUuid') ?? undefined;
  const logbookSummary = useLogbookSummary(climb.uuid);
  const [isAddingBeta, setIsAddingBeta] = useState(false);

  const { data: betaLinks = [], isLoading: betaLinksLoading } = useQuery<BetaLink[]>({
    queryKey: ['betaLinks', boardType, climbUuid],
    queryFn: async () => {
      const client = createGraphQLHttpClient();
      const result = await client.request<{ betaLinks: Parameters<typeof mapBetaLinksResponse>[0] }>(GET_BETA_LINKS, {
        boardType,
        climbUuid,
      });
      return mapBetaLinksResponse(result.betaLinks);
    },
    enabled: enabledProp && !!climbUuid,
    staleTime: 5 * 60 * 1000,
  });
  const dedupedBetaLinks = useMemo(() => dedupeBetaLinks(betaLinks), [betaLinks]);
  const betaCount = dedupedBetaLinks.length;

  if (!enabledProp) return [];

  const getLogbookSummaryParts = (): string[] => {
    if (!logbookSummary) return [];

    const parts: string[] = [];
    parts.push(`${logbookSummary.totalAttempts} attempt${logbookSummary.totalAttempts !== 1 ? 's' : ''}`);

    if (logbookSummary.successfulAscents > 0) {
      parts.push(`${logbookSummary.successfulAscents} send${logbookSummary.successfulAscents !== 1 ? 's' : ''}`);
    }

    return parts;
  };

  return [
    {
      key: 'beta',
      label: betaLabel,
      title: betaTitle,
      defaultSummary: 'No videos yet',
      getSummary: () => (betaCount > 0 ? [`${betaCount} video${betaCount !== 1 ? 's' : ''}`] : []),
      // Beta is the headline content the user opens the drawer for — keep
      // it expanded alongside whatever single-active section they pick.
      // defaultActive still fires (no proposalUuid → beta is the
      // accordion's "active" section too, harmless and keeps fallback
      // styling correct).
      defaultActive: !highlightProposalUuid,
      keepExpanded: true,
      flush: true,
      lazy: true,
      action: <BoardseshBetaAddButton isAdding={isAddingBeta} onToggle={() => setIsAddingBeta((v) => !v)} />,
      content: (
        <Box aria-live="polite">
          {isAddingBeta ? (
            <BoardseshBetaAddPanel
              boardType={boardType}
              climbUuid={climbUuid}
              climbName={climb.name}
              angle={angle}
              grade={climb.difficulty}
              setter={climb.setter_username}
              layoutId={climb.layoutId}
              onCancel={() => setIsAddingBeta(false)}
              onSuccess={() => setIsAddingBeta(false)}
            />
          ) : (
            <BoardseshBetaList links={dedupedBetaLinks} isLoading={betaLinksLoading} boardType={boardType} />
          )}
        </Box>
      ),
    },
    {
      key: 'logbook',
      label: 'Your Logbook',
      title: 'Your Logbook',
      defaultSummary: 'No ascents',
      getSummary: getLogbookSummaryParts,
      lazy: true,
      content: <LogbookSection climb={climb} />,
    },
    {
      key: 'crew-logbook',
      label: 'Crew Logbook',
      title: 'Crew Logbook',
      defaultSummary: "See your crew's sends",
      lazy: true,
      content: <CrewLogbookView currentClimb={climb} boardType={boardType} />,
    },
    {
      key: 'community',
      label: 'Community',
      title: 'Community',
      defaultSummary: 'Votes, comments, proposals',
      getSummary: () => ['Votes', 'Comments', 'Proposals'],
      lazy: true,
      defaultActive: !!highlightProposalUuid,
      content: (
        <ClimbSocialSection
          climbUuid={climbUuid}
          boardType={boardType}
          angle={angle}
          currentClimbDifficulty={currentClimbDifficulty}
          boardName={boardName}
          highlightProposalUuid={highlightProposalUuid}
        />
      ),
    },
    {
      key: 'analytics',
      label: 'Analytics',
      title: 'Analytics',
      defaultSummary: 'Ascents, quality trends',
      getSummary: () => ['Ascents', 'Quality', 'Trends'],
      lazy: true,
      content: <ClimbAnalytics climbUuid={climbUuid} boardType={boardType} />,
    },
    {
      key: 'similar-climbs',
      label: t('detail.sections.similarClimbs'),
      title: t('detail.sections.similarClimbs'),
      defaultSummary: t('detail.sections.similarClimbsSummary'),
      // Open by default — saves a tap to discover related climbs, and
      // the empty-state copy keeps the section unobtrusive when nothing
      // matches the threshold.
      keepExpanded: true,
      lazy: true,
      content: (
        <SimilarClimbsList
          boardType={boardType as BoardName}
          layoutId={layoutId}
          viewerBoardDetails={viewerBoardDetails}
          climbUuid={climbUuid}
          angle={angle}
          threshold={0.5}
          limit={10}
          emptyMessage={t('similarClimbs.emptyOnLayout')}
        />
      ),
    },
  ];
}

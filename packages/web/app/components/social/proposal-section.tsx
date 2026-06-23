'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import AcUnitIcon from '@mui/icons-material/AcUnit';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_CLIMB_COMMUNITY_STATUS, GET_CLIMB_PROPOSALS, GET_MY_ROLES } from '@boardsesh/graphql/operations/proposals';
import type {
  ClimbCommunityStatusType,
  Proposal,
  ProposalConnection,
  CommunityRoleAssignment,
} from '@boardsesh/shared-schema';
import CollapsibleSection, {
  type CollapsibleSectionConfig,
} from '@/app/components/collapsible-section/collapsible-section';
import ProposalCard from './proposal-card';
import CreateProposalForm from './create-proposal-form';
import FreezeIndicator from './freeze-indicator';
import FreezeClimbDialog from './freeze-climb-dialog';
import CommunityStatusBadge from './community-status-badge';

type ProposalSectionProps = {
  climbUuid: string;
  boardType: string;
  angle: number;
  currentClimbDifficulty?: string;
  boardName?: string;
  highlightProposalUuid?: string;
};

export default function ProposalSection({
  climbUuid,
  boardType,
  angle,
  currentClimbDifficulty,
  boardName,
  highlightProposalUuid,
}: ProposalSectionProps) {
  const { t } = useTranslation('feed');
  const { token } = useWsAuthToken();
  const [communityStatus, setCommunityStatus] = useState<ClimbCommunityStatusType | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [acceptedProposals, setAcceptedProposals] = useState<Proposal[]>([]);
  const [isAdminOrLeader, setIsAdminOrLeader] = useState(false);
  const [showFreezeDialog, setShowFreezeDialog] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const client = createGraphQLHttpClient(token || undefined);

      const [statusResult, proposalsResult, acceptedResult] = await Promise.all([
        client.request<{ climbCommunityStatus: ClimbCommunityStatusType }>(GET_CLIMB_COMMUNITY_STATUS, {
          climbUuid,
          boardType,
          angle,
        }),
        client.request<{ climbProposals: ProposalConnection }>(GET_CLIMB_PROPOSALS, {
          input: { climbUuid, boardType, angle, status: 'open', limit: 10, offset: 0 },
        }),
        client.request<{ climbProposals: ProposalConnection }>(GET_CLIMB_PROPOSALS, {
          input: { climbUuid, boardType, angle, status: 'approved', limit: 10, offset: 0 },
        }),
      ]);

      setCommunityStatus(statusResult.climbCommunityStatus);
      setProposals(proposalsResult.climbProposals.proposals);
      setAcceptedProposals(acceptedResult.climbProposals.proposals);

      // Check user roles
      if (token) {
        try {
          const rolesResult = await client.request<{ myRoles: CommunityRoleAssignment[] }>(GET_MY_ROLES);
          const hasRole = rolesResult.myRoles.some(
            (r) =>
              (r.role === 'admin' || r.role === 'community_leader') &&
              (r.boardType === null || r.boardType === boardType),
          );
          setIsAdminOrLeader(hasRole);
        } catch {
          // Not authenticated or no roles
        }
      }
    } catch (err) {
      console.error('[ProposalSection] Failed to fetch data:', err);
    } finally {
      setLoading(false);
    }
  }, [climbUuid, boardType, angle, token]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleProposalCreated = useCallback(
    (proposal: Proposal) => {
      setProposals((prev) => [proposal, ...prev]);
      void fetchData();
    },
    [fetchData],
  );

  const handleProposalUpdated = useCallback(
    (updated: Proposal) => {
      setProposals((prev) => prev.map((p) => (p.uuid === updated.uuid ? updated : p)));
      // Refresh status if proposal was resolved
      if (updated.status !== 'open') {
        void fetchData();
      }
    },
    [fetchData],
  );

  const handleProposalDeleted = useCallback(
    (proposalUuid: string) => {
      setAcceptedProposals((prev) => prev.filter((p) => p.uuid !== proposalUuid));
      void fetchData();
    },
    [fetchData],
  );

  if (loading) return null;

  const acceptedSummaryParts: string[] = [];
  for (const p of acceptedProposals) {
    if (p.type === 'grade') acceptedSummaryParts.push(`Grade: ${p.proposedValue}`);
    else if (p.type === 'classic') acceptedSummaryParts.push('Classic');
    else if (p.type === 'benchmark') acceptedSummaryParts.push('Benchmark');
  }

  const hasAccepted = acceptedProposals.length > 0;
  const hasOpen = proposals.length > 0;

  const sections: CollapsibleSectionConfig[] = [
    {
      key: 'open',
      label: 'Open Proposals',
      title: 'Open Proposals',
      defaultSummary: 'None',
      getSummary: () => (hasOpen ? [`${proposals.length} open`] : []),
      content: (
        <Box>
          {/* Section header with create button */}
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              {isAdminOrLeader && (
                <Tooltip title={communityStatus?.isFrozen ? 'Unfreeze climb' : 'Freeze climb'}>
                  <IconButton
                    size="small"
                    onClick={() => setShowFreezeDialog(true)}
                    sx={{
                      color: communityStatus?.isFrozen ? 'var(--color-warning)' : themeTokens.neutral[400],
                    }}
                  >
                    <AcUnitIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              <CreateProposalForm
                climbUuid={climbUuid}
                boardType={boardType}
                angle={angle}
                isFrozen={communityStatus?.isFrozen}
                outlierWarning={communityStatus?.outlierAnalysis?.isOutlier}
                currentClimbDifficulty={communityStatus?.communityGrade || currentClimbDifficulty}
                boardName={boardName}
                onCreated={handleProposalCreated}
              />
            </Box>
          </Box>

          {/* Proposals list */}
          {hasOpen ? (
            proposals.map((proposal) => (
              <ProposalCard
                key={proposal.uuid}
                proposal={proposal}
                isAdminOrLeader={isAdminOrLeader}
                onUpdate={handleProposalUpdated}
                highlight={proposal.uuid === highlightProposalUuid}
              />
            ))
          ) : (
            <Typography variant="body2" sx={{ color: themeTokens.neutral[400], textAlign: 'center', py: 2 }}>
              {t('proposalSection.noOpen')}
            </Typography>
          )}
        </Box>
      ),
    },
  ];

  if (hasAccepted) {
    sections.push({
      key: 'accepted',
      label: 'Accepted',
      title: 'Accepted Proposals',
      defaultSummary: 'None',
      getSummary: () => (acceptedSummaryParts.length > 0 ? acceptedSummaryParts : []),
      content: (
        <Box>
          {acceptedProposals.map((proposal) => (
            <ProposalCard
              key={proposal.uuid}
              proposal={proposal}
              isAdminOrLeader={isAdminOrLeader}
              onDelete={handleProposalDeleted}
            />
          ))}
        </Box>
      ),
    });
  }

  return (
    <Box sx={{ mb: 2 }}>
      {/* Community status badges */}
      {communityStatus && (
        <Box sx={{ mb: 1.5 }}>
          <CommunityStatusBadge
            communityGrade={communityStatus.communityGrade}
            isClassic={communityStatus.isClassic}
            isBenchmark={communityStatus.isBenchmark}
            isFrozen={communityStatus.isFrozen}
          />
        </Box>
      )}

      {/* Freeze indicator */}
      {communityStatus?.isFrozen && <FreezeIndicator reason={communityStatus.freezeReason} />}

      {/* Section header */}
      <Typography variant="subtitle2" sx={{ fontWeight: 600, color: themeTokens.neutral[700], mb: 1.5 }}>
        {t('proposalSection.title')}
        {proposals.length > 0 && (
          <Typography component="span" variant="caption" sx={{ ml: 0.5, color: themeTokens.neutral[400] }}>
            ({proposals.length})
          </Typography>
        )}
      </Typography>

      {/* Collapsible sections */}
      <CollapsibleSection sections={sections} defaultActiveKey="open" />

      {/* Freeze dialog */}
      {showFreezeDialog && communityStatus && (
        <FreezeClimbDialog
          open={showFreezeDialog}
          onClose={() => setShowFreezeDialog(false)}
          climbUuid={climbUuid}
          boardType={boardType}
          currentlyFrozen={communityStatus.isFrozen}
          onFreezeChanged={() => fetchData()}
        />
      )}
    </Box>
  );
}

'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { usePathname } from 'next/navigation';
import VoteButton from './vote-button';
import CommentSection from './comment-section';
import ProposalSection from './proposal-section';

type ClimbSocialSectionProps = {
  climbUuid: string;
  boardType?: string;
  angle?: number;
  currentClimbDifficulty?: string;
  boardName?: string;
  highlightProposalUuid?: string;
};

export default function ClimbSocialSection({
  climbUuid,
  boardType,
  angle,
  currentClimbDifficulty,
  boardName,
  highlightProposalUuid,
}: ClimbSocialSectionProps) {
  const { t } = useTranslation('common');
  const { isAuthenticated } = useWsAuthToken();
  const pathname = usePathname();
  const signInHref = `/auth/login?callbackUrl=${encodeURIComponent(pathname ?? '/')}`;
  return (
    <Box>
      {boardType && angle != null && (
        <ProposalSection
          climbUuid={climbUuid}
          boardType={boardType}
          angle={angle}
          currentClimbDifficulty={currentClimbDifficulty}
          boardName={boardName}
          highlightProposalUuid={highlightProposalUuid}
        />
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
        {isAuthenticated ? (
          <VoteButton entityType="climb" entityId={climbUuid} />
        ) : (
          <MuiLink
            component={LocaleLink}
            href={signInHref}
            sx={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
          >
            {t('comment.signInToSuggestGrade')}
          </MuiLink>
        )}
      </Box>
      <CommentSection
        headingComponent="h3"
        entityType="climb"
        entityId={climbUuid}
        title={t('comment.discussionTitle')}
      />
    </Box>
  );
}

// The reasons behind a proposal, expanded on demand.
//
// A hide report opens ONE proposal and every later reporter joins it, leaving
// their reason as a comment. So the count on the card is "how many people said
// something", and this is where a moderator reads them before deciding. It only
// mounts once the card is expanded — 20 cards each firing a comment query on
// first paint would be 20 requests nobody asked for.
//
// The FIRST reporter's reason is stored twice — on the proposal and as their
// comment — and the card already quotes the proposal copy above this list, so
// that one comment is dropped here rather than saying the same sentence twice
// under the same name. Same dedupe as `ClimbModerationStatus` runs on the hidden
// banner; `extraReasonCount` keeps the expander's number in step with it.

import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Comment, ReleaseContext } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { useComments } from '../../lib/graphql/hooks/use-social';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { useProposalReportReleaseContexts } from '../../lib/graphql/hooks/use-proposal-report-release-contexts';
import { ReportReleaseContextDetails } from './ReportReleaseContextDetails';

type ProposalReasonsListProps = {
  proposalUuid: string;
  /** Who opened the proposal — their first comment is the quoted reason. */
  proposerId: string | null;
  /** The proposal's own reason, already rendered above this list. */
  reason?: string | null;
  /** The card's expander. False keeps the query unfired. */
  expanded: boolean;
  canReadReleaseContext?: boolean;
};

export const ProposalReasonsList = memo(function ProposalReasonsList({
  proposalUuid,
  proposerId,
  reason,
  expanded,
  canReadReleaseContext = false,
}: ProposalReasonsListProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const { data, isPending, isError } = useComments('proposal', proposalUuid, expanded);
  const reportReleaseContexts = useProposalReportReleaseContexts(proposalUuid, expanded && canReadReleaseContext);
  const releaseContextByComment = useMemo(
    () => new Map(reportReleaseContexts?.map((report) => [report.commentUuid, report.releaseContext])),
    [reportReleaseContexts],
  );
  const proposerComment = data?.comments.find(
    (comment) => !comment.isDeleted && comment.userId === proposerId && comment.body === reason,
  );
  const proposerReleaseContext =
    proposerComment && canReadReleaseContext ? releaseContextByComment.get(proposerComment.uuid) : undefined;

  const comments = useMemo(() => {
    const loaded = data?.comments ?? [];
    return loaded.filter((comment) => {
      if (comment.isDeleted || !comment.body) return false;
      // The one copy to drop: the proposer's comment repeating the reason the
      // card already quotes above this list.
      return !(comment.userId === proposerId && comment.body === reason);
    });
  }, [data, proposerId, reason]);

  if (!expanded) return null;

  if (isPending) {
    return (
      <View style={styles.state}>
        <ActivityIndicator size="small" />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.state}>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('mobile.moderation.reasonsLoadError')}
        </Text>
      </View>
    );
  }

  if (comments.length === 0 && !proposerReleaseContext) {
    return (
      <View style={styles.state}>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('mobile.moderation.noReasons')}
        </Text>
      </View>
    );
  }

  return (
    // A plain View, not a list: this is a handful of rows nested inside a row of
    // the screen's FlashList, and a virtualised list inside a virtualised list
    // is the one thing the perf playbook forbids outright.
    <View style={styles.list}>
      <ReportReleaseContextDetails releaseContext={proposerReleaseContext} />
      {comments.map((comment) => (
        <ReasonRow
          key={comment.uuid}
          comment={comment}
          releaseContext={canReadReleaseContext ? releaseContextByComment.get(comment.uuid) : undefined}
        />
      ))}
    </View>
  );
});

const ReasonRow = memo(function ReasonRow({
  comment,
  releaseContext,
}: {
  comment: Comment;
  releaseContext?: ReleaseContext;
}) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

  return (
    <View style={[styles.row, { borderLeftColor: systemColors.separator }]}>
      <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
        {comment.userDisplayName ?? t('mobile.moderation.unknownClimber')} · {formatRelativeTime(comment.createdAt)}
      </Text>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {comment.body ?? ''}
      </Text>
      <ReportReleaseContextDetails releaseContext={releaseContext} />
    </View>
  );
});

const styles = StyleSheet.create({
  state: { paddingTop: spacing[2] },
  list: { marginTop: spacing[2], gap: spacing[2] },
  row: { borderLeftWidth: 2, paddingStart: spacing[3], gap: 2 },
});

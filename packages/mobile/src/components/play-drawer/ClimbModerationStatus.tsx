import { memo, useCallback, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { formatTickRelativeTime } from '@boardsesh/profile-stats';
import type { Comment } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useClimbProposals } from '../../lib/graphql/hooks/use-climb-proposals';
import { useComments } from '../../lib/graphql/hooks/use-social';
import { useClimbModerationEnabled } from '../../providers/feature-flags-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { decidedBy, selectModerationStatus } from './moderation-status';
import { isUnhideProposal } from '../moderation/proposal-presenters';

type ClimbModerationStatusProps = {
  climbUuid: string;
  /** Board slug; doubles as the `boardType` the proposal API keys on. */
  boardName: string;
  /** The angle being played — grade proposals only speak to their own angle. */
  angle: number;
  /** `climb.is_hidden` straight off the row, so the banner shows before the
   *  proposal read lands (and on a climb hidden without a proposal in the page). */
  isHidden: boolean;
};

/**
 * The moderation link every block ends with. Owns its own router callback so a
 * banner with three blocks doesn't rebuild three closures in the parent on each
 * render, and so the parent has no per-block `useCallback` to keep in sync.
 *
 * Pushes the ROOT `/moderation` modal. The drawer lives inside `/play`, itself a
 * root transparentModal, so a push aimed at a tab stack would land beneath the
 * player — a dead tap. A root modal presents above it instead, which is why the
 * feed is one root route rather than a copy per tab.
 */
const ModerationLink = memo(function ModerationLink({
  label,
  proposalUuid,
  climbUuid,
  boardType,
}: {
  label: string;
  proposalUuid: string;
  climbUuid: string;
  boardType: string;
}) {
  const router = useRouter();
  const { systemColors } = useTheme();

  const openInModeration = useCallback(() => {
    router.push({
      pathname: '/moderation',
      params: { proposalUuid, climbUuid, boardType },
    });
  }, [router, proposalUuid, climbUuid, boardType]);

  return (
    <PressableSurface onPress={openInModeration} accessibilityRole="link" accessibilityLabel={label} hitSlop={8}>
      <View style={styles.linkRow}>
        <Text variant="footnote" color={systemColors.accent}>
          {label}
        </Text>
        <Icon name="chevron.right" size={12} color={systemColors.accent} />
      </View>
    </PressableSurface>
  );
});

/** One reporter's reason: who said it, when, and what they said. */
const ReasonRow = memo(function ReasonRow({ comment }: { comment: Comment }) {
  const { systemColors } = useTheme();
  const author = comment.userDisplayName ?? '';

  return (
    <View style={styles.reasonRow}>
      <Text variant="caption1" color={systemColors.secondaryLabel}>
        {author
          ? `${author} · ${formatTickRelativeTime(comment.createdAt)}`
          : formatTickRelativeTime(comment.createdAt)}
      </Text>
      <Text variant="footnote">{comment.body}</Text>
    </View>
  );
});

/**
 * What the community has decided — or is still deciding — about this climb,
 * shown at the top of the play drawer's Community section.
 *
 * Renders nothing at all when the kill flag is off or when a climb has no
 * moderation history, which is the overwhelmingly common case: the whole block
 * costs a visible climb one cached query and no pixels.
 */
export const ClimbModerationStatus = memo(function ClimbModerationStatus({
  climbUuid,
  boardName,
  angle,
  isHidden,
}: ClimbModerationStatusProps) {
  const { t } = useTranslation('session');
  // The quote marks belong to the locale, not to us: `feed.proposalCard.quotedReason`
  // carries “…” / « … » / „…“ per language, and the moderation card already uses it.
  const { t: tFeed } = useTranslation('feed');
  const { systemColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const moderationEnabled = useClimbModerationEnabled();

  const { data: proposals } = useClimbProposals({
    climbUuid,
    boardType: boardName,
    enabled: moderationEnabled,
  });

  const { hidden, openHide, openGradeAtAngle } = useMemo(
    () => selectModerationStatus(proposals ?? [], angle),
    [proposals, angle],
  );

  // Reasons hang off the approved hide, so they load only for a hidden climb.
  const { data: reasonThread } = useComments('proposal', hidden?.uuid, !!hidden);

  const reasons = useMemo(() => {
    const comments = reasonThread?.comments ?? [];
    if (!hidden) return [];
    // The proposer's reason is already quoted above the list; the report flow
    // writes it as their comment too, so drop that one copy rather than saying
    // the same sentence twice under the same name.
    return comments.filter(
      (comment) =>
        !comment.isDeleted &&
        !!comment.body &&
        !(comment.userId === hidden.proposerId && comment.body === hidden.reason),
    );
  }, [reasonThread, hidden]);

  // An open `hide` proposal carrying `'false'` asks for the climb to come BACK.
  // Saying "Reported by 2 climbers · 1 of 3 votes to hide" on a hidden climb the
  // crew is voting back into view is the opposite of what is happening.
  const openHideIsUnhide = !!openHide && isUnhideProposal(openHide);

  const showHiddenBanner = isHidden || !!hidden;
  const hasAnything = showHiddenBanner || !!openHide || openGradeAtAngle.length > 0;

  if (!moderationEnabled || !hasAnything) return null;

  return (
    <View style={[styles.container, { borderColor: systemColors.separator }]} testID="climb-moderation-status">
      {showHiddenBanner ? (
        <View style={styles.block}>
          <View style={styles.titleRow}>
            <Icon name="visibility.off" size={16} color={systemColors.secondaryLabel} />
            <Text variant="subheadline" style={styles.titleText}>
              {t('mobile.community.moderation.hiddenTitle')}
            </Text>
          </View>

          {hidden?.reason ? (
            <Text variant="footnote">{tFeed('proposalCard.quotedReason', { reason: hidden.reason })}</Text>
          ) : null}

          {reasons.length > 0 ? (
            <View style={styles.reasonList}>
              {reasons.map((comment) => (
                <ReasonRow key={comment.uuid} comment={comment} />
              ))}
            </View>
          ) : null}

          {hidden ? (
            <Text variant="caption1" color={systemColors.secondaryLabel}>
              {decidedBy(hidden) === 'moderator'
                ? t('mobile.community.moderation.decidedByModerator')
                : t('mobile.community.moderation.decidedByCrew')}
            </Text>
          ) : null}

          {hidden ? (
            <ModerationLink
              label={t('mobile.community.moderation.seeInModeration')}
              proposalUuid={hidden.uuid}
              climbUuid={climbUuid}
              boardType={boardName}
            />
          ) : null}
        </View>
      ) : null}

      {openHide ? (
        <View style={styles.block}>
          <View style={styles.titleRow}>
            <Icon name={openHideIsUnhide ? 'visibility' : 'flag'} size={16} color={systemColors.secondaryLabel} />
            <Text variant="footnote">
              {openHideIsUnhide
                ? t('mobile.community.moderation.openUnhide', {
                    current: openHide.weightedUpvotes,
                    required: openHide.requiredUpvotes,
                  })
                : t('mobile.community.moderation.openReport', {
                    count: openHide.upvoterCount,
                    current: openHide.weightedUpvotes,
                    required: openHide.requiredUpvotes,
                  })}
            </Text>
          </View>
          <ModerationLink
            label={t('mobile.community.moderation.voteInModeration')}
            proposalUuid={openHide.uuid}
            climbUuid={climbUuid}
            boardType={boardName}
          />
        </View>
      ) : null}

      {openGradeAtAngle.map((proposal) => (
        <View key={proposal.uuid} style={styles.block}>
          <View style={styles.titleRow}>
            <Icon name="people" size={16} color={systemColors.secondaryLabel} />
            <Text variant="footnote">
              {t('mobile.community.moderation.openGrade', {
                from: formatGrade(proposal.currentValue) ?? proposal.currentValue,
                to: formatGrade(proposal.proposedValue) ?? proposal.proposedValue,
                current: proposal.weightedUpvotes,
                required: proposal.requiredUpvotes,
              })}
            </Text>
          </View>
          <ModerationLink
            label={t('mobile.community.moderation.voteInModeration')}
            proposalUuid={proposal.uuid}
            climbUuid={climbUuid}
            boardType={boardName}
          />
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[3],
    borderLeftWidth: 2,
    paddingLeft: spacing[3],
  },
  block: {
    gap: spacing[1],
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minWidth: 0,
  },
  titleText: {
    fontWeight: '600',
    flexShrink: 1,
  },
  reasonList: {
    gap: spacing[2],
    paddingTop: spacing[1],
  },
  reasonRow: {
    gap: 2,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    paddingTop: spacing[1],
  },
});

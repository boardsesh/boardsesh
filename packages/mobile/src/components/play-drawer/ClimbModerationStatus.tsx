import { memo, useCallback, useMemo, useInsertionEffect, useRef, useState } from 'react';
import { hashKey } from '@tanstack/react-query';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { useHttpQueryScope } from '../../lib/graphql/use-http-query-scope';
import { useHttpActionScope } from '../../lib/graphql/use-http-action-scope';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import type { Comment } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useClimbProposals } from '../../lib/graphql/hooks/use-climb-proposals';
import { useComments } from '../../lib/graphql/hooks/use-social';
import { formatRelativeTime } from '../../lib/format-relative-time';
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

// UI provenance only. A cached proposal is admitted input, not a new SDK
// delivery; every descendant keeps this original parent instead of minting B.
type ModerationOwner = Readonly<{ assertCurrent(): void }>;
function isModerationCurrent(owner: ModerationOwner | undefined): boolean {
  try {
    owner?.assertCurrent();
    return true;
  } catch {
    return false;
  }
}

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
  originalOwner,
}: {
  originalOwner?: ModerationOwner;
  label: string;
  proposalUuid: string;
  climbUuid: string;
  boardType: string;
}) {
  const router = useRouter();
  const actions = useHttpActionScope();
  const { systemColors } = useTheme();

  const nativeOpenInModeration = useCallback(() => {
    router.push({
      pathname: '/moderation',
      params: { proposalUuid, climbUuid, boardType },
    });
  }, [router, proposalUuid, climbUuid, boardType]);
  const guardedOpenInModeration = useCallback(() => {
    let action: ReturnType<typeof actions.capture> | undefined;
    try {
      originalOwner?.assertCurrent();
      action = actions.capture();
      originalOwner?.assertCurrent();
      action.assertView();
      nativeOpenInModeration();
    } catch {
      /* A retired link cannot navigate under a later owner. */
    } finally {
      action?.finish();
    }
  }, [originalOwner, actions, nativeOpenInModeration]);
  if (!isModerationCurrent(originalOwner)) return null;
  const openInModeration = originalOwner ? guardedOpenInModeration : nativeOpenInModeration;

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
const ReasonRow = memo(function ReasonRow({
  comment,
  originalOwner,
}: {
  comment: Comment;
  originalOwner?: ModerationOwner;
}) {
  const { systemColors } = useTheme();
  if (!isModerationCurrent(originalOwner)) return null;
  const author = comment.userDisplayName ?? '';

  return (
    <View style={styles.reasonRow}>
      <Text variant="caption1" color={systemColors.secondaryLabel}>
        {author ? `${author} · ${formatRelativeTime(comment.createdAt)}` : formatRelativeTime(comment.createdAt)}
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
const ClimbModerationStatusBody = memo(function ClimbModerationStatusBody({
  climbUuid,
  boardName,
  angle,
  isHidden,
}: ClimbModerationStatusProps) {
  const scope = useHttpQueryScope();
  const lifetime = useRef({ mounted: true });
  const [origin] = useState(() =>
    Object.freeze({
      scoped: scope.scoped,
      assertCurrent() {
        if (!scope.scoped || !lifetime.current.mounted) throw new BrowserBackendConsumerError('superseded');
        scope.assertView();
      },
    }),
  );
  useInsertionEffect(() => {
    lifetime.current.mounted = true;
    return () => {
      lifetime.current.mounted = false;
    };
  }, []);
  const originalOwner = scope.scoped ? origin : undefined;
  const originalCurrent = !scope.scoped || (origin.scoped && isModerationCurrent(origin));
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
    enabled: moderationEnabled && originalCurrent,
  });

  const { hidden, openHide, openGradeAtAngle } = useMemo(
    () => selectModerationStatus(proposals ?? [], angle),
    [proposals, angle],
  );

  // Reasons hang off the approved hide, so they load only for a hidden climb.
  const { data: reasonThread } = useComments('proposal', hidden?.uuid, !!hidden && originalCurrent);

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

  if (!originalCurrent || !moderationEnabled || !hasAnything) return null;

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
                <ReasonRow key={comment.uuid} comment={comment} {...(originalOwner ? { originalOwner } : {})} />
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
              {...(originalOwner ? { originalOwner } : {})}
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
            {...(originalOwner ? { originalOwner } : {})}
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
                from: formatGrade(proposal.currentValue, boardName) ?? proposal.currentValue,
                to: formatGrade(proposal.proposedValue, boardName) ?? proposal.proposedValue,
                current: proposal.weightedUpvotes,
                required: proposal.requiredUpvotes,
              })}
            </Text>
          </View>
          <ModerationLink
            {...(originalOwner ? { originalOwner } : {})}
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

export const ClimbModerationStatus = memo(function ClimbModerationStatus(props: ClimbModerationStatusProps) {
  const scope = useHttpQueryScope();
  return (
    <ClimbModerationStatusBody
      {...props}
      key={
        scope.scoped
          ? hashKey(scope.key(['climb-moderation-status', props.climbUuid, props.boardName, props.angle]))
          : undefined
      }
    />
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[3],
    borderLeftWidth: 2,
    paddingStart: spacing[3],
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

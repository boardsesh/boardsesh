// One row of the moderation feed: the climb, what the crew is asking for, who
// asked, and — for anyone who can act — the buttons to act with.
//
// The card owns its own vote and resolve mutations rather than taking handlers
// from the screen. That keeps `isPending` scoped to THIS proposal (a moderation
// pass is a dozen taps in a row, and a screen-level pending flag would grey out
// every other card mid-sweep) and keeps the screen's `renderItem` deps down to
// values that never change identity.

import { memo, useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Proposal } from '@boardsesh/shared-schema';
import { formatTickRelativeTime, getLayoutDisplayName } from '@boardsesh/profile-stats';
import { rolesGrantAdminOrLeader, type CommunityRoleScope } from '@boardsesh/community-roles';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Card } from '../Card';
import { Avatar } from '../Avatar';
import { Button } from '../Button';
import { PressableSurface } from '../PressableSurface';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { ProposalReasonsList } from './ProposalReasonsList';
import { proposalTypeLine, statusChip, voteProgress, type ProposalVoteValue } from './proposal-presenters';
import { useVoteOnProposal } from '../../lib/graphql/hooks/use-vote-on-proposal';
import { useResolveProposal } from '../../lib/graphql/hooks/use-resolve-proposal';
import { getBoardConfigForPlaylist } from '../../lib/playlists/board-details-for-playlist';
import { hapticLight, hapticMedium } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { spacing, borderRadius } from '../../theme/tokens';

/** Portrait board-art cell. Narrower than the feed hero — this is a list row. */
const THUMBNAIL = { width: 64, height: 80 } as const;

type ModerationProposalCardProps = {
  proposal: Proposal;
  /** The viewer's role rows; the card answers "can I moderate THIS board?" itself. */
  roles: readonly CommunityRoleScope[];
  /** Whether anyone is signed in — voting needs an account, reading doesn't. */
  isSignedIn: boolean;
  /** Outline this card: it is the proposal a notification sent the viewer to. */
  highlighted?: boolean;
  onOpenClimb: (proposal: Proposal) => void;
  onLongPressClimb: (proposal: Proposal) => void;
};

export const ModerationProposalCard = memo(function ModerationProposalCard({
  proposal,
  roles,
  isSignedIn,
  highlighted = false,
  onOpenClimb,
  onLongPressClimb,
}: ModerationProposalCardProps) {
  const { t } = useTranslation('climbs');
  const { t: tFeed } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [reasonsExpanded, setReasonsExpanded] = useState(false);

  const { mutate: castVote, isPending: voteIsPending } = useVoteOnProposal();
  const { mutate: resolveProposal, isPending: resolveIsPending } = useResolveProposal();

  const boardConfig = getBoardConfigForPlaylist(proposal.boardType, proposal.layoutId);
  const typeLine = proposalTypeLine(proposal, formatGrade);
  const chip = statusChip(proposal);
  const progress = voteProgress(proposal);
  const isOpen = proposal.status === 'open';
  const canModerate = rolesGrantAdminOrLeader(roles, proposal.boardType);
  // A label the formatter can't parse still shows: the raw grade beats a blank.
  const displayGrade = proposal.climbDifficulty
    ? (formatGrade(proposal.climbDifficulty) ?? proposal.climbDifficulty)
    : null;

  const handleOpenClimb = useCallback(() => {
    hapticLight();
    onOpenClimb(proposal);
  }, [onOpenClimb, proposal]);

  const handleLongPressClimb = useCallback(() => {
    hapticMedium();
    onLongPressClimb(proposal);
  }, [onLongPressClimb, proposal]);

  const handleToggleReasons = useCallback(() => {
    hapticLight();
    setReasonsExpanded((expanded) => !expanded);
  }, []);

  const submitVote = useCallback(
    (value: ProposalVoteValue) => {
      if (!isSignedIn) {
        showToast(tCommon('proposal.validation.signInToVote'), 'info');
        return;
      }
      hapticLight();
      castVote(
        { proposalUuid: proposal.uuid, value },
        { onError: () => showToast(t('mobile.moderation.voteError'), 'error') },
      );
    },
    [castVote, isSignedIn, proposal.uuid, showToast, t, tCommon],
  );

  const handleSupport = useCallback(() => submitVote(1), [submitVote]);
  const handleOppose = useCallback(() => submitVote(-1), [submitVote]);

  const submitResolve = useCallback(
    async (status: 'approved' | 'rejected') => {
      // The buttons are only rendered for moderators; keep the action itself
      // gated too so a stale closure can never send a resolve the server would
      // reject anyway.
      if (!canModerate) return;
      const isApprove = status === 'approved';
      const hidesTheClimb = isApprove && proposal.type === 'hide';
      const confirmed = await confirm({
        title: t(isApprove ? 'mobile.moderation.confirm.approve.title' : 'mobile.moderation.confirm.reject.title'),
        message: hidesTheClimb
          ? t('mobile.moderation.confirm.approve.hideMessage')
          : t(isApprove ? 'mobile.moderation.confirm.approve.message' : 'mobile.moderation.confirm.reject.message'),
        confirmLabel: t('mobile.moderation.confirm.confirm'),
        cancelLabel: tCommon('actions.cancel'),
        // Approving a hide takes a climb off everyone's lists, and a rejection
        // closes someone's report — both are worth a red button.
        destructive: hidesTheClimb || status === 'rejected',
      });
      if (!confirmed) return;
      resolveProposal(
        { proposalUuid: proposal.uuid, status },
        { onError: () => showToast(t('mobile.moderation.resolveError'), 'error') },
      );
    },
    [confirm, proposal.type, proposal.uuid, resolveProposal, showToast, t, tCommon, canModerate],
  );

  const handleApprove = useCallback(() => void submitResolve('approved'), [submitResolve]);
  const handleReject = useCallback(() => void submitResolve('rejected'), [submitResolve]);

  const highlightStyle = highlighted ? { borderColor: brandColors.primary, borderWidth: 2 } : undefined;

  return (
    <View style={styles.wrapper}>
      <Card style={highlightStyle}>
        {/* The climb block is its own tap target: pressing it previews the climb,
            long-pressing opens the same actions menu every other climb row has.
            The rest of the card stays inert so a vote is never a mis-tap. */}
        <PressableSurface
          onPress={handleOpenClimb}
          onLongPress={handleLongPressClimb}
          feedback="opacity"
          accessibilityRole="button"
          accessibilityLabel={t('mobile.moderation.openClimb', {
            climb: proposal.climbName ?? t('mobile.moderation.unknownClimb'),
          })}
          style={styles.climbPressable}
        >
          <View style={styles.climbRow}>
            {boardConfig && proposal.frames ? (
              <ClimbListThumbnail
                frames={proposal.frames}
                boardName={boardConfig.boardName}
                layoutId={boardConfig.layoutId}
                sizeId={boardConfig.sizeId}
                setIds={boardConfig.setIds.join(',')}
                size={THUMBNAIL}
              />
            ) : (
              <View style={[styles.thumbnailFallback, { backgroundColor: systemColors.fill }]}>
                <Icon name="lightbulb" size={22} color={systemColors.tertiaryLabel} />
              </View>
            )}

            <View style={styles.climbDetails}>
              <View style={styles.nameRow}>
                <Text variant="subheadline" numberOfLines={2} style={styles.climbName}>
                  {proposal.climbName ?? t('mobile.moderation.unknownClimb')}
                </Text>
                {displayGrade ? (
                  <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.gradeText}>
                    {displayGrade}
                  </Text>
                ) : null}
              </View>

              <Text variant="caption1" color={systemColors.tertiaryLabel} numberOfLines={1}>
                {getLayoutDisplayName(proposal.boardType, proposal.layoutId)}
                {proposal.climbSetterUsername ? ` · ${proposal.climbSetterUsername}` : ''}
              </Text>

              {chip || proposal.climbIsHidden ? (
                <View style={styles.chipRow}>
                  {proposal.climbIsHidden ? (
                    <View style={[styles.chip, { backgroundColor: systemColors.fill }]}>
                      <Icon name="visibility.off" size={12} color={systemColors.secondaryLabel} />
                      <Text variant="caption2" color={systemColors.secondaryLabel}>
                        {t('mobile.moderation.hiddenChip')}
                      </Text>
                    </View>
                  ) : null}
                  {chip ? (
                    <View style={[styles.chip, { backgroundColor: systemColors.fill }]}>
                      <Text variant="caption2" color={systemColors.secondaryLabel}>
                        {t(chip.labelI18nKey)}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          </View>
        </PressableSurface>

        <Text variant="body" style={styles.typeLine}>
          {t(typeLine.textI18nKey, typeLine.params)}
        </Text>

        <View style={styles.proposerRow}>
          <Avatar uri={proposal.proposerAvatarUrl} name={proposal.proposerDisplayName} size={22} />
          <Text variant="caption1" color={systemColors.tertiaryLabel} numberOfLines={1} style={styles.flex}>
            {proposal.proposerDisplayName ?? t('mobile.moderation.unknownClimber')} ·{' '}
            {formatTickRelativeTime(proposal.createdAt)}
          </Text>
        </View>

        {proposal.reason ? (
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.reason}>
            {tFeed('proposalCard.quotedReason', { reason: proposal.reason })}
          </Text>
        ) : null}

        {/* Later reporters join an existing proposal and leave their reason as a
            comment, so the count is "how many other people said something". */}
        {proposal.commentCount > 0 ? (
          <PressableSurface
            onPress={handleToggleReasons}
            feedback="opacity"
            accessibilityRole="button"
            accessibilityState={{ expanded: reasonsExpanded }}
            style={styles.expander}
          >
            <Text variant="footnote" color={brandColors.primary}>
              {t('mobile.moderation.moreReasons', { count: proposal.commentCount })}
            </Text>
            <Icon name={reasonsExpanded ? 'chevron.up' : 'chevron.down'} size={12} color={brandColors.primary} />
          </PressableSurface>
        ) : null}

        <ProposalReasonsList proposalUuid={proposal.uuid} expanded={reasonsExpanded} />

        <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.voteLine}>
          {tFeed('proposalVoteBar.votesNeeded', { current: progress.current, required: progress.required })}
          {' · '}
          {t('mobile.moderation.reporters', { count: progress.reporters })}
          {progress.opposed > 0 ? ` · ${tFeed('proposalVoteBar.opposed', { count: progress.opposed })}` : ''}
        </Text>

        {/* Both pairs wait on BOTH mutations. A vote's `onMutate` opens with
            `cancelQueries` across the whole proposals prefix, so a vote fired
            mid-resolve would cancel the refetch the resolve just triggered and
            leave the card showing an open proposal the server has closed. */}
        {isOpen ? (
          <View style={styles.voteRow}>
            <VoteButton
              label={tFeed('proposalCard.support')}
              iconName="hand.thumbsup"
              selected={proposal.userVote === 1}
              disabled={voteIsPending || resolveIsPending}
              onPress={handleSupport}
            />
            <VoteButton
              label={tFeed('proposalCard.oppose')}
              iconName="hand.thumbsdown"
              selected={proposal.userVote === -1}
              disabled={voteIsPending || resolveIsPending}
              onPress={handleOppose}
            />
          </View>
        ) : null}

        {isOpen && canModerate ? (
          <View style={styles.moderatorRow}>
            <Button
              title={tFeed('proposalCard.approve')}
              variant="outlined"
              size="small"
              onPress={handleApprove}
              disabled={resolveIsPending || voteIsPending}
            />
            <Button
              title={tFeed('proposalCard.reject')}
              variant="outlined"
              size="small"
              role="destructive"
              onPress={handleReject}
              disabled={resolveIsPending || voteIsPending}
            />
          </View>
        ) : null}
      </Card>
    </View>
  );
});

/**
 * One half of the support/oppose pair. A `PressableSurface` rather than a
 * `Button` because the pair is a two-state toggle and needs
 * `accessibilityState.selected` — which the native Button wrapper doesn't take.
 */
const VoteButton = memo(function VoteButton({
  label,
  iconName,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  iconName: 'hand.thumbsup' | 'hand.thumbsdown';
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { systemColors, brandColors } = useTheme();
  const tint = selected ? brandColors.primary : systemColors.secondaryLabel;

  return (
    <PressableSurface
      onPress={onPress}
      disabled={disabled}
      feedback="scale"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      style={[
        styles.voteButton,
        { borderColor: selected ? brandColors.primary : systemColors.separator },
        disabled ? styles.voteButtonDisabled : undefined,
      ]}
    >
      <Icon name={iconName} size={16} color={tint} />
      <Text variant="footnote" color={tint}>
        {label}
      </Text>
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  wrapper: { marginHorizontal: spacing[4], marginTop: spacing[3] },
  climbPressable: { margin: -spacing[1], padding: spacing[1], borderRadius: borderRadius.md },
  climbRow: { flexDirection: 'row', gap: spacing[3] },
  thumbnailFallback: {
    width: THUMBNAIL.width,
    height: THUMBNAIL.height,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  climbDetails: { flex: 1, gap: spacing[1], justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[2] },
  climbName: { flex: 1, fontWeight: '600' },
  gradeText: { fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[1], marginTop: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  typeLine: { marginTop: spacing[3], fontWeight: '600' },
  proposerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginTop: spacing[2] },
  reason: { marginTop: spacing[2], fontStyle: 'italic' },
  expander: { flexDirection: 'row', alignItems: 'center', gap: spacing[1], marginTop: spacing[2] },
  voteLine: { marginTop: spacing[3] },
  voteRow: { flexDirection: 'row', gap: spacing[2], marginTop: spacing[2] },
  voteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    flex: 1,
    minHeight: 44,
    paddingHorizontal: spacing[3],
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.full,
  },
  voteButtonDisabled: { opacity: 0.5 },
  moderatorRow: { flexDirection: 'row', gap: spacing[2], marginTop: spacing[2] },
  flex: { flex: 1 },
});

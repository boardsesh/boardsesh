import { PressableSurface } from '../PressableSurface';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toBoardName } from '@boardsesh/board-config';
import type { UserBoard } from '@boardsesh/shared-schema';
import { Sheet } from '../Sheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { SheetTopBar } from '../SheetTopBar';
import { Avatar } from '../Avatar';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { getBoardDetailFields, isActiveBoard } from './board-detail-fields';
import { sprayShareTarget, type SprayShareTarget } from './spray-detail-rows';
import { BoardShareSheet } from './BoardShareSheet';
import { HomeBoardShareSheet } from './HomeBoardShareSheet';
import { ReportSprayWallSheet } from '../spray-wall/ReportSprayWallSheet';
import { useSprayModerationAccess } from '../../lib/spray/use-spray-moderation';
import { useProfile } from '../../lib/graphql/hooks';
import { useResourcePrivacy } from '../../lib/graphql/hooks/use-resource-privacy';
import { homeBoardShareTarget, type HomeBoardShareTarget } from '../../lib/board-share/board-share-link';
import { useReportProblem } from '../report-problem/use-report-problem';
import { useReportBoard } from '../../lib/graphql/hooks/use-directory-reports';
import { useDirectoryReportsEnabled } from '../../providers/feature-flags-provider';
import { useToast } from '../../providers/toast-provider';

type BoardDetailSheetProps = {
  board: UserBoard | null;
  visible: boolean;
  onClose: () => void;
  onSetActive: (board: UserBoard) => void;
  /**
   * See reports, for the creator and gym staff while a report waits on them.
   * The host (the board picker) owns the review sheet.
   */
  onReviewReports?: (board: UserBoard) => void;
  /**
   * The gym whose staff took this board off their listing, when the sheet was
   * opened from that notification: offers "Ask {{gym}} to list it again".
   */
  relistGymName?: string | null;
};

export function BoardDetailSheet({
  board,
  visible,
  onClose,
  onSetActive,
  onReviewReports,
  relistGymName,
}: BoardDetailSheetProps) {
  const { systemColors } = useTheme();
  const { t } = useTranslation('boards');
  const { data: activeBoard } = useActiveBoard();
  const { canReport } = useSprayModerationAccess();
  const [reportTarget, setReportTarget] = useState<{ uuid: string; name: string } | null>(null);
  const closeReport = useCallback(() => setReportTarget(null), []);
  const openReport = useCallback(() => {
    if (board && canReport) setReportTarget({ uuid: board.uuid, name: board.name });
  }, [board, canReport]);

  // Null on a catalogue board and on a PRIVATE wall — a private wall's link
  // resolves for nobody, so the row is absent rather than disabled. The edit
  // screen is where a wall is made shareable.
  const shareTarget = useMemo(() => sprayShareTarget(board), [board]);
  const [shareSnapshot, setShareSnapshot] = useState<{ target: SprayShareTarget; wallName: string } | null>(null);
  const openShare = useCallback(() => {
    if (board && shareTarget) setShareSnapshot({ target: shareTarget, wallName: board.name });
  }, [board, shareTarget]);
  const closeShare = useCallback(() => setShareSnapshot(null), []);

  // A home board's share row. Followers and Invite-only boards need the owner's
  // own audience to tell them from Only me, and only the owner may read it, so
  // nobody else asks.
  const { data: profile } = useProfile();
  const viewerOwnsHomeBoard =
    !!board &&
    toBoardName(board.boardType) !== 'spray' &&
    !board.isPublic &&
    !board.isUnlisted &&
    !!profile?.id &&
    board.ownerId === profile.id;
  const { data: ownerPrivacy } = useResourcePrivacy('board', viewerOwnsHomeBoard ? board.uuid : undefined);
  const homeShareTarget = useMemo(
    () => homeBoardShareTarget(board, profile?.id, ownerPrivacy?.audience),
    [board, profile?.id, ownerPrivacy?.audience],
  );
  const [homeShareSnapshot, setHomeShareSnapshot] = useState<{
    target: HomeBoardShareTarget;
    boardName: string;
  } | null>(null);
  const openHomeShare = useCallback(() => {
    if (board && homeShareTarget) setHomeShareSnapshot({ target: homeShareTarget, boardName: board.name });
  }, [board, homeShareTarget]);
  const closeHomeShare = useCallback(() => setHomeShareSnapshot(null), []);

  // Report a problem: every board type but a Spraywall, which keeps its own
  // reasons and review queue above. Null when the flag is off or the viewer
  // can fix the board themselves.
  const isSprayWall = !!board && toBoardName(board.boardType) === 'spray';
  const reportAction = useReportProblem({ target: board && !isSprayWall ? { kind: 'board', board } : null });
  const openReview = useCallback(() => {
    if (board) onReviewReports?.(board);
  }, [board, onReviewReports]);
  const showReview = !!board && !!onReviewReports && (board.openReportCount ?? 0) > 0;

  // "Ask {{gym}} to list it again", from the notification that the gym's staff
  // took the creator's board off their listing.
  const directoryReportsEnabled = useDirectoryReportsEnabled();
  const { showToast } = useToast();
  const relist = useReportBoard();
  const relistMutate = relist.mutate;
  const askToRelist = useCallback(() => {
    if (!board || !relistGymName) return;
    relistMutate(
      { boardUuid: board.uuid, reason: 'relist_request' },
      {
        onSuccess: (result) =>
          showToast(
            result.status === 'already_reported'
              ? t('report.relistAlready', { gym: relistGymName })
              : t('report.relistSent', { gym: relistGymName }),
            'success',
          ),
        onError: () => showToast(t('report.error'), 'error'),
      },
    );
  }, [board, relistGymName, relistMutate, showToast, t]);
  const showRelist = directoryReportsEnabled && !!relistGymName && !!board && !board.gymUuid;

  const isActive = board ? isActiveBoard(board, activeBoard?.uuid) : false;
  const header = board ? (
    <SheetTopBar
      title={board.name}
      leading={{ kind: 'close', onPress: onClose }}
      trailing={
        isActive
          ? undefined
          : {
              kind: 'forward',
              label: t('mobile.boardDetail.setActiveShort'),
              accessibilityLabel: t('mobile.boardDetail.setActive'),
              onPress: () => onSetActive(board),
              prominent: true,
            }
      }
    />
  ) : null;

  return (
    <>
      <Sheet
        visible={visible && !!board}
        snapPoints={MEDIUM_LARGE_SNAP_POINTS}
        onClose={onClose}
        scrollable
        contentContainerStyle={styles.content}
        header={header}
      >
        {board ? (
          <BoardDetailBody
            board={board}
            isActive={isActive}
            systemColors={systemColors}
            t={t}
            shareTarget={shareTarget}
            onOpenShare={openShare}
            homeShareTarget={homeShareTarget}
            onOpenHomeShare={openHomeShare}
            canReport={canReport && isSprayWall}
            onOpenReport={openReport}
            reviewRow={showReview ? { onPress: openReview } : null}
            relistRow={showRelist && relistGymName ? { gymName: relistGymName, onPress: askToRelist } : null}
            boardReportRow={reportAction ? { onPress: reportAction.open } : null}
          />
        ) : null}
      </Sheet>
      {reportTarget ? (
        <ReportSprayWallSheet wallUuid={reportTarget.uuid} wallName={reportTarget.name} onClose={closeReport} />
      ) : null}
      {reportAction?.sheet}
      {/* A sibling of the detail sheet, not a child: it is its own native sheet,
        and the coordinator serialises the two presentations. */}
      {shareSnapshot ? (
        <BoardShareSheet
          visible
          onDismiss={closeShare}
          shareUrl={shareSnapshot.target.url}
          wallName={shareSnapshot.wallName}
          visibility={shareSnapshot.target.visibility}
          posterUrl={shareSnapshot.target.posterUrl}
        />
      ) : null}
      {homeShareSnapshot ? (
        <HomeBoardShareSheet
          target={homeShareSnapshot.target}
          boardName={homeShareSnapshot.boardName}
          onDismiss={closeHomeShare}
        />
      ) : null}
    </>
  );
}

type SystemColors = ReturnType<typeof useTheme>['systemColors'];
type TFn = ReturnType<typeof useTranslation>['t'];

function BoardDetailBody({
  board,
  isActive,
  systemColors,
  t,
  shareTarget,
  onOpenShare,
  homeShareTarget,
  onOpenHomeShare,
  canReport,
  onOpenReport,
  reviewRow,
  relistRow,
  boardReportRow,
}: {
  board: UserBoard;
  isActive: boolean;
  systemColors: SystemColors;
  t: TFn;
  shareTarget: SprayShareTarget | null;
  onOpenShare: () => void;
  homeShareTarget: HomeBoardShareTarget | null;
  onOpenHomeShare: () => void;
  canReport: boolean;
  onOpenReport: () => void;
  reviewRow: { onPress: () => void } | null;
  relistRow: { gymName: string; onPress: () => void } | null;
  boardReportRow: { onPress: () => void } | null;
}) {
  const { subLocation, setNames, sizeText } = getBoardDetailFields(board);

  return (
    <>
      <View style={styles.header}>
        {isActive ? (
          <View style={[styles.activePill, { backgroundColor: systemColors.tertiaryBackground }]}>
            <Icon name="tick.fill" size={16} color={systemColors.secondaryLabel} />
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('mobile.boardDetail.alreadyActive')}
            </Text>
          </View>
        ) : null}
        {subLocation ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {subLocation}
          </Text>
        ) : null}
        {board.ownerDisplayName ? (
          <View style={styles.ownerRow}>
            <Avatar uri={board.ownerAvatarUrl ?? undefined} name={board.ownerDisplayName} size={28} />
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {board.ownerDisplayName}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.statsRow, { backgroundColor: systemColors.tertiaryBackground }]}>
        <Stat value={board.totalAscents} label={t('mobile.boardDetail.stats.ascents')} systemColors={systemColors} />
        <StatDivider color={systemColors.separator} />
        <Stat value={board.uniqueClimbers} label={t('mobile.boardDetail.stats.climbers')} systemColors={systemColors} />
        <StatDivider color={systemColors.separator} />
        <Stat value={board.followerCount} label={t('mobile.boardDetail.stats.followers')} systemColors={systemColors} />
      </View>

      <View style={[styles.specCard, { backgroundColor: systemColors.tertiaryBackground }]}>
        {board.layoutName ? (
          <SpecRow label={t('mobile.boardDetail.spec.layout')} value={board.layoutName} systemColors={systemColors} />
        ) : null}
        {sizeText ? (
          <SpecRow label={t('mobile.boardDetail.spec.size')} value={sizeText} systemColors={systemColors} />
        ) : null}
        {setNames.length > 0 ? (
          <SpecRow label={t('mobile.boardDetail.spec.sets')} value={setNames} systemColors={systemColors} />
        ) : null}
        <SpecRow
          label={t('mobile.boardDetail.spec.angle')}
          value={
            board.isAngleAdjustable ? `${board.angle}° · ${t('mobile.boardDetail.spec.adjustable')}` : `${board.angle}°`
          }
          systemColors={systemColors}
        />
      </View>

      {board.description ? (
        <Text variant="body" color={systemColors.label}>
          {board.description}
        </Text>
      ) : null}

      {shareTarget ? (
        <View style={[styles.wallRows, { backgroundColor: systemColors.tertiaryBackground }]}>
          <WallRow
            icon="share"
            label={t('mobile.boardDetail.spray.shareLink')}
            hint={
              shareTarget.visibility === 'public'
                ? t('mobile.boardDetail.spray.shareLinkPublicHint')
                : t('mobile.boardDetail.spray.shareLinkUnlistedHint')
            }
            showSeparator={false}
            systemColors={systemColors}
            onPress={onOpenShare}
          />
        </View>
      ) : null}

      {homeShareTarget ? (
        <View style={[styles.wallRows, { backgroundColor: systemColors.tertiaryBackground }]}>
          <WallRow
            icon="share"
            label={t('mobile.boardDetail.share.shareLink')}
            hint={homeShareHint(homeShareTarget, t)}
            showSeparator={false}
            systemColors={systemColors}
            onPress={onOpenHomeShare}
          />
        </View>
      ) : null}

      {reviewRow ? (
        <View style={[styles.wallRows, { backgroundColor: systemColors.tertiaryBackground }]}>
          <WallRow
            icon="warning"
            label={t('reportReview.open')}
            hint={t('reportReview.title')}
            showSeparator={false}
            systemColors={systemColors}
            onPress={reviewRow.onPress}
          />
        </View>
      ) : null}

      {relistRow ? (
        <View style={[styles.wallRows, { backgroundColor: systemColors.tertiaryBackground }]}>
          <WallRow
            icon="gym"
            label={t('report.relistAsk', { gym: relistRow.gymName })}
            hint={t('report.relistAskHint')}
            showSeparator={false}
            systemColors={systemColors}
            onPress={relistRow.onPress}
          />
        </View>
      ) : null}

      {canReport ? (
        <View style={[styles.wallRows, { backgroundColor: systemColors.tertiaryBackground }]}>
          <WallRow
            icon="warning"
            label={t('sprayModeration.reportTitle')}
            hint={t('sprayModeration.reportHint')}
            showSeparator={false}
            systemColors={systemColors}
            onPress={onOpenReport}
          />
        </View>
      ) : null}

      {/* Report a problem, the last row of the sheet in its own group: never on
          the art or the hero (design §2). Once the climber's report is in, the
          row says so instead. */}
      {boardReportRow ? (
        <View style={[styles.wallRows, { backgroundColor: systemColors.tertiaryBackground }]}>
          {board.viewerHasOpenReport ? (
            <WallRow
              icon="flag"
              label={t('report.reported')}
              hint={t('report.alreadyReported')}
              showSeparator={false}
              systemColors={systemColors}
            />
          ) : (
            <WallRow
              icon="flag"
              label={t('report.action')}
              accessibilityLabel={t('report.actionAria', { name: board.name })}
              showSeparator={false}
              systemColors={systemColors}
              onPress={boardReportRow.onPress}
              testID="board-detail-report"
            />
          )}
        </View>
      ) : null}
    </>
  );
}

/** What the home board's link does, in the row's second line. */
function homeShareHint(target: HomeBoardShareTarget, t: TFn): string {
  if (target.kind === 'invite') return t('mobile.boardDetail.share.inviteHint');
  return target.visibility === 'public'
    ? t('mobile.boardDetail.share.publicHint')
    : t('mobile.boardDetail.share.unlistedHint');
}

function WallRow({
  icon,
  label,
  hint,
  accessibilityLabel,
  showSeparator,
  systemColors,
  onPress,
  testID,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  hint?: string;
  accessibilityLabel?: string;
  showSeparator: boolean;
  systemColors: SystemColors;
  /** Absent: a row that only says something (Reported), drawn without a chevron. */
  onPress?: () => void;
  testID?: string;
}) {
  const body = (
    <>
      <Icon name={icon} size={20} color={systemColors.secondaryLabel} />
      <View style={styles.wallRowText}>
        <Text variant="body" color={onPress ? systemColors.label : systemColors.secondaryLabel}>
          {label}
        </Text>
        {hint ? (
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {hint}
          </Text>
        ) : null}
      </View>
      {onPress ? <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} /> : null}
    </>
  );
  const separator = showSeparator
    ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: systemColors.separator }
    : null;
  if (!onPress) {
    return (
      <View style={[styles.wallRow, separator]} accessible accessibilityLabel={hint ? `${label}, ${hint}` : label}>
        {body}
      </View>
    );
  }
  return (
    <PressableSurface
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={hint}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.wallRow, separator, pressed ? { opacity: 0.6 } : null]}
    >
      {body}
    </PressableSurface>
  );
}

function Stat({ value, label, systemColors }: { value: number; label: string; systemColors: SystemColors }) {
  return (
    <View style={styles.stat}>
      <Text variant="title2" color={systemColors.label}>
        {value}
      </Text>
      <Text variant="caption1" color={systemColors.secondaryLabel}>
        {label}
      </Text>
    </View>
  );
}

function StatDivider({ color }: { color: ColorValue }) {
  return <View style={[styles.statSeparator, { backgroundColor: color }]} />;
}

function SpecRow({ label, value, systemColors }: { label: string; value: string; systemColors: SystemColors }) {
  return (
    <View style={styles.specRow}>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.specLabel}>
        {label}
      </Text>
      <Text variant="body" color={systemColors.label} style={styles.specValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[4],
    gap: spacing[4],
  },
  header: {
    gap: spacing[2],
  },
  ownerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    marginTop: spacing[1],
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: borderRadius.lg,
    paddingVertical: spacing[3],
  },
  stat: {
    flex: 1,
    alignItems: 'center',
    gap: spacing[1],
  },
  statSeparator: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginVertical: spacing[2],
  },
  specCard: {
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[3],
  },
  specRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing[3],
  },
  specLabel: {
    width: 80,
  },
  specValue: {
    flex: 1,
  },
  wallRows: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
  },
  wallRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    // 44pt minimum tap target with room for the two-line label.
    paddingVertical: spacing[3],
  },
  wallRowText: {
    flex: 1,
    gap: spacing[1],
  },
  activePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.lg,
  },
});

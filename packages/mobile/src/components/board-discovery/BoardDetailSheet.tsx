import { useCallback, useMemo, useState } from 'react';
import { View, Pressable, StyleSheet, type ColorValue } from 'react-native';
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
import { ReportSprayWallSheet } from '../spray-wall/ReportSprayWallSheet';
import { useSprayModerationAccess } from '../../lib/spray/use-spray-moderation';

type BoardDetailSheetProps = {
  board: UserBoard | null;
  visible: boolean;
  onClose: () => void;
  onSetActive: (board: UserBoard) => void;
};

export function BoardDetailSheet({ board, visible, onClose, onSetActive }: BoardDetailSheetProps) {
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

  const isActive = board ? isActiveBoard(board, activeBoard?.uuid) : false;
  const header = board ? (
    <SheetTopBar
      title={board.name}
      leading={{ kind: 'close', onPress: onClose }}
      trailing={
        isActive
          ? undefined
          : {
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
        snapPoints={['55%', '90%']}
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
            canReport={canReport && toBoardName(board.boardType) === 'spray'}
            onOpenReport={openReport}
          />
        ) : null}
      </Sheet>
      {reportTarget ? (
        <ReportSprayWallSheet wallUuid={reportTarget.uuid} wallName={reportTarget.name} onClose={closeReport} />
      ) : null}
      {/* A sibling of the detail sheet, not a child: it is its own native sheet,
        and the coordinator serialises the two presentations. */}
      {shareSnapshot ? (
        <BoardShareSheet
          visible
          onDismiss={closeShare}
          shareUrl={shareSnapshot.target.url}
          wallName={shareSnapshot.wallName}
          visibility={shareSnapshot.target.visibility}
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
  canReport,
  onOpenReport,
}: {
  board: UserBoard;
  isActive: boolean;
  systemColors: SystemColors;
  t: TFn;
  shareTarget: SprayShareTarget | null;
  onOpenShare: () => void;
  canReport: boolean;
  onOpenReport: () => void;
}) {
  const { subLocation, setNames, sizeText } = getBoardDetailFields(board);

  return (
    <>
      <View style={styles.header}>
        {isActive ? (
          <View style={[styles.activePill, { backgroundColor: systemColors.tertiaryBackground }]}>
            <Icon name="tick" size={16} color={systemColors.secondaryLabel} />
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
    </>
  );
}

function WallRow({
  icon,
  label,
  hint,
  showSeparator,
  systemColors,
  onPress,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  hint: string;
  showSeparator: boolean;
  systemColors: SystemColors;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => [
        styles.wallRow,
        showSeparator ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: systemColors.separator } : null,
        pressed ? { opacity: 0.6 } : null,
      ]}
    >
      <Icon name={icon} size={20} color={systemColors.secondaryLabel} />
      <View style={styles.wallRowText}>
        <Text variant="body" color={systemColors.label}>
          {label}
        </Text>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {hint}
        </Text>
      </View>
      <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
    </Pressable>
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

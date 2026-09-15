import { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Pressable, StyleSheet, type ColorValue } from 'react-native';
import BottomSheet from '@expo/ui/community/bottom-sheet';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { Sheet } from '../Sheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { Avatar } from '../Avatar';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { getBoardDetailFields, isActiveBoard } from './board-detail-fields';
import { sprayDetailRows, type SprayDetailRow } from './spray-detail-rows';
import { SPRAY_DETAIL_ROWS_ENABLED } from '../../lib/spray/spray-routes';

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
  const router = useRouter();
  const sheetRef = useRef<BottomSheet>(null);

  // Empty for every board that is not a spray wall the viewer may edit, which is
  // what keeps this a no-op on the eight catalogue boards — and empty for ALL of
  // them until the two screens the rows lead to exist. See
  // `SPRAY_DETAIL_ROWS_ENABLED`; the gate below is live and tested either way.
  const wallRows = useMemo(() => (SPRAY_DETAIL_ROWS_ENABLED ? sprayDetailRows(board) : []), [board]);

  // Close first, then navigate: the sheet is always mounted and these rows push a
  // full route, so leaving it open would stack a screen under an open sheet.
  const openWallRow = useCallback(
    (href: string) => {
      onClose();
      router.push(href);
    },
    [onClose, router],
  );

  // Always-mounted sheet: open/close imperatively off the visible+board state.
  // Selecting a different board while the sheet is open re-runs snapToIndex(0)
  // (board is a dep) — harmless; the sheet no-ops if already at that stop.
  useEffect(() => {
    if (visible && board) {
      sheetRef.current?.snapToIndex(0);
    } else {
      sheetRef.current?.close();
    }
  }, [visible, board]);

  const footer = board ? (
    isActiveBoard(board, activeBoard?.uuid) ? (
      <View style={[styles.activePill, { backgroundColor: systemColors.tertiaryBackground }]}>
        <Icon name="tick" size={16} color={systemColors.secondaryLabel} />
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {t('mobile.boardDetail.alreadyActive')}
        </Text>
      </View>
    ) : (
      <Button title={t('mobile.boardDetail.setActive')} size="large" onPress={() => onSetActive(board)} />
    )
  ) : null;

  return (
    <Sheet
      ref={sheetRef}
      snapPoints={['55%', '90%']}
      onClose={onClose}
      scrollable
      contentContainerStyle={styles.content}
      footer={footer}
    >
      {board ? (
        <BoardDetailBody
          board={board}
          systemColors={systemColors}
          t={t}
          wallRows={wallRows}
          onOpenWallRow={openWallRow}
        />
      ) : null}
    </Sheet>
  );
}

type SystemColors = ReturnType<typeof useTheme>['systemColors'];
type TFn = ReturnType<typeof useTranslation>['t'];

function BoardDetailBody({
  board,
  systemColors,
  t,
  wallRows,
  onOpenWallRow,
}: {
  board: UserBoard;
  systemColors: SystemColors;
  t: TFn;
  wallRows: SprayDetailRow[];
  onOpenWallRow: (href: string) => void;
}) {
  const { subLocation, setNames, sizeText } = getBoardDetailFields(board);

  return (
    <>
      <View style={styles.header}>
        <Text variant="title1">{board.name}</Text>
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

      {/* Wall maintenance, owner/editor only. Empty on every catalogue board, so
          the card and its separator never render there. Literal translation keys
          per row — a computed `t(row.key)` is rejected by the i18n linter and
          hides the string from the catalogue scanners either way. */}
      {wallRows.length > 0 ? (
        <View style={[styles.wallRows, { backgroundColor: systemColors.tertiaryBackground }]}>
          {wallRows.map((row, index) => (
            <WallRow
              key={row.key}
              icon={row.icon}
              label={
                row.key === 'editHolds'
                  ? t('mobile.boardDetail.spray.editHolds')
                  : t('mobile.boardDetail.spray.newPhoto')
              }
              hint={
                row.key === 'editHolds'
                  ? t('mobile.boardDetail.spray.editHoldsHint')
                  : t('mobile.boardDetail.spray.newPhotoHint')
              }
              showSeparator={index > 0}
              systemColors={systemColors}
              onPress={() => onOpenWallRow(row.href)}
            />
          ))}
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
  icon: SprayDetailRow['icon'];
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

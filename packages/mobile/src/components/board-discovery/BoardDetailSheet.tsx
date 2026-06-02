import { useCallback, useEffect, useMemo, useRef, type PropsWithChildren } from 'react';
import { View, Platform, StyleSheet, type ColorValue, type ViewStyle } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { Avatar } from '../Avatar';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius, sheetStyles } from '../../theme/tokens';
import { getBoardDetailFields, isActiveBoard } from './board-detail-fields';

type BoardDetailSheetProps = {
  board: UserBoard;
  onClose: () => void;
  onSetActive: (board: UserBoard) => void;
};

// Portal the sheet above the tab bar / persistent queue bar on iOS so the
// footer button isn't hidden behind those overlays.
function BoardDetailSheetContainer({ children }: PropsWithChildren) {
  return <FullWindowOverlay>{children}</FullWindowOverlay>;
}
const modalContainerComponent = Platform.OS === 'ios' ? BoardDetailSheetContainer : undefined;

export function BoardDetailSheet({ board, onClose, onSetActive }: BoardDetailSheetProps) {
  const { systemColors } = useTheme();
  const { t } = useTranslation('boards');
  const { data: activeBoard } = useActiveBoard();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);

  // Mount-based control: parent renders this only when a board is selected,
  // so we just present on mount and let the parent unmount on dismiss.
  useEffect(() => {
    sheetRef.current?.present();
  }, []);

  const snapPoints = useMemo(() => ['55%', '90%'], []);

  const renderBackdrop = useCallback(
    (backdropProps: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...backdropProps} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} />
    ),
    [],
  );

  const backgroundStyle: ViewStyle = {
    ...sheetStyles.background,
    backgroundColor: systemColors.secondaryBackground,
  };

  const alreadyActive = isActiveBoard(board, activeBoard?.uuid);

  return (
    <BottomSheetModal
      ref={sheetRef}
      name="board-detail"
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      stackBehavior="push"
      containerComponent={modalContainerComponent}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      onDismiss={onClose}
      handleIndicatorStyle={sheetStyles.indicator}
      backgroundStyle={backgroundStyle}
    >
      <BottomSheetScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <BoardDetailBody board={board} systemColors={systemColors} t={t} />
      </BottomSheetScrollView>

      <View
        style={[
          styles.footer,
          { backgroundColor: systemColors.secondaryBackground as string, paddingBottom: insets.bottom + spacing[3] },
        ]}
      >
        {alreadyActive ? (
          <View style={[styles.activePill, { backgroundColor: systemColors.tertiaryBackground }]}>
            <Icon name="tick" size={16} color={systemColors.secondaryLabel} />
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('mobile.boardDetail.alreadyActive')}
            </Text>
          </View>
        ) : (
          <Button title={t('mobile.boardDetail.setActive')} size="large" onPress={() => onSetActive(board)} />
        )}
      </View>
    </BottomSheetModal>
  );
}

type SystemColors = ReturnType<typeof useTheme>['systemColors'];
type TFn = ReturnType<typeof useTranslation>['t'];

function BoardDetailBody({ board, systemColors, t }: { board: UserBoard; systemColors: SystemColors; t: TFn }) {
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
    </>
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
  scrollView: {
    flex: 1,
  },
  scrollContent: {
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
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: iosSystemColors.separator,
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

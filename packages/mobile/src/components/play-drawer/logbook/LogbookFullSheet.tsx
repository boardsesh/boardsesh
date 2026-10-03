// The climber's whole history on one climb, opened from the Logbook card's
// "See full logbook" row. The card itself is capped (it lives in the play
// drawer's plain ScrollView); this sheet is where a long project's every
// session and every log is reachable, through a virtualised list.
//
// Driven by a controlled `visible` prop and mounted INSIDE PlayDrawer, so the
// ModalSheet coordinator presents it above the `/play` modal. A root-level
// sheet would land underneath it.
import { useCallback, useMemo, type ComponentType } from 'react';
import { StyleSheet, View, type FlatListProps } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { boardSupportsMirroring } from '@boardsesh/board-config';
import { ModalSheet } from '../../ModalSheet';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { PressableSurface } from '../../PressableSurface';
import { LogbookAngleHeader } from './LogbookAngleHeader';
import { LogbookSessionTile } from './LogbookSessionTile';
import { buildLedgerListItems, type LedgerListItem } from './ledger-list-items';
import { formatLedgerDayLabel, ledgerDayKeys } from './day-label';
import { useClimbLedger } from './use-climb-ledger';
import { nowMs } from '../../../lib/clock';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';

type LogbookFullSheetProps = {
  visible: boolean;
  climbUuid: string | null;
  boardName: BoardName;
  layoutId: number;
  /** The angle the board is set to; its section leads, as on the card. */
  angle: number;
  onClose: () => void;
};

// The bottom-sheet-aware list scrolls within the native sheet detent (its
// virtualization plugs into the sheet's gesture handling).
const SheetFlatList = BottomSheetFlatList as ComponentType<FlatListProps<LedgerListItem>>;

const SNAP_POINTS = ['90%'];
const CLOSE_TARGET = 44;

function keyExtractor(item: LedgerListItem): string {
  return item.key;
}

export function LogbookFullSheet({ visible, climbUuid, boardName, layoutId, angle, onClose }: LogbookFullSheetProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { ledger } = useClimbLedger(boardName, climbUuid, angle);
  const showMirrorTag = boardSupportsMirroring(boardName, layoutId);

  // Not gated on `visible`: the rows have to stay put while the sheet animates out.
  const items = useMemo(() => buildLedgerListItems(ledger), [ledger]);

  // Strings, so `renderItem` keeps its identity until the calendar day turns.
  const { todayKey, yesterdayKey } = ledgerDayKeys(nowMs());
  const todayLabel = t('mobile.logbook.dayToday');
  const yesterdayLabel = t('mobile.logbook.dayYesterday');

  const renderItem = useCallback(
    ({ item }: { item: LedgerListItem }) => {
      if (item.kind === 'angle') {
        return <LogbookAngleHeader section={item.section} isBoardAngle={item.section.angle === angle} />;
      }
      return (
        <LogbookSessionTile
          session={item.session}
          dayLabel={formatLedgerDayLabel(item.session.dayKey, { todayKey, yesterdayKey, todayLabel, yesterdayLabel })}
          showMirrorTag={showMirrorTag}
        />
      );
    },
    [angle, showMirrorTag, todayKey, yesterdayKey, todayLabel, yesterdayLabel],
  );

  return (
    <ModalSheet
      visible={visible && climbUuid !== null}
      snapPoints={SNAP_POINTS}
      surface="solid"
      onClose={onClose}
      header={
        <View style={[styles.header, { borderBottomColor: systemColors.separator }]}>
          <Text variant="title3" accessibilityRole="header" style={styles.title} numberOfLines={1}>
            {t('mobile.logbook.title')}
          </Text>
          <PressableSurface
            onPress={onClose}
            feedback="opacity"
            accessibilityRole="button"
            accessibilityLabel={t('mobile.logbook.closeFullLogbook')}
            style={[styles.close, { backgroundColor: systemColors.fill }]}
          >
            <Icon name="chevron.down" size={18} color={systemColors.secondaryLabel} />
          </PressableSurface>
        </View>
      }
    >
      <SheetFlatList
        data={items}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    flex: 1,
    fontWeight: '600',
  },
  close: {
    width: CLOSE_TARGET,
    height: CLOSE_TARGET,
    borderRadius: CLOSE_TARGET / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    flex: 1,
  },
  listContent: {
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[4],
  },
});

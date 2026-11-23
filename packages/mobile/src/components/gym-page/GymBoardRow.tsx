import { memo, useCallback, useMemo, useRef, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet, View, type AccessibilityActionEvent, type AccessibilityActionInfo } from 'react-native';
import { hapticLight } from '../../lib/haptics';
import { rowAccessibilityActionsWith } from '../../lib/row-accessibility-actions';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { AppMenu } from '../AppMenu';
import type { AppMenuHandle } from '../AppMenu.types';
import { ArtRow } from '../ArtRow';
import { Icon } from '../Icon';
import { StatusPill } from '../StatusPill';
import type { BoardCardMenu, DiscoveryBoardItem } from '../board-discovery/BoardDiscoveryCardView';
import { BOARD_MENU_BUTTON_SIZE, BOARD_MENU_LONG_PRESS_DELAY_MS } from '../board-discovery/board-menu-metrics';
import { DiscoveryBoardArt } from '../board-discovery/DiscoveryBoardArt';
import { useBoardCardMenuRows } from '../board-discovery/use-board-card-menu-rows';
import { boardItemAccessibilityLabel, useBoardItemCopy } from '../board-discovery/use-board-item-copy';
import { SHELF_SECTION_GAP } from '../ShelfHeader';
import { InsetGroupedCell } from './InsetGroupedCell';
import type { GroupedCellPosition } from './gym-page-view-model';

type GymBoardRowProps = {
  item: DiscoveryBoardItem;
  position: GroupedCellPosition;
  menu: BoardCardMenu;
  onPress: (item: DiscoveryBoardItem) => void;
};

/** The row's own target inside its hold menu fills the space the ⋯ leaves. */
const HOLD_ANCHOR_STYLE = { flex: 1, minWidth: 0 } as const;

/**
 * One board on the gym page: a compact thumbnail, the board's name without the
 * gym in front, what it is ("Kilter Homewall · 12×12 · 40°"), "Reported" while
 * a report waits on the viewer, else "Yours" on the climber's own boards, and
 * the shared board menu on the ⋯ and on a hold. A
 * tap climbs on it. Drawn as its own list cell (`InsetGroupedCell`), so the
 * board list is virtualized like the rest of the page.
 */
export const GymBoardRow = memo(function GymBoardRow({ item, position, menu, onPress }: GymBoardRowProps) {
  const { t } = useTranslation('boards');
  const { selection, systemColors } = useTheme();
  const copy = useBoardItemCopy(item);
  const { rows, menuActions, runMenuRow, selectFromMenuButton, selectFromHold } = useBoardCardMenuRows(item, menu);
  const hasMenuRows = rows.length > 0;
  const selected = item.isActive === true;
  const menuRef = useRef<AppMenuHandle | null>(null);

  const art = useMemo(() => <DiscoveryBoardArt item={item} size="compact" />, [item]);
  // Beside the title, never on the art. A report waiting on this viewer (they
  // added the board or run the gym) outranks "Yours": it is the one to act on.
  const hasWaitingReport = (item.openReportCount ?? 0) > 0;
  const status = useMemo(() => {
    if (hasWaitingReport) {
      return <StatusPill label={t('reportReview.statusPill')} tone="warning" testID="gym-page-board-reported" />;
    }
    return item.isViewerOwner === true ? <StatusPill label={t('mobile.gymPage.yoursPill')} /> : undefined;
  }, [hasWaitingReport, item.isViewerOwner, t]);
  const handlePress = useCallback(() => {
    hapticLight();
    onPress(item);
  }, [onPress, item]);
  // iOS: the SwiftUI context menu owns the hold. Android: the row hands it over.
  const openMenuFromHold = useCallback(() => {
    hapticLight();
    menuRef.current?.open();
  }, []);
  const onLongPress = hasMenuRows && Platform.OS === 'android' ? openMenuFromHold : undefined;

  // VoiceOver focuses the row as one element, so every menu row is also an
  // action on it; Climb here is the row's own activation.
  const accessibilityActions = useMemo(() => {
    const menuRows: AccessibilityActionInfo[] = rows
      .filter((row) => row.action !== 'climb_here')
      .map((row) => ({ name: row.action, label: row.label }));
    return menuRows.length > 0 ? rowAccessibilityActionsWith(...menuRows) : undefined;
  }, [rows]);
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      const { actionName } = event.nativeEvent;
      if (actionName === 'activate') {
        handlePress();
        return;
      }
      const index = rows.findIndex((row) => row.action === actionName && row.action !== 'climb_here');
      if (index >= 0) runMenuRow(index, 'accessibility');
    },
    [rows, handlePress, runMenuRow],
  );

  const actionsLabel = t('mobile.discovery.cardActionsAria', { name: item.title });
  const wrapTarget = useCallback(
    (target: ReactElement) => (
      <AppMenu
        actions={menuActions}
        onSelectIndex={selectFromHold}
        trigger="longPress"
        menuKey={item.key}
        menuRef={menuRef}
        style={HOLD_ANCHOR_STYLE}
        liftPreview
        previewBackgroundColor={systemColors.secondaryBackground}
        previewOverlayColor={selected ? selection.fill : undefined}
      >
        {target}
      </AppMenu>
    ),
    [menuActions, selectFromHold, item.key, selected, selection.fill, systemColors.secondaryBackground],
  );

  const checkmark = selected ? <Icon name="check.small" size={17} color={selection.checkmark} /> : null;
  const accessory = hasMenuRows ? (
    <View style={styles.trailing}>
      {checkmark}
      <AppMenu
        key={item.key}
        iconName="more"
        iconAppearance="plain"
        anchorSize={BOARD_MENU_BUTTON_SIZE}
        accessibilityLabel={actionsLabel}
        actions={menuActions}
        onSelectIndex={selectFromMenuButton}
      />
    </View>
  ) : selected ? (
    'checkmark'
  ) : undefined;

  return (
    <InsetGroupedCell position={position} separatorInset="compact" endGap={SHELF_SECTION_GAP}>
      <ArtRow
        art={art}
        artSize="compact"
        title={item.title}
        titleVariant="body"
        subtitle={item.subtitle ?? undefined}
        status={status}
        accessory={accessory}
        selected={selected}
        onPress={handlePress}
        onLongPress={onLongPress}
        delayLongPress={BOARD_MENU_LONG_PRESS_DELAY_MS}
        longPressAccessibilityLabel={hasMenuRows ? actionsLabel : undefined}
        accessibilityLabel={boardItemAccessibilityLabel(item, copy)}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={handleAccessibilityAction}
        wrapTarget={hasMenuRows ? wrapTarget : undefined}
        testID={`gym-page-board-${item.key}`}
      />
    </InsetGroupedCell>
  );
});

const styles = StyleSheet.create({
  // The 44pt ⋯ anchor reaches into the trailing gutter, so its glyph ends on the 16pt line.
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    marginEnd: -spacing[3],
  },
});

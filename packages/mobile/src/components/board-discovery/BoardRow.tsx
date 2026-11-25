import { memo, useCallback, useMemo, useRef, type ComponentType, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet, View, type AccessibilityActionEvent, type AccessibilityActionInfo } from 'react-native';
import { hapticLight } from '../../lib/haptics';
import { rowAccessibilityActionsWith } from '../../lib/row-accessibility-actions';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { AppMenu } from '../AppMenu';
import type { AppMenuHandle } from '../AppMenu.types';
import { ArtRow } from '../ArtRow';
import { StatusPill } from '../StatusPill';
import { Icon } from '../Icon';
import { Text } from '../Text';
import type { BoardCardMenu, DiscoveryBoardItem } from './BoardDiscoveryCardView';
import {
  BOARD_MENU_BUTTON_SIZE,
  BOARD_MENU_LONG_PRESS_DELAY_MS,
  BOARD_SUBTITLE_GLYPH_SIZE,
} from './board-menu-metrics';
import type { DiscoveryBoardArtProps } from './DiscoveryBoardArt';
import { useBoardCardMenuRows } from './use-board-card-menu-rows';
import { boardItemAccessibilityLabel, useBoardItemCopy, type BoardItemCopy } from './use-board-item-copy';

export type BoardRowProps = {
  item: DiscoveryBoardItem;
  onPress: (item: DiscoveryBoardItem) => void;
  /**
   * The ⋯, the hold and their rows (the card menu). Absent draws a plain row:
   * a wall at the gym that isn't the climber's, or the offline list.
   */
  menu?: BoardCardMenu;
  /** Draws the board's art in the row's slot: the real thumbnail in the app, a fixture in stories. */
  BoardArt: ComponentType<DiscoveryBoardArtProps>;
};

/** The row's own target inside its hold menu fills the space the ⋯ leaves. */
const HOLD_ANCHOR_STYLE = { flex: 1, minWidth: 0 } as const;

/**
 * The subtitle line. The board you're on leads with "On it" and drops its pin
 * and download glyphs, which would push the size off the line. A spray wall
 * still being imported says where its import is instead. All of it secondary
 * label: none of it can be tapped.
 */
function BoardRowSubtitle({ item, copy }: { item: DiscoveryBoardItem; copy: BoardItemCopy }) {
  const { systemColors } = useTheme();
  const selected = item.isActive === true;
  const detail = copy.importLabel ?? item.subtitle ?? null;
  const text = selected ? [copy.onItLabel, detail].filter(Boolean).join(' · ') : detail;
  const showGlyphs = !selected && copy.importLabel === null;
  const pinGlyph = showGlyphs && item.isPinned === true;
  const offlineGlyph = showGlyphs ? copy.offlineGlyph : null;
  const detailLines = item.detailLines ?? EMPTY_LINES;
  if (!text && !pinGlyph && offlineGlyph === null && detailLines.length === 0) return null;
  const line = (
    <View style={styles.subtitleLine}>
      {copy.importLabel !== null ? (
        <View style={[styles.importDot, { backgroundColor: systemColors.secondaryLabel }]} />
      ) : null}
      {pinGlyph ? <Icon name="pin.fill" size={BOARD_SUBTITLE_GLYPH_SIZE} color={systemColors.secondaryLabel} /> : null}
      {offlineGlyph !== null ? (
        <Icon name={offlineGlyph} size={BOARD_SUBTITLE_GLYPH_SIZE} color={systemColors.secondaryLabel} />
      ) : null}
      {text ? (
        <Text variant="subheadline" tone="secondary" numberOfLines={1} style={styles.subtitleText}>
          {text}
        </Text>
      ) : null}
    </View>
  );
  if (detailLines.length === 0) return line;
  return (
    <View style={styles.subtitleBlock}>
      {line}
      {detailLines.map((detail, index) => (
        // Lines of one row, fixed for its lifetime: the index is their identity.
        // oxlint-disable-next-line react/no-array-index-key
        <Text key={index} variant="footnote" tone="secondary" numberOfLines={2}>
          {detail}
        </Text>
      ))}
    </View>
  );
}

const EMPTY_LINES: readonly string[] = [];

/**
 * One board in an inset-grouped list: the picker's At {gym} and Your boards.
 * An `ArtRow` with the board's thumbnail; the board you're on is `selected`
 * (the violet wash, an emphasized title, an accent checkmark). Where the board
 * has a menu, the ⋯ sits beside the row's target and a hold on the row opens
 * the same rows, as on a Near you card.
 */
export const BoardRow = memo(function BoardRow({ item, onPress, menu, BoardArt }: BoardRowProps) {
  const { t } = useTranslation('boards');
  const { selection, systemColors } = useTheme();
  const copy = useBoardItemCopy(item);
  const { rows, menuActions, runMenuRow, selectFromMenuButton, selectFromHold } = useBoardCardMenuRows(item, menu);
  const hasMenuRows = rows.length > 0;
  const selected = item.isActive === true;
  const menuRef = useRef<AppMenuHandle | null>(null);

  const art = useMemo(() => <BoardArt item={item} size="regular" />, [BoardArt, item]);
  const handlePress = useCallback(() => {
    hapticLight();
    onPress(item);
  }, [onPress, item]);
  // iOS: the SwiftUI context menu owns the hold, and `open()` does nothing.
  // Android: the row's own pressable wins the touch and hands the hold over.
  const openMenuFromHold = useCallback(() => {
    hapticLight();
    menuRef.current?.open();
  }, []);
  const onLongPress = hasMenuRows && Platform.OS === 'android' ? openMenuFromHold : undefined;

  // VoiceOver focuses the row as one element, so every menu row is also a
  // labelled action on it, as on a Near you card; Climb here is the row's own
  // activation. Android adds `activate`, which a custom action list would
  // otherwise leave without a route to the press.
  const accessibilityActions = useMemo(() => {
    const menuRows: AccessibilityActionInfo[] = rows
      .filter((row) => row.action !== 'climb_here' && !row.disabled)
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
      const index = rows.findIndex((row) => row.action === actionName && row.action !== 'climb_here' && !row.disabled);
      if (index >= 0) runMenuRow(index, 'accessibility');
    },
    [rows, handlePress, runMenuRow],
  );

  const actionsLabel = t('mobile.discovery.cardActionsAria', { name: item.title });
  // VoiceOver reads the row as one element, so the badge and the detail lines
  // a wall list draws go into its label too.
  const rowAccessibilityLabel = useMemo(
    () => [boardItemAccessibilityLabel(item, copy), item.badge, ...(item.detailLines ?? [])].filter(Boolean).join(', '),
    [item, copy],
  );
  const wrapTarget = useCallback(
    (target: ReactElement) => (
      <AppMenu
        actions={menuActions}
        onSelectIndex={selectFromHold}
        trigger="longPress"
        menuKey={item.key}
        menuRef={menuRef}
        style={HOLD_ANCHOR_STYLE}
        // An opaque lifted row on iOS, the card's own surface under the wash it
        // had at rest, so the lift never shows a grey slab or a clear row.
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
        // A new board here gets a fresh ⋯, which closes a menu drawn for the last one.
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
    <ArtRow
      art={art}
      artSize="regular"
      title={item.title}
      // A list to choose from: body titles, the one you're on in semibold.
      titleVariant="body"
      subtitle={<BoardRowSubtitle item={item} copy={copy} />}
      // Beside the title, never on the art: a report waits on this climber.
      status={
        (item.openReportCount ?? 0) > 0 ? (
          <StatusPill label={t('reportReview.statusPill')} tone="warning" testID="board-row-reported" />
        ) : item.badge ? (
          <StatusPill label={item.badge} testID="board-row-badge" />
        ) : undefined
      }
      accessory={accessory}
      selected={selected}
      onPress={handlePress}
      onLongPress={onLongPress}
      delayLongPress={BOARD_MENU_LONG_PRESS_DELAY_MS}
      longPressAccessibilityLabel={hasMenuRows ? actionsLabel : undefined}
      accessibilityLabel={rowAccessibilityLabel}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={handleAccessibilityAction}
      wrapTarget={hasMenuRows ? wrapTarget : undefined}
    />
  );
});

const styles = StyleSheet.create({
  subtitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  subtitleText: {
    flexShrink: 1,
  },
  subtitleBlock: {
    gap: 2,
  },
  importDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  // The 44pt ⋯ anchor reaches into the trailing gutter, so its glyph ends on the 16pt line.
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    marginEnd: -spacing[3],
  },
});

import type { BoardName, SprayWallImportProgress } from '@boardsesh/shared-schema';
import { memo, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { hapticLight } from '../../lib/haptics';
import { ACTIVATE_ACCESSIBILITY_ACTIONS, rowAccessibilityActionsWith } from '../../lib/row-accessibility-actions';
import { useTheme } from '../../providers/theme-provider';
import { springs } from '../../theme/animations';
import { borderRadius, spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE, textStyles } from '../../theme/typography';
import { AppMenu } from '../AppMenu';
import type { AppMenuHandle } from '../AppMenu.types';
import { Icon } from '../Icon';
import { Text } from '../Text';
import type {
  BoardCardMenuAction,
  BoardCardMenuCapabilities,
  BoardCardMenuLabels,
  BoardCardMenuVia,
} from './board-card-menu';
import type { BoardDownloadState } from './board-offline-state';
import {
  BOARD_MENU_BUTTON_FOOTPRINT,
  BOARD_MENU_BUTTON_SIZE,
  BOARD_MENU_LONG_PRESS_DELAY_MS,
  BOARD_SUBTITLE_GLYPH_SIZE,
} from './board-menu-metrics';
import { useBoardCardMenuRows } from './use-board-card-menu-rows';
import { boardItemAccessibilityLabel, useBoardItemCopy } from './use-board-item-copy';

/** The minimal board shape the card renders. Saved boards and BLE-resolved
 *  boards both map onto this so one card serves every section. */
export type DiscoveryBoardItem = {
  /** Stable key for the list. */
  key: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  /** Comma-separated set ids (the UserBoard wire shape). */
  setIds: string;
  title: string;
  subtitle?: string | null;
  /** When set, the subtitle line leads with the distance (metres from the user). */
  distanceMeters?: number | null;
  /** When true, marks this as the currently-active board. */
  isActive?: boolean;
  /**
   * Whether the signed-in user owns this board, stamped once per list build by
   * `userBoardToItem`. `undefined` means "not resolvable here" — Near you, In
   * range, or a session with no identity — and offers neither unfollow nor
   * delete rather than guessing (offering to unfollow the user's own wall is
   * worse than offering nothing).
   */
  isViewerOwner?: boolean;
  /**
   * The server's word on what the viewer may do with the board (see
   * `BoardCardMenuItemState`). Set on the climber's own and followed boards;
   * absent wherever the card offers no management.
   */
  canEdit?: boolean;
  canDelete?: boolean;
  canRemoveFromGym?: boolean;
  /**
   * Waiting reports the viewer can act on (`UserBoard.openReportCount`): the
   * creator's and gym staff's "Reported" pill and See reports row.
   */
  openReportCount?: number | null;
  /** The viewer's own report on this board is waiting: the menu says Reported. */
  viewerHasOpenReport?: boolean | null;
  /** The gym the board is listed at, for "Remove from {gym}". */
  gymName?: string | null;
  /** Whether the viewer pinned this board to the front of their list. */
  isPinned?: boolean;
  /**
   * Offline download state for this board's scope. Absent on cards that are not
   * the climber's own or followed boards.
   */
  offlineState?: BoardDownloadState;
  sprayImport?: SprayWallImportProgress | null;
  importStatusStale?: boolean;
  /**
   * More lines under the subtitle, for a row that has to tell walls apart
   * rather than just name them: a gym's wall list (#8151) shows every hold
   * set, the climber and send counts and who added it. Rows only.
   */
  detailLines?: readonly string[];
  /** A short neutral pill beside the title ("Your board", "Following"). Rows only. */
  badge?: string | null;
};

/**
 * A card's menu, handed down by its carousel as ONE object so every card in the
 * rail shares it and the carousel's `renderItem` depends on a single stable
 * value.
 */
export type BoardCardMenu = {
  /** What this surface allows; see `boardCardMenuEntries`. */
  capabilities: BoardCardMenuCapabilities;
  labels: BoardCardMenuLabels;
  /** Runs a picked row. `via` is the way in the climber used, for `Board Card Action`. */
  onAction: (item: DiscoveryBoardItem, action: BoardCardMenuAction, via: BoardCardMenuVia) => void;
};

export const DISCOVERY_CARD_WIDTH = 168;

/**
 * Lines the board name gets. Board names routinely run past a 168pt card
 * ("Bergen Klatresenter Danmarksplass"), and one line ellipsised two boards at
 * the same gym into the same string. The title box reserves all of them so a
 * one-line card and a two-line card keep their subtitles on the same baseline
 * across the row.
 */
const TITLE_LINES = 2;
// Both type scales (HIG and Material) give subheadline the same lineHeight, so
// one read covers both UI variants — see textStylesByVariant.
const TITLE_BOX_HEIGHT = TITLE_LINES * textStyles.subheadline.lineHeight;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type BoardDiscoveryCardViewProps = {
  boardImage?: ReactNode;
  item: DiscoveryBoardItem;
  onPress: (item: DiscoveryBoardItem) => void;
  /**
   * The ⋯ menu, the hold on the card and the screen-reader actions, all from the
   * same rows. Absent on a surface with no actions, which draws a plain card.
   */
  menu?: BoardCardMenu;
};

/**
 * One board in Near you's carousel. Memoized: the picker re-renders whenever
 * any of its queries settle, and each card resolves board art. The menu object
 * is shared by the whole rail, so a card re-renders only when its own item
 * changes.
 *
 * Nothing sits on the board art. State reads as small glyphs at the head of the
 * subtitle line, in secondary label: none of it can be tapped, so none of it is
 * violet, and every action lives in the menu.
 */
export const BoardDiscoveryCardView = memo(function BoardDiscoveryCardView({
  boardImage,
  item,
  onPress,
  menu,
}: BoardDiscoveryCardViewProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const copy = useBoardItemCopy(item);
  const { rows, menuActions, runMenuRow, selectFromMenuButton, selectFromHold } = useBoardCardMenuRows(item, menu);
  const scale = useSharedValue(1);
  const menuRef = useRef<AppMenuHandle | null>(null);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const thumbStyle = { backgroundColor: systemColors.tertiaryBackground, borderColor: systemColors.separator };
  const hasMenuRows = rows.length > 0;

  const handlePress = useCallback(() => {
    hapticLight();
    onPress(item);
  }, [onPress, item]);

  // iOS: the SwiftUI context menu owns the hold, and `open()` does nothing.
  // Android: the card's own Pressable wins the touch, so the menu's wrapper never
  // sees the hold; the card hands it over. The browser's wrapper listens to raw
  // pointer events and needs no help.
  const openMenuFromHold = useCallback(() => {
    hapticLight();
    menuRef.current?.open();
  }, []);
  const onLongPress = hasMenuRows && Platform.OS === 'android' ? openMenuFromHold : undefined;

  // The card Pressable is `accessible`, so on iOS UIKit treats it as a leaf and
  // VoiceOver never reaches inside it. Every menu row is published as a labelled
  // custom action instead, the same rows the ⋯ and the hold show, so a
  // screen-reader user needs neither. Climb here is left out: it is the card's
  // own activation.
  const accessibilityActions = useMemo(() => {
    const nested: AccessibilityActionInfo[] = rows
      .filter((row) => row.action !== 'climb_here' && !row.disabled)
      .map((row) => ({ name: row.action, label: row.label }));
    return nested.length > 0 ? rowAccessibilityActionsWith(...nested) : ACTIVATE_ACCESSIBILITY_ACTIONS;
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

  const isPinned = item.isPinned === true;
  const { offlineGlyph, importLabel } = copy;
  const detailText = [copy.distanceLabel, item.subtitle]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' · ');
  // The separator after "On it" only when something follows it on the line.
  const onItText = isPinned || offlineGlyph !== null || detailText.length > 0 ? `${copy.onItLabel} ·` : copy.onItLabel;
  const showSubtitleLine = item.isActive === true || isPinned || offlineGlyph !== null || detailText.length > 0;
  const accessibilityLabel = boardItemAccessibilityLabel(item, copy);

  const card = (
    <AnimatedPressable
      onPress={handlePress}
      onLongPress={onLongPress}
      // The hold AppMenu.android and the browser menu use, so the card opens
      // its menu as fast as every other hold menu.
      delayLongPress={BOARD_MENU_LONG_PRESS_DELAY_MS}
      onPressIn={() => (scale.value = withSpring(0.97, springs.snappy))}
      onPressOut={() => (scale.value = withSpring(1, springs.snappy))}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={handleAccessibilityAction}
      style={[animatedStyle, styles.card]}
    >
      <View testID="board-card" style={[styles.thumb, thumbStyle]}>
        {boardImage ?? (
          <View style={styles.thumbFallback}>
            <Icon name="boards" size={36} color={systemColors.tertiaryLabel} />
          </View>
        )}
      </View>

      <Text
        variant="subheadline"
        emphasized
        numberOfLines={TITLE_LINES}
        style={[styles.title, hasMenuRows ? styles.titleBesideMenuButton : null]}
      >
        {item.title}
      </Text>
      {showSubtitleLine ? (
        <View testID="board-card-subtitle" style={styles.subtitleLine}>
          {item.isActive ? (
            <>
              <Icon name="tick.fill" size={BOARD_SUBTITLE_GLYPH_SIZE} color={systemColors.secondaryLabel} />
              <Text
                variant="caption1"
                tone="secondary"
                emphasized
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
              >
                {onItText}
              </Text>
            </>
          ) : null}
          {isPinned ? (
            <Icon name="pin.fill" size={BOARD_SUBTITLE_GLYPH_SIZE} color={systemColors.secondaryLabel} />
          ) : null}
          {offlineGlyph !== null ? (
            <Icon name={offlineGlyph} size={BOARD_SUBTITLE_GLYPH_SIZE} color={systemColors.secondaryLabel} />
          ) : null}
          {detailText.length > 0 ? (
            <Text variant="caption1" tone="secondary" numberOfLines={1} style={styles.subtitleText}>
              {detailText}
            </Text>
          ) : null}
        </View>
      ) : null}

      {importLabel ? (
        <View style={styles.importLine}>
          <View style={[styles.importDot, { backgroundColor: systemColors.secondaryLabel }]} />
          <Text variant="caption1" tone="secondary" accessibilityLiveRegion="polite">
            {importLabel}
          </Text>
        </View>
      ) : null}
    </AnimatedPressable>
  );

  // No menu on this surface: a plain card, with no anchor to pay for.
  if (menu === undefined) return <View style={styles.container}>{card}</View>;

  // The hold anchor stays mounted even when this board has no rows, so a
  // recycled cell moving between a board with a menu and one without keeps its
  // card (and its board art request) instead of remounting it.
  return (
    <View style={styles.container}>
      <AppMenu
        actions={menuActions}
        onSelectIndex={selectFromHold}
        trigger="longPress"
        menuKey={item.key}
        menuRef={menuRef}
        // No `liftPreview`: on iOS it paints the screen background behind the
        // card at rest, which in the picker modal is a grey slab behind the title.
      >
        {card}
      </AppMenu>
      {hasMenuRows ? (
        // Outside the card's Pressable on purpose: nested inside it, the card
        // took the tap and picked the board instead of opening the menu.
        <View style={styles.menuButtonSlot}>
          <AppMenu
            // A recycled cell gets a fresh ⋯, which closes a menu drawn for the
            // board that used to be here.
            key={item.key}
            iconName="more"
            iconAppearance="plain"
            anchorSize={BOARD_MENU_BUTTON_SIZE}
            accessibilityLabel={t('mobile.discovery.cardActionsAria', { name: item.title })}
            actions={menuActions}
            onSelectIndex={selectFromMenuButton}
          />
        </View>
      ) : null}
    </View>
  );
});

/** Two empty lines: the placeholder's title box holds both at any text size. */
const PLACEHOLDER_TITLE = ' \n ';
const PLACEHOLDER_LINE = ' ';

/**
 * A card while Near you's search runs: this card's own boxes (the art, the
 * two-line title, the subtitle line) with nothing in them, so a row of them is
 * as tall as the cards that replace it, at any text size. The empty art tile is
 * all it draws. Hidden from screen readers; its row says what is happening.
 */
export function BoardDiscoveryCardPlaceholder() {
  const { systemColors } = useTheme();
  const thumbStyle = { backgroundColor: systemColors.tertiaryBackground, borderColor: systemColors.separator };
  return (
    <View style={styles.container} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.thumb, thumbStyle]} />
      <Text variant="subheadline" emphasized numberOfLines={TITLE_LINES} style={styles.title}>
        {PLACEHOLDER_TITLE}
      </Text>
      <View style={styles.subtitleLine}>
        <Text variant="caption1" numberOfLines={1}>
          {PLACEHOLDER_LINE}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: DISCOVERY_CARD_WIDTH,
  },
  card: {
    width: DISCOVERY_CARD_WIDTH,
  },
  thumb: {
    width: DISCOVERY_CARD_WIDTH,
    height: DISCOVERY_CARD_WIDTH,
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing[2],
  },
  thumbFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    minHeight: TITLE_BOX_HEIGHT,
  },
  // The ⋯ sits in this gap, level with the title, never over the art.
  titleBesideMenuButton: {
    marginRight: BOARD_MENU_BUTTON_FOOTPRINT,
  },
  menuButtonSlot: {
    position: 'absolute',
    right: 0,
    // Starts where the art ends, so the tap target never reaches over it, and
    // puts the glyph level with the title's first line.
    top: DISCOVERY_CARD_WIDTH,
    width: BOARD_MENU_BUTTON_FOOTPRINT,
    height: BOARD_MENU_BUTTON_FOOTPRINT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  subtitleText: {
    // RN row children default to flexShrink: 0, so without this a long subtitle
    // pushes past the card instead of ellipsising.
    flexShrink: 1,
  },
  importLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  importDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});

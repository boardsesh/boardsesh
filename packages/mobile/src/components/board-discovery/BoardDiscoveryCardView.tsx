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
import { sprayImportCopy } from '../../lib/spray/spray-import-progress';
import { useTheme } from '../../providers/theme-provider';
import { springs } from '../../theme/animations';
import { borderRadius, spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE, textStyles } from '../../theme/typography';
import { AppMenu } from '../AppMenu';
import type { AppMenuAction, AppMenuHandle } from '../AppMenu.types';
import { Icon } from '../Icon';
import { Text } from '../Text';
import {
  BOARD_CARD_MENU_SYSTEM_ICONS,
  boardCardMenuEntries,
  boardCardMenuLabel,
  type BoardCardMenuAction,
  type BoardCardMenuCapabilities,
  type BoardCardMenuEntry,
  type BoardCardMenuLabels,
  type BoardCardMenuVia,
} from './board-card-menu';
import type { BoardDownloadState } from './board-offline-state';

/** The minimal board shape the card renders. UserBoard, PopularBoardConfig, and
 *  BLE-resolved boards all map onto this so one card serves every section. */
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
   * `userBoardToItem`. `undefined` means "not resolvable here" — Near you /
   * Popular, or a session with no identity — and offers neither unfollow nor
   * delete rather than guessing (offering to unfollow the user's own wall is
   * worse than offering nothing).
   */
  isViewerOwner?: boolean;
  /** Whether the viewer pinned this board to the front of their list. */
  isPinned?: boolean;
  /**
   * Offline download state for this board's scope. Absent on cards that cannot
   * be downloaded as a board (popular configs — see `popularConfigToItem`).
   */
  offlineState?: BoardDownloadState;
  sprayImport?: SprayWallImportProgress | null;
  importStatusStale?: boolean;
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

/**
 * The ⋯ beside the title. iOS draws the glyph in a 44pt square, the HIG's tap
 * floor; Android's M3 IconButton keeps its own 48dp target whatever size it is
 * asked for. The title stops short of this width so the two never overlap.
 */
const MENU_BUTTON_SIZE = 44;
const MENU_BUTTON_FOOTPRINT = Platform.OS === 'android' ? 48 : MENU_BUTTON_SIZE;

const SUBTITLE_GLYPH_SIZE = 12;

const NO_ROWS: readonly BoardCardMenuRow[] = [];

type BoardCardMenuRow = BoardCardMenuEntry & { label: string };

/** Distance copy: whole metres under 1 km, one-decimal kilometres above. */
function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type BoardDiscoveryCardViewProps = {
  boardImage?: ReactNode;
  item: DiscoveryBoardItem;
  onPress: (item: DiscoveryBoardItem) => void;
  /**
   * The ⋯ menu, the hold on the card and the screen-reader actions, all from the
   * same rows. Absent on Popular (a config, not a board) and on the offline
   * list (every row behind it needs a connection), which draw a plain card.
   */
  menu?: BoardCardMenu;
};

/**
 * One board in a carousel. Memoized: three carousels stacked on the Boards tab
 * re-render together whenever any of their queries settle, and each card resolves
 * board art. The menu object is shared by the whole rail, so a card re-renders
 * only when its own item changes.
 *
 * Nothing sits on the board art. State reads as small glyphs at the head of the
 * subtitle line, and every action lives in the menu.
 */
export const BoardDiscoveryCardView = memo(function BoardDiscoveryCardView({
  boardImage,
  item,
  onPress,
  menu,
}: BoardDiscoveryCardViewProps) {
  const { t } = useTranslation('boards');
  const importCopy = item.sprayImport ? sprayImportCopy(item.sprayImport, item.importStatusStale) : null;
  const importLabel = importCopy ? t(importCopy.textI18nKey, importCopy.params) : null;
  const { systemColors, brandColors } = useTheme();
  const scale = useSharedValue(1);
  const menuRef = useRef<AppMenuHandle | null>(null);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const thumbStyle = {
    backgroundColor: systemColors.tertiaryBackground,
    borderColor: item.isActive ? brandColors.primary : systemColors.separator,
    borderWidth: item.isActive ? 2 : StyleSheet.hairlineWidth,
  };

  // Scalars, so a fresh item object with the same state keeps the same rows —
  // and with them the same accessibility actions and menu actions.
  const isPinned = item.isPinned === true;
  const isImport = item.sprayImport != null;
  const isSprayWall = item.boardName === 'spray';
  const { offlineState, isViewerOwner } = item;
  const capabilities = menu?.capabilities;
  const labels = menu?.labels;
  const onMenuAction = menu?.onAction;
  const rows = useMemo<readonly BoardCardMenuRow[]>(() => {
    if (capabilities === undefined || labels === undefined) return NO_ROWS;
    const entries = boardCardMenuEntries({ isPinned, offlineState, isViewerOwner, isImport }, capabilities);
    if (entries.length === 0) return NO_ROWS;
    return entries.map((entry) => ({ ...entry, label: boardCardMenuLabel(entry.action, labels, isSprayWall) }));
  }, [capabilities, labels, isPinned, offlineState, isViewerOwner, isImport, isSprayWall]);
  const hasMenuRows = rows.length > 0;
  const menuActions = useMemo<AppMenuAction[]>(
    () =>
      rows.map((row) => ({
        label: row.label,
        systemIcon: BOARD_CARD_MENU_SYSTEM_ICONS[row.action],
        destructive: row.destructive,
        dividerBefore: row.dividerBefore,
      })),
    [rows],
  );

  const handlePress = useCallback(() => {
    hapticLight();
    onPress(item);
  }, [onPress, item]);

  const runMenuRow = useCallback(
    (index: number, via: BoardCardMenuVia) => {
      const row = rows[index];
      if (row !== undefined) onMenuAction?.(item, row.action, via);
    },
    [rows, onMenuAction, item],
  );
  const selectFromMenuButton = useCallback((index: number) => runMenuRow(index, 'menu_button'), [runMenuRow]);
  const selectFromHold = useCallback((index: number) => runMenuRow(index, 'long_press'), [runMenuRow]);

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
      .filter((row) => row.action !== 'climb_here')
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
      const index = rows.findIndex((row) => row.action === actionName && row.action !== 'climb_here');
      if (index >= 0) runMenuRow(index, 'accessibility');
    },
    [rows, handlePress, runMenuRow],
  );

  const onItLabel = t('mobile.discovery.onIt');
  const offlineGlyph =
    offlineState === 'downloaded'
      ? 'offline.downloaded'
      : offlineState === 'downloading' || offlineState === 'finalizing' || offlineState === 'pending'
        ? 'offline.pending'
        : null;
  const offlineLabel =
    offlineState === 'downloaded'
      ? t('mobile.offline.available')
      : offlineState === 'downloading'
        ? t('mobile.offline.bootstrapping')
        : offlineState === 'finalizing'
          ? t('mobile.offline.finalizing')
          : offlineState === 'pending'
            ? t('mobile.offline.pending')
            : null;
  const distanceLabel = item.distanceMeters != null ? formatDistance(item.distanceMeters) : null;
  const detailText = [distanceLabel, item.subtitle]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' · ');
  // The separator after "On it" only when something follows it on the line.
  const onItText = isPinned || offlineGlyph !== null || detailText.length > 0 ? `${onItLabel} ·` : onItLabel;
  const showSubtitleLine = item.isActive === true || isPinned || offlineGlyph !== null || detailText.length > 0;

  // No glyph says owned or followed any more, so the composed label has to:
  // otherwise a screen-reader user cannot tell which board Unfollow removes.
  const ownershipLabel =
    item.isViewerOwner === undefined
      ? null
      : item.isViewerOwner
        ? t('mobile.discovery.ownedBadgeAria')
        : t('mobile.discovery.followingBadgeAria');
  const pinnedLabel = isPinned ? t('mobile.discovery.pinnedBadgeAria') : null;
  const accessibilityLabel = [
    item.title,
    item.isActive ? onItLabel : null,
    distanceLabel,
    item.subtitle,
    ownershipLabel,
    pinnedLabel,
    offlineLabel,
    importLabel,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(', ');

  const card = (
    <AnimatedPressable
      onPress={handlePress}
      onLongPress={onLongPress}
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
        numberOfLines={TITLE_LINES}
        color={item.isActive ? brandColors.primary : undefined}
        style={[styles.title, hasMenuRows ? styles.titleBesideMenuButton : null]}
      >
        {item.title}
      </Text>
      {showSubtitleLine ? (
        <View testID="board-card-subtitle" style={styles.subtitleLine}>
          {item.isActive ? (
            <>
              <Icon name="tick.fill" size={SUBTITLE_GLYPH_SIZE} color={brandColors.primary} />
              <Text
                variant="caption1"
                color={brandColors.primary}
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                style={styles.onIt}
              >
                {onItText}
              </Text>
            </>
          ) : null}
          {isPinned ? <Icon name="pin.fill" size={SUBTITLE_GLYPH_SIZE} color={systemColors.secondaryLabel} /> : null}
          {offlineGlyph !== null ? (
            <Icon
              name={offlineGlyph}
              size={SUBTITLE_GLYPH_SIZE}
              color={offlineGlyph === 'offline.downloaded' ? brandColors.primaryFill : systemColors.secondaryLabel}
            />
          ) : null}
          {detailText.length > 0 ? (
            <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.subtitleText}>
              {detailText}
            </Text>
          ) : null}
        </View>
      ) : null}

      {importLabel ? (
        <Text variant="caption1" color={brandColors.primary} accessibilityLiveRegion="polite">
          {importLabel}
        </Text>
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
        liftPreview
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
            anchorSize={MENU_BUTTON_SIZE}
            accessibilityLabel={t('mobile.discovery.cardActionsAria', { name: item.title })}
            actions={menuActions}
            onSelectIndex={selectFromMenuButton}
          />
        </View>
      ) : null}
    </View>
  );
});

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
    fontWeight: '600',
    minHeight: TITLE_BOX_HEIGHT,
  },
  // The ⋯ sits in this gap, level with the title, never over the art.
  titleBesideMenuButton: {
    marginRight: MENU_BUTTON_FOOTPRINT,
  },
  menuButtonSlot: {
    position: 'absolute',
    right: 0,
    // Starts where the art ends, so the tap target never reaches over it, and
    // puts the glyph level with the title's first line.
    top: DISCOVERY_CARD_WIDTH,
    width: MENU_BUTTON_FOOTPRINT,
    height: MENU_BUTTON_FOOTPRINT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  onIt: {
    fontWeight: '600',
  },
  subtitleText: {
    // RN row children default to flexShrink: 0, so without this a long subtitle
    // pushes past the card instead of ellipsising.
    flexShrink: 1,
  },
});

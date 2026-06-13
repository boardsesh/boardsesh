import { useCallback, type ReactNode, isValidElement } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { type SharedValue, Extrapolation, interpolate, useAnimatedStyle } from 'react-native-reanimated';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { formatActiveBoardLabel } from '../../lib/boards/active-board-label';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { hapticLight } from '../../lib/haptics';
import { shadows } from '../../theme/tokens';
import { Icon } from '../Icon';
import { GlassSurface } from '../GlassSurface';
import { BoardPill } from './BoardPill';
import { GlassActionToolbar, GlassToolbarAction, TOP_ACTION_SIZE } from './GlassActionToolbar';
import { AngleToolbarAction } from './AngleToolbarAction';
import { LightbulbToolbarAction } from './LightbulbToolbarAction';
import { CollapsingLargeTitleHeader, useCollapseProgress } from './CollapsingLargeTitleHeader';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';

const TOP_TOOLBAR_RADIUS = TOP_ACTION_SIZE / 2;

type CollapsingTopChromeProps = {
  /** The screen's identity, shown in the centred collapsed capsule. Callers render
   *  the matching large in-body title at the top of their scroll content. */
  title: string;
  /** VoiceOver label for the collapsed title capsule. Defaults to `title`. */
  titleAccessibilityLabel?: string;
  /** Gate the create action (left island). */
  canCreate: boolean;
  /** The screen's defining create action. */
  onCreate: () => void;
  /** VoiceOver label for the create action (namespace differs per screen). */
  createAccessibilityLabel: string;
  /** Open the full board switcher; the board pill doubles as the board filter. */
  onOpenBoardSwitcher: () => void;
  /** Optional VoiceOver hint for the board pill. */
  boardPillAccessibilityHint?: string;
  /** Keep the active board as the compact toolbar glyph instead of the centered board pill. */
  compactBoardControl?: boolean;
  /** Report the measured chrome height so the list can inset its top padding. */
  onHeightChange: (height: number) => void;
  /** List scroll offset, driving the title collapse. */
  scrollY: SharedValue<number>;
  /** Tapping the collapsed title capsule scrolls the list back to the top. */
  onPressTitle: () => void;
  /** Optional glass action(s) docked at the far right of the right toolbar (e.g. the
   *  Record tab's share/invite + End controls). Discover/Climbs pass none, so their
   *  toolbar is unchanged. Stays visible at rest and collapsed, like the light. */
  trailingAction?: ReactNode;
  /** Number of action slots `trailingAction` occupies, so the right toolbar widens
   *  correctly when it carries more than one glyph (e.g. share + End). Defaults to
   *  1 when `trailingAction` is a single element, 0 otherwise — a fragment of N
   *  actions must pass its real count so the island doesn't clip to one slot. */
  trailingActionCount?: number;
  /** Glass action docked at the LEFT of the islands row, inside the left island
   *  before the create/angle controls (e.g. the Record tab's in-session invite). */
  leadingAction?: ReactNode;
  /** Number of slots `leadingAction` occupies (defaults to 1 for a single element). */
  leadingActionCount?: number;
  /** Suppress the bluetooth lightbulb in the right toolbar — e.g. the active-session
   *  header, which keeps only the stop control on the right. */
  hideLight?: boolean;
  /** Extra controls rendered below the islands row (e.g. the Climbs search row).
   *  Discover passes none. Measured into the reported chrome height. */
  children?: ReactNode;
};

/**
 * Shared floating glass chrome — a centred board pill flanked by angle / create /
 * light islands over a fade scrim. On scroll the screen's large in-body title
 * collapses into a centred capsule while the board control docks into the
 * right-hand glass toolbar beside the lightbulb. The board reveal animates the
 * toolbar's width (not opacity), so it stays a live glass surface.
 *
 * Composes the board-agnostic `CollapsingLargeTitleHeader` (scrim, title capsule,
 * islands row) and supplies the board pill as the centre content plus the
 * board-glyph dock as the right island. Used by the Discover tab
 * (`DiscoverTopChrome`), the Climbs/Search tab (`ClimbTopChrome`, which adds a
 * search row via `children`), and the Record tab (`RecordTopChrome`, which adds a
 * share `trailingAction`).
 */
export function CollapsingTopChrome({
  title,
  titleAccessibilityLabel,
  canCreate,
  onCreate,
  createAccessibilityLabel,
  onOpenBoardSwitcher,
  boardPillAccessibilityHint,
  compactBoardControl = false,
  onHeightChange,
  scrollY,
  onPressTitle,
  trailingAction,
  trailingActionCount,
  leadingAction,
  leadingActionCount,
  hideLight = false,
  children,
}: CollapsingTopChromeProps) {
  const { systemColors } = useTheme();
  const nativeGlass = useNativeGlass();
  const { data: activeBoard } = useActiveBoard();
  const bluetooth = useOptionalBluetoothContext();
  const { progress, collapsed } = useCollapseProgress(scrollY);
  const boardGlyphLabel = formatActiveBoardLabel(activeBoard) ?? title;
  const handleOpenBoardSwitcher = useCallback(() => {
    hapticLight();
    onOpenBoardSwitcher();
  }, [onOpenBoardSwitcher]);

  const canOpenAngle = activeBoard?.isAngleAdjustable !== false && activeBoard?.angle != null;
  // A fragment/element of leading actions reads as one element, so callers passing
  // several supply the explicit count; otherwise reserve a slot only for a real one.
  const leadingActions = leadingActionCount ?? (isValidElement(leadingAction) ? 1 : 0);
  const leftActionCount = 1 + leadingActions + (canCreate ? 1 : 0) + (canOpenAngle ? 1 : 0);

  // The right glass toolbar holds the lightbulb (and an optional trailing action)
  // at rest, and grows to also hold a compact board glyph once collapsed. Screens
  // that need more horizontal space can keep that board glyph visible at rest.
  const lightActions = bluetooth && !hideLight ? 1 : 0;
  // Reserve a slot only for a real element — a `false`/`null` from a `cond && <…>`
  // caller must not widen the toolbar by a phantom 48px. Callers passing a fragment
  // of several actions supply `trailingActionCount` explicitly (a fragment reads as
  // one element), so the island widens to fit them all.
  const trailingActions = trailingActionCount ?? (isValidElement(trailingAction) ? 1 : 0);
  const toolbarBoardActions = activeBoard && compactBoardControl ? 1 : 0;
  const expandedRightActions = toolbarBoardActions + lightActions + trailingActions;
  const collapsedRightActions = (activeBoard ? 1 : 0) + lightActions + trailingActions;
  const expandedRightWidth = expandedRightActions * TOP_ACTION_SIZE;
  const collapsedRightWidth = collapsedRightActions * TOP_ACTION_SIZE;

  const rightToolbarStyle = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0.4, 1], [expandedRightWidth, collapsedRightWidth], Extrapolation.CLAMP),
  }));
  const boardGlyphStyle = useAnimatedStyle(() => ({
    opacity: compactBoardControl ? 1 : interpolate(progress.value, [0.55, 1], [0, 1], Extrapolation.CLAMP),
  }));

  const leftActions = (
    <GlassActionToolbar actionCount={leftActionCount}>
      <UserAvatarToolbarAction variant="glass" />
      {leadingAction}
      {canCreate ? (
        <GlassToolbarAction onPress={onCreate} accessibilityLabel={createAccessibilityLabel}>
          <Icon name="plus" size={24} color={systemColors.label} />
        </GlassToolbarAction>
      ) : null}
      <AngleToolbarAction />
    </GlassActionToolbar>
  );

  // Right glass toolbar: lightbulb (+ trailing action) at rest, widening to dock
  // the board glyph once collapsed unless the caller keeps the compact board
  // control visible at rest. The glass surface stays at full opacity (its width
  // animates), so it reads as live glass like the left island.
  const rightActions =
    collapsedRightWidth > 0 ? (
      <Animated.View
        style={[
          styles.rightToolbar,
          rightToolbarStyle,
          !nativeGlass && shadows.sm,
          !nativeGlass && { borderWidth: StyleSheet.hairlineWidth, borderColor: systemColors.separator },
        ]}
      >
        <GlassSurface
          glassEffectStyle="regular"
          fallbackColor={systemColors.elevatedSurface}
          borderRadius={TOP_TOOLBAR_RADIUS}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {activeBoard ? (
          <Animated.View pointerEvents={compactBoardControl || collapsed ? 'auto' : 'none'} style={boardGlyphStyle}>
            <GlassToolbarAction
              onPress={handleOpenBoardSwitcher}
              accessibilityLabel={boardGlyphLabel}
              accessibilityHint={boardPillAccessibilityHint}
            >
              <Icon name="boards" size={20} color={systemColors.label} />
            </GlassToolbarAction>
          </Animated.View>
        ) : null}
        {bluetooth && !hideLight ? <LightbulbToolbarAction /> : null}
        {trailingAction}
      </Animated.View>
    ) : null;

  return (
    <CollapsingLargeTitleHeader
      title={title}
      titleAccessibilityLabel={titleAccessibilityLabel}
      scrollY={scrollY}
      onPressTitle={onPressTitle}
      onHeightChange={onHeightChange}
      leftActions={leftActions}
      rightActions={rightActions}
      centerContent={
        compactBoardControl ? undefined : (
          <BoardPill onPress={onOpenBoardSwitcher} accessibilityHint={boardPillAccessibilityHint} />
        )
      }
    >
      {children}
    </CollapsingLargeTitleHeader>
  );
}

const styles = StyleSheet.create({
  rightToolbar: {
    height: TOP_ACTION_SIZE,
    borderRadius: TOP_TOOLBAR_RADIUS,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
});

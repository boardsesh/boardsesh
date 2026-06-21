import { type ReactNode, isValidElement, useCallback } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Appbar } from 'react-native-paper';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { shadows } from '../../theme/tokens';
import { Icon } from '../Icon';
import { GlassSurface } from '../GlassSurface';
import { BoardToolbarAction } from './BoardToolbarAction';
import { BoardSwitcherButton } from './BoardSwitcherButton';
import { GlassActionToolbar, GlassToolbarAction, TOP_ACTION_SIZE } from './GlassActionToolbar';
import { AngleToolbarAction } from './AngleToolbarAction';
import { LightbulbToolbarAction } from './LightbulbToolbarAction';
import { MaterialAngleAction, MaterialLightbulbAction } from './MaterialBoardActions';
import { CollapsingLargeTitleHeader } from './CollapsingLargeTitleHeader';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';

const TOP_TOOLBAR_RADIUS = TOP_ACTION_SIZE / 2;

type CollapsingTopChromeProps = {
  /** Gate the create action (left island). */
  canCreate: boolean;
  /** The screen's defining create action. */
  onCreate: () => void;
  /** VoiceOver label for the create action (namespace differs per screen). */
  createAccessibilityLabel: string;
  /** Open the full board switcher; the board glyph doubles as the board filter. */
  onOpenBoardSwitcher: () => void;
  /** Optional VoiceOver hint for the board glyph. */
  boardPillAccessibilityHint?: string;
  /** Show a brand-coloured dot on the board glyph — the one-time onboarding cue. */
  boardBadge?: boolean;
  /** Report the measured chrome height so the list can inset its top padding. */
  onHeightChange: (height: number) => void;
  /** Optional persistent plain centre title (Climbs filter summary). */
  centerTitle?: string;
  /** Optional glass action(s) docked at the far right of the right toolbar (e.g. the
   *  Record tab's share/invite + End controls). Discover/Climbs pass none. */
  trailingAction?: ReactNode;
  /** Number of action slots `trailingAction` occupies, so the right toolbar sizes
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
 * Shared floating glass chrome — a left island (avatar / create / angle) and a
 * right island (board / light / trailing) over an always-on progressive blur.
 * The islands stay put; the screen's large in-body title simply scrolls away
 * under the blur. Climbs additionally passes `centerTitle` (its filter summary),
 * which sits as a persistent plain title in the centre of the islands row.
 *
 * Composes the board-agnostic `CollapsingLargeTitleHeader`. The board control is
 * a single glass glyph (`BoardToolbarAction`) docked in the right toolbar beside
 * the lightbulb — there is no large centred board pill. Used by Discover
 * (`DiscoverTopChrome`), Climbs (`ClimbTopChrome`, which adds a search row via
 * `children` + the centre title), and Record (`RecordTopChrome`, which adds a
 * share `trailingAction`).
 */
export function CollapsingTopChrome({
  canCreate,
  onCreate,
  createAccessibilityLabel,
  onOpenBoardSwitcher,
  boardPillAccessibilityHint,
  boardBadge = false,
  onHeightChange,
  centerTitle,
  trailingAction,
  trailingActionCount,
  leadingAction,
  leadingActionCount,
  hideLight = false,
  children,
}: CollapsingTopChromeProps) {
  const { systemColors, variant } = useTheme();
  const insets = useSafeAreaInsets();
  const nativeGlass = useNativeGlass();
  const { data: activeBoard } = useActiveBoard();
  const bluetooth = useOptionalBluetoothContext();

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );

  // Material (Android default): a real M3 small top app bar instead of the floating
  // glass islands. Climbs/Record short-circuit to their own Appbar before delegating
  // here, so in practice only Discover reaches this branch — the avatar, board
  // switcher, angle, and lightbulb come from the shared Material helpers. The create
  // action is the screen's Material FAB (see `DiscoverLibrary`), not an app-bar
  // control, so `canCreate` / `onCreate` are intentionally unused here. The `children`
  // / `centerTitle` / leading / trailing props are liquid-glass-only affordances
  // (Climbs' search row, Record's session controls) and never reach this branch.
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  if (isMaterial) {
    return (
      <View
        pointerEvents="box-none"
        style={[
          styles.materialContainer,
          {
            paddingTop: insets.top,
            backgroundColor: systemColors.secondaryBackground,
            borderBottomColor: systemColors.separator,
          },
        ]}
        onLayout={handleLayout}
      >
        <Appbar.Header
          statusBarHeight={0}
          mode="small"
          elevated
          style={[styles.materialAppbar, { backgroundColor: systemColors.secondaryBackground }]}
        >
          <UserAvatarToolbarAction variant="material" />
          <BoardSwitcherButton
            onPress={onOpenBoardSwitcher}
            accessibilityHint={boardPillAccessibilityHint}
            badge={boardBadge}
          />
          <MaterialAngleAction />
          <MaterialLightbulbAction />
        </Appbar.Header>
      </View>
    );
  }

  const canOpenAngle = activeBoard?.isAngleAdjustable !== false && activeBoard?.angle != null;
  // A fragment/element of leading actions reads as one element, so callers passing
  // several supply the explicit count; otherwise reserve a slot only for a real one.
  const leadingActions = leadingActionCount ?? (isValidElement(leadingAction) ? 1 : 0);
  const leftActionCount = 1 + leadingActions + (canCreate ? 1 : 0) + (canOpenAngle ? 1 : 0);

  // The right glass toolbar holds the board glyph, the lightbulb, and an optional
  // trailing action — a fixed-width island sized to whichever of those are live.
  // The board glyph shows whenever a board is set; the lightbulb is hidden when
  // `hideLight` (e.g. the active-session header).
  const boardActions = activeBoard ? 1 : 0;
  const lightActions = bluetooth && !hideLight ? 1 : 0;
  // Reserve a slot only for a real element — a `false`/`null` from a `cond && <…>`
  // caller must not widen the toolbar by a phantom 48px. Callers passing a fragment
  // of several actions supply `trailingActionCount` explicitly.
  const trailingActions = trailingActionCount ?? (isValidElement(trailingAction) ? 1 : 0);
  const rightActionCount = boardActions + lightActions + trailingActions;
  const rightToolbarWidth = rightActionCount * TOP_ACTION_SIZE;

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

  // Right glass toolbar: board glyph + lightbulb (+ optional trailing action),
  // fixed width. Order reads board → light → trailing (session controls furthest
  // right).
  const rightActions =
    rightToolbarWidth > 0 ? (
      <View
        style={[
          styles.rightToolbar,
          { width: rightToolbarWidth },
          !nativeGlass && shadows.sm,
          !nativeGlass && { borderWidth: StyleSheet.hairlineWidth, borderColor: systemColors.separator },
        ]}
      >
        <GlassSurface
          // `clear` (lighter, content-forward) to match the other floating islands.
          glassEffectStyle="clear"
          fallbackColor={systemColors.elevatedSurface}
          borderRadius={TOP_TOOLBAR_RADIUS}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {activeBoard ? (
          <BoardToolbarAction
            onPress={onOpenBoardSwitcher}
            accessibilityHint={boardPillAccessibilityHint}
            badge={boardBadge}
          />
        ) : null}
        {bluetooth && !hideLight ? <LightbulbToolbarAction /> : null}
        {trailingAction}
      </View>
    ) : null;

  return (
    <CollapsingLargeTitleHeader
      centerTitle={centerTitle}
      onHeightChange={onHeightChange}
      leftActions={leftActions}
      rightActions={rightActions}
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
  // Material small app bar (mirrors ClimbTopChrome / RecordTopChrome): absolutely
  // positioned so the list scrolls under it, height reported via onLayout.
  materialContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  materialAppbar: {
    elevation: 0,
    shadowOpacity: 0,
  },
});

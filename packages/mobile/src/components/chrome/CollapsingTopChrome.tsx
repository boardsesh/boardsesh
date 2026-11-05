import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import type { ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import { type ReactElement, type ReactNode, isValidElement, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { canAdjustBoardAngle } from '../../lib/boards/can-adjust-board-angle';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { useNativeRootBarItems } from '../../hooks/use-native-root-bar-items';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { shadows } from '../../theme/tokens';
import { Icon } from '../Icon';
import { GlassSurface } from '../GlassSurface';
import { BoardToolbarAction } from './BoardToolbarAction';
import { BoardSwitcherButton } from './BoardSwitcherButton';
import { ShowcaseAnchorView } from '../../lib/showcase-anchor';
import {
  GlassActionToolbar,
  GlassToolbarAction,
  NATIVE_ACTION_SIZE,
  TOP_ACTION_SIZE,
  toolbarGlyphSize,
} from './GlassActionToolbar';
import { AngleToolbarAction } from './AngleToolbarAction';
import { LightbulbToolbarAction } from './LightbulbToolbarAction';
import { MaterialAngleAction, MaterialLightbulbAction } from './MaterialBoardActions';
import { CollapsingLargeTitleHeader } from './CollapsingLargeTitleHeader';
import { NativeRootHeader } from './NativeRootHeader';
import { NativeHeaderActionContext } from './native-header-action-context';
import { MaterialTopAppBar } from './MaterialTopAppBar';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';
import { iconMap } from '../icon-map';
import { BOARD_HISTORY_ITEM_ID, barItemsFactory, symbolBarItem, type RootBarItem } from './root-bar-items';
import type { NativeBarSide } from './native-title-bound';
import { NativeTrailingItemShowcaseAnchor } from './NativeTrailingItemShowcaseAnchor';
import { ClimbListBoardActions, climbListBoardActionCount } from './ClimbListBoardActions';
import {
  useAccountRailItem,
  useAngleBarItem,
  useBarItemsOnRail,
  useBoardSwitcherBarItem,
  useClimbListBarItems,
  useLightbulbBarItem,
} from './use-root-bar-items';

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
  /** Replace the default angle/board pair while retaining shared toolbar sizing. */
  boardControls?: { content: ReactNode; actionCount: number };
  /**
   * The Climbs list's `boardControls` on the iOS 26 header: board history and
   * the list's ⋯ menu instead of the board switcher. A glass island on iPhone,
   * native items on iPad and the Duo rail.
   */
  climbListBarActions?: { onOpenHistory: () => void; badge: boolean };
  /** Report the measured chrome height so the list can inset its top padding. */
  onHeightChange: (height: number) => void;
  /** The destination's name, the Material app bar's title ("Discover"). The
   *  liquid-glass islands have no title slot and ignore it. */
  materialTitle: string;
  /** Optional persistent plain centre title (Climbs filter summary). */
  centerTitle?: string;
  /** Optional interactive element for the centre slot (Climbs "On the wall"
   *  capsule), taking precedence over `centerTitle`. */
  centerContent?: ReactNode;
  /** iOS native header only: draw no title for a screen its tab already names
   *  (Climbs). See `NativeRootHeader`. */
  titleHidden?: boolean;
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
  /** Report the board glyph to the showcase-video recorder (screenshot mode). Only
   *  the Climbs chrome sets it, so one tab logs the `board-history-button` rect. */
  anchorBoardButton?: boolean;
  /** Extra controls rendered below the islands row (e.g. the Climbs search row).
   *  Discover passes none. Measured into the reported chrome height. */
  children?: ReactNode;
  /** Legacy scroll-edge wiring. Native supplementary controls do not attach a backdrop. */
  scrollEdge?: ScrollEdgeBackdrop;
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
 * (`DiscoverTopChrome`), Climbs (`ClimbTopChrome`, which adds its filter chips via
 * `children` and hides the native title), and Record (`RecordTopChrome`, which adds
 * a share `trailingAction`).
 */
export function CollapsingTopChrome({
  canCreate,
  onCreate,
  createAccessibilityLabel,
  onOpenBoardSwitcher,
  boardPillAccessibilityHint,
  boardBadge = false,
  boardControls,
  climbListBarActions,
  onHeightChange,
  materialTitle,
  centerTitle,
  centerContent,
  titleHidden = false,
  trailingAction,
  trailingActionCount,
  leadingAction,
  leadingActionCount,
  hideLight = false,
  anchorBoardButton = false,
  children,
  scrollEdge,
}: CollapsingTopChromeProps) {
  const { systemColors, variant } = useTheme();
  const nativeGlass = useNativeGlass();
  const nativeHeader = useNativeRootHeader();
  const nativeBarItems = useNativeRootBarItems();
  const { data: activeBoard } = useActiveBoard();
  const bluetooth = useOptionalBluetoothContext();

  // Material (Android default): the shared M3 small top app bar instead of the
  // floating glass islands. Climbs short-circuits to its own bar before delegating
  // here, so in practice only Discover reaches this branch — the avatar, the
  // screen title with the board switcher as its subtitle, angle, and lightbulb. The create
  // action is the screen's Material FAB (see `DiscoverLibrary`), not an app-bar
  // control, so `canCreate` / `onCreate` are intentionally unused here. The `children`
  // / `centerTitle` / leading / trailing props are liquid-glass-only affordances
  // (Climbs' filter chips, Record's session controls) and never reach this branch.
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  if (isMaterial) {
    return (
      <MaterialTopAppBar onHeightChange={onHeightChange} scrollEdge={scrollEdge}>
        <UserAvatarToolbarAction variant="material" />
        <BoardSwitcherButton
          title={materialTitle}
          onPress={onOpenBoardSwitcher}
          accessibilityHint={boardPillAccessibilityHint}
          badge={boardBadge}
          showcaseAnchor={anchorBoardButton}
        />
        <MaterialAngleAction />
        <MaterialLightbulbAction />
      </MaterialTopAppBar>
    );
  }

  if (nativeHeader && nativeBarItems)
    return (
      <CollapsingNativeBarHeader
        canCreate={canCreate}
        onCreate={onCreate}
        createAccessibilityLabel={createAccessibilityLabel}
        onOpenBoardSwitcher={onOpenBoardSwitcher}
        boardPillAccessibilityHint={boardPillAccessibilityHint}
        boardBadge={boardBadge}
        climbListBarActions={climbListBarActions}
        hideLight={hideLight}
        anchorBoardButton={anchorBoardButton}
        leadingAction={leadingAction}
        trailingAction={trailingAction}
        centerContent={centerContent}
        titleHidden={titleHidden}
        scrollEdge={scrollEdge}
        onHeightChange={onHeightChange}
      >
        {children}
      </CollapsingNativeBarHeader>
    );

  const canOpenAngle = canAdjustBoardAngle(activeBoard);
  // A fragment/element of leading actions reads as one element, so callers passing
  // several supply the explicit count; otherwise reserve a slot only for a real one.
  const leadingActions = leadingActionCount ?? (isValidElement(leadingAction) ? 1 : 0);
  // Left island = identity + authoring: avatar (+ optional leading) + create. The
  // angle moved to the right island with the board glyph (both board-config
  // controls that act on the displayed list), so it's no longer counted here.
  const leftActionCount = 1 + leadingActions + (canCreate ? 1 : 0);

  // The right glass toolbar holds the angle, the board glyph, the lightbulb, and an
  // optional trailing action — a fixed-width island sized to whichever are live.
  // The board glyph shows whenever a board is set; the lightbulb is hidden when
  // `hideLight` (e.g. the active-session header / climbs tab). The angle slot is
  // counted only when adjustable so fixed-angle boards don't get a phantom slot.
  const boardActionCount = boardControls?.actionCount ?? (canOpenAngle ? 1 : 0) + (activeBoard ? 1 : 0);
  const lightActions = bluetooth && !hideLight ? 1 : 0;
  // Reserve a slot only for a real element — a `false`/`null` from a `cond && <…>`
  // caller must not widen the toolbar by a phantom 48px. Callers passing a fragment
  // of several actions supply `trailingActionCount` explicitly.
  const trailingActions = trailingActionCount ?? (isValidElement(trailingAction) ? 1 : 0);
  const rightActionCount = boardActionCount + lightActions + trailingActions;
  const rightToolbarWidth = rightActionCount * TOP_ACTION_SIZE;

  const leftActions = (
    <LeadingIsland
      actionCount={leftActionCount}
      leadingAction={leadingAction}
      canCreate={canCreate}
      onCreate={onCreate}
      createAccessibilityLabel={createAccessibilityLabel}
      nativeHeader={nativeHeader}
    />
  );

  const boardControlContent = boardControls ? (
    boardControls.content
  ) : (
    <>
      <AngleToolbarAction />
      {activeBoard ? (
        <ShowcaseAnchorView name="board-history-button" enabled={anchorBoardButton}>
          <BoardToolbarAction
            onPress={onOpenBoardSwitcher}
            accessibilityHint={boardPillAccessibilityHint}
            badge={boardBadge}
          />
        </ShowcaseAnchorView>
      ) : null}
    </>
  );

  // Right glass toolbar: angle + board glyph + lightbulb (+ optional trailing
  // action), fixed width. Order reads angle → board → light → trailing — the angle
  // sits inboard (less-extreme corner for a frequently-tapped control) next to the
  // board glyph (both board-config controls), board keeps its trailing anchor.
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
          // Regular glass matches the other toolbar islands over app content.
          glassEffectStyle="regular"
          fallbackColor={systemColors.elevatedSurface}
          borderRadius={TOP_TOOLBAR_RADIUS}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {boardControlContent}
        {bluetooth && !hideLight ? <LightbulbToolbarAction /> : null}
        {trailingAction}
      </View>
    ) : null;

  if (nativeHeader)
    return (
      <NativeRootHeader
        leftActions={leftActions}
        leftActionsStandalone={leftActionCount === 1}
        centerContent={centerContent}
        titleHidden={titleHidden}
        centerActionWidths={{
          leading: leftActionCount * NATIVE_ACTION_SIZE,
          trailing: rightActionCount * NATIVE_ACTION_SIZE,
        }}
        rightActions={
          rightActionCount > 0 ? (
            <GlassActionToolbar actionCount={rightActionCount}>
              {boardControlContent}
              {bluetooth && !hideLight ? <LightbulbToolbarAction /> : null}
              {trailingAction}
            </GlassActionToolbar>
          ) : undefined
        }
        scrollEdge={scrollEdge}
        onHeightChange={onHeightChange}
      >
        {children}
      </NativeRootHeader>
    );

  return (
    <CollapsingLargeTitleHeader
      centerTitle={centerTitle}
      centerContent={centerContent}
      onHeightChange={onHeightChange}
      leftActions={leftActions}
      rightActions={rightActions}
    >
      {children}
    </CollapsingLargeTitleHeader>
  );
}

/**
 * The left island: the glass avatar (round photo, initials without one), the
 * angle where the bar puts it here, an optional leading action, then +. The
 * floating chrome, the native header's custom leading group and the
 * native-item header's horizontal bar share it.
 */
function LeadingIsland({
  actionCount,
  angle,
  leadingAction,
  canCreate,
  onCreate,
  createAccessibilityLabel,
  nativeHeader,
}: {
  actionCount: number;
  angle?: ReactNode;
  leadingAction?: ReactNode;
  canCreate: boolean;
  onCreate: () => void;
  createAccessibilityLabel: string;
  nativeHeader: boolean;
}) {
  const { systemColors } = useTheme();
  return (
    <GlassActionToolbar actionCount={actionCount}>
      <UserAvatarToolbarAction variant="glass" />
      {angle}
      {leadingAction}
      {canCreate ? (
        <GlassToolbarAction onPress={onCreate} accessibilityLabel={createAccessibilityLabel}>
          <Icon
            maxFontSizeMultiplier={1}
            name="plus"
            size={toolbarGlyphSize(24, nativeHeader ? NATIVE_ACTION_SIZE : TOP_ACTION_SIZE)}
            color={systemColors.label}
          />
        </GlassToolbarAction>
      ) : null}
    </GlassActionToolbar>
  );
}

type CollapsingNativeBarHeaderProps = Pick<
  CollapsingTopChromeProps,
  | 'canCreate'
  | 'onCreate'
  | 'createAccessibilityLabel'
  | 'onOpenBoardSwitcher'
  | 'boardPillAccessibilityHint'
  | 'climbListBarActions'
  | 'leadingAction'
  | 'trailingAction'
  | 'centerContent'
  | 'titleHidden'
  | 'scrollEdge'
  | 'onHeightChange'
  | 'children'
> & { boardBadge: boolean; hideLight: boolean; anchorBoardButton: boolean };

/**
 * The iOS 26 header. In a horizontal bar the two sides mirror each other
 * (#7281): the leading island holds the avatar and the angle ("40°"), and on an
 * iPhone the trailing group is a glass island of the same 38pt slots (history
 * and ⋯ on Climbs, the board and the bulb on Discover), so the climb capsule
 * sits centred between two matching groups. On Climbs in a compact-width bar,
 * + leaves the bar for the first row of ⋯ ("Create a climb"): the capsule needs
 * the room for a name over a byline. A regular-width iPad keeps + in the island.
 *
 * Where native UIKit items stay:
 * - On the iPhone Duo rail every action is a native item, so UIKit can move it
 *   onto the rail: account and + leading; the angle (a title item, which stays
 *   in the bar), then history and ⋯ (Climbs) or the board switcher (Discover),
 *   then the bulb, trailing. + keeps the highest visibility priority.
 * - On an iPad the trailing group stays native items: UIKit lays them out
 *   beside its sidebar button and the portrait top tab bar, which a custom
 *   island collided with. The bulb stays the glass bulb there (its long press
 *   opens Board controls; no native item has both a tap and a long press).
 *
 * The glass angle's picker is a sheet on iPhone and a popover on a
 * regular-width iPad, which needs a React view to point at. Moving between the
 * bar and the rail swaps the glass angle for the native item and would unmount
 * an open picker, so that move waits until the picker closes.
 */
function CollapsingNativeBarHeader({
  canCreate,
  onCreate,
  createAccessibilityLabel,
  onOpenBoardSwitcher,
  boardPillAccessibilityHint,
  boardBadge,
  climbListBarActions,
  hideLight,
  anchorBoardButton,
  leadingAction,
  trailingAction,
  centerContent,
  titleHidden,
  scrollEdge,
  onHeightChange,
  children,
}: CollapsingNativeBarHeaderProps) {
  const [anglePickerOpen, setAnglePickerOpen] = useState(false);
  const liveOnRail = useBarItemsOnRail();
  const [heldOnRail, setHeldOnRail] = useState(liveOnRail);
  if (!anglePickerOpen && heldOnRail !== liveOnRail) setHeldOnRail(liveOnRail);
  const onRail = anglePickerOpen ? heldOnRail : liveOnRail;
  const { isPad, widthClass } = useDeviceLayout();
  const { data: activeBoard } = useActiveBoard();
  const accountItem = useAccountRailItem();
  const { item: angleItem, picker: anglePicker } = useAngleBarItem({ onPickerOpenChange: setAnglePickerOpen });
  const boardSwitcherItem = useBoardSwitcherBarItem({
    onPress: onOpenBoardSwitcher,
    accessibilityHint: boardPillAccessibilityHint,
    badge: boardBadge,
  });
  const lightbulbItem = useLightbulbBarItem();
  const showsLight = lightbulbItem != null && !hideLight;
  const hasLeadingAction = isValidElement(leadingAction);

  // The native title item only on the rail; a horizontal bar has the glass "40°".
  const islandAngle = !onRail && angleItem != null;
  const barAngle = onRail ? angleItem : null;
  // On Climbs in a compact bar, + becomes the first row of ⋯.
  const createInMenu = climbListBarActions != null && canCreate && !onRail && widthClass === 'compact';
  const createInIsland = canCreate && !createInMenu;
  const createRow = useMemo(
    () => (createInMenu ? { label: createAccessibilityLabel, onPress: onCreate } : null),
    [createInMenu, createAccessibilityLabel, onCreate],
  );
  // An iPhone's horizontal bar: the trailing group is a glass island like the leading one.
  const trailingIsland = !onRail && !isPad;

  const leadingSlots = 1 + (islandAngle ? 1 : 0) + (hasLeadingAction ? 1 : 0) + (createInIsland ? 1 : 0);
  const leadingSide: NativeBarSide = { customSlots: leadingSlots };
  const climbListItems = useClimbListBarItems({
    onOpenHistory: climbListBarActions?.onOpenHistory ?? onOpenBoardSwitcher,
    badge: climbListBarActions?.badge ?? false,
    createRow,
  });

  const glassAngle = useMemo(() => <AngleToolbarAction onPickerOpenChange={setAnglePickerOpen} />, []);
  const glassLightbulb = useMemo(
    () => (
      <NativeHeaderActionContext.Provider value={true}>
        <GlassActionToolbar actionCount={1}>
          <LightbulbToolbarAction />
        </GlassActionToolbar>
      </NativeHeaderActionContext.Provider>
    ),
    [],
  );

  const createItem = useMemo(
    () =>
      symbolBarItem({
        label: createAccessibilityLabel,
        symbol: iconMap.plus.ios,
        onPress: onCreate,
        visibilityPriority: 'high',
        identifier: 'root.create',
      }),
    [createAccessibilityLabel, onCreate],
  );
  // On the rail only: a horizontal bar keeps the glass left island.
  const leftItems = useMemo(() => {
    if (!onRail) return undefined;
    const factory = barItemsFactory(canCreate ? [accountItem, createItem] : [accountItem]);
    // No caller passes a leading action today; kept as a custom view so nothing
    // is dropped. A custom view stays in the bar on iPhone Duo.
    if (!isValidElement(leadingAction)) return factory;
    return () => [...(factory?.() ?? []), { type: 'custom' as const, element: leadingAction }];
  }, [onRail, canCreate, accountItem, createItem, leadingAction]);

  // The iPhone's trailing island: the same glass slots as the leading one.
  const trailingIslandSlots = climbListBarActions
    ? climbListBoardActionCount(activeBoard, { showAngle: false })
    : (activeBoard ? 1 : 0) + (showsLight ? 1 : 0) + (isValidElement(trailingAction) ? 1 : 0);
  const rightActions =
    trailingIsland && trailingIslandSlots > 0 ? (
      <GlassActionToolbar actionCount={trailingIslandSlots}>
        {climbListBarActions ? (
          <ClimbListBoardActions
            onOpenHistory={climbListBarActions.onOpenHistory}
            badge={climbListBarActions.badge}
            showcaseAnchor={anchorBoardButton}
            showAngle={false}
            createRow={createRow ?? undefined}
          />
        ) : (
          <>
            {activeBoard ? (
              <BoardToolbarAction
                onPress={onOpenBoardSwitcher}
                accessibilityHint={boardPillAccessibilityHint}
                badge={boardBadge}
              />
            ) : null}
            {showsLight ? <LightbulbToolbarAction /> : null}
            {trailingAction}
          </>
        )}
      </GlassActionToolbar>
    ) : undefined;

  // Native trailing items: the rail, and an iPad's horizontal bar.
  const rightItemList = useMemo(() => {
    if (trailingIsland) return [];
    const items: RootBarItem[] = [];
    if (barAngle) items.push(barAngle);
    if (climbListBarActions) items.push(...climbListItems);
    else if (boardSwitcherItem) items.push(boardSwitcherItem);
    if (lightbulbItem && showsLight && onRail) items.push(lightbulbItem);
    return items;
  }, [
    trailingIsland,
    barAngle,
    climbListBarActions,
    climbListItems,
    boardSwitcherItem,
    lightbulbItem,
    showsLight,
    onRail,
  ]);
  // Custom views after the native items: the iPad's glass bulb, a trailing action.
  const rightCustomElements = useMemo(() => {
    if (trailingIsland) return [];
    const elements: ReactElement[] = [];
    if (showsLight && !onRail) elements.push(glassLightbulb);
    if (isValidElement(trailingAction)) elements.push(trailingAction);
    return elements;
  }, [trailingIsland, showsLight, onRail, glassLightbulb, trailingAction]);
  const rightItems = useMemo(() => {
    if (trailingIsland) return undefined;
    const factory = barItemsFactory(rightItemList);
    if (rightCustomElements.length === 0) return factory;
    const toCustomItem = (element: ReactElement) => ({ type: 'custom' as const, element });
    return () => [...(factory?.() ?? []), ...rightCustomElements.map(toCustomItem)];
  }, [trailingIsland, rightItemList, rightCustomElements]);

  // On the rail every item has left the bar, so the capsule has the whole bar.
  const centerItemSides = onRail
    ? { leading: {}, trailing: {} }
    : {
        leading: leadingSide,
        trailing: trailingIsland
          ? { customSlots: trailingIslandSlots }
          : { nativeItems: rightItemList.length + rightCustomElements.length, titleItems: 0 },
      };
  // An iPad's native history is second from the end on Climbs (⋯ is last), where
  // the showcase recorder's callout points. The iPhone island anchors its own
  // glass history; the rail logs none (the video is shot on iPhones).
  const historyAnchored =
    anchorBoardButton &&
    !onRail &&
    !trailingIsland &&
    climbListBarActions != null &&
    rightItemList.some((item) => item.identifier === BOARD_HISTORY_ITEM_ID);

  return (
    <>
      <NativeRootHeader
        leftItems={leftItems}
        leftActions={
          onRail ? undefined : (
            <LeadingIsland
              actionCount={leadingSlots}
              angle={islandAngle ? glassAngle : undefined}
              leadingAction={leadingAction}
              canCreate={createInIsland}
              onCreate={onCreate}
              createAccessibilityLabel={createAccessibilityLabel}
              nativeHeader
            />
          )
        }
        leftActionsStandalone={leadingSlots === 1}
        rightActions={rightActions}
        rightItems={rightItems}
        centerContent={centerContent}
        titleHidden={titleHidden}
        centerItemSides={centerItemSides}
        scrollEdge={scrollEdge}
        onHeightChange={onHeightChange}
      >
        {children}
      </NativeRootHeader>
      {barAngle ? anglePicker : null}
      {historyAnchored ? <NativeTrailingItemShowcaseAnchor name="board-history-button" positionFromEnd={1} /> : null}
    </>
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

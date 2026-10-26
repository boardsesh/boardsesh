// Top chrome for the climbs list. The glass action islands are shared with the
// Discover chrome via CollapsingTopChrome (`../chrome`) so both tabs read as one
// system: on the liquid-glass variant this file delegates to CollapsingTopChrome
// (left/right glass islands over the progressive blur), fills its right island
// with the climb-list board actions (angle · history · ⋯ menu) and adds the
// filter chips under it. There is no search field: the climb-name search is the
// first row of the Filters sheet, like the Logbook. On iOS the native header draws
// no title (`titleHidden`), because the tab already names the screen. The Material
// variant keeps a dedicated Appbar.Header with the board as its title, history and
// the ⋯ menu; its angle is the first chip in the filter row (FilterChipRow).

import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { Keyboard, type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Appbar, Chip } from 'react-native-paper';
import type { Grade } from '@boardsesh/shared-schema';
import type { GradeBound } from '@boardsesh/climb-filters';
import { useTheme } from '../../providers/theme-provider';
import { useFloatingHeaderControls } from '../../hooks/use-floating-header-controls';
import type { ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import { selectByVariant } from '../../theme/variants';
import { spacing } from '../../theme/tokens';
import { iconMap } from '../icon-map';
import { CollapsingTopChrome } from '../chrome';
import { useSettledHeaderValue } from '../chrome/use-settled-header-value';
import { ClimbListBoardActions, ClimbListBoardTitle, climbListBoardActionCount } from '../chrome/ClimbListBoardActions';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { GradeRangeRail, type GradeRailChange } from '../grade';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';
import { WallStatusCapsule } from '../queue-control/WallStatusCapsule';
import { BoardHeldCapsule } from '../queue-control/BoardHeldCapsule';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { useTabChrome } from '../../hooks/use-bottom-accessory';
import { useWallClimbIfDistinct } from '../queue-control/use-wall-or-queue-climb';
import { useActiveClimbUuid } from '../../providers/queue-provider';
import { addErrorBreadcrumb } from '../../lib/error-reporting';
import { FilterButton } from './FilterButton';
import { GradeFilterControl } from './GradeFilterControl';

// One 48dp baseline shared by the grade control and the filter button so the row
// reads as a matched set (M3 docked/inline height).
const MATERIAL_CONTROL_HEIGHT = 48;

type ClimbTopChromeProps = {
  /** Optional persistent plain centre title (the legacy filter summary, e.g.
   *  "V4–V6 · Quality"). Omitted when the persistent filter chips carry the filter
   *  state — the centre then reads empty (the redundant "All climbs" label is
   *  dropped). Unused by the Material variant. */
  title?: string;
  /** The board being searched, so grade labels follow its scale (MoonBoard's 6A is V2). */
  boardName?: string;
  canCreate: boolean;
  onCreate: () => void;
  onOpenBoardDetail: () => void;
  /** Show a brand-coloured dot on the board button — the one-time onboarding cue
   *  pointing a new user at the "now on the wall" sheet. */
  showBoardBadge?: boolean;
  /** Report the board button to the showcase-video recorder (screenshot mode),
   *  on both variants: the glass board glyph and the Material board switcher. */
  anchorBoardButton?: boolean;
  onHeightChange: (height: number) => void;
  /** The grade control's own toggle: hides the grade rail. */
  onCloseGrade: () => void;
  /** Closes the transient grade popover (regular-width iPad). Called when the
   *  screen loses focus, which does not hide the grade rail: that stays until the
   *  climber hides it. */
  onDismissGradePopover: () => void;
  /** Active-filter count for the Material variant's filter button, used when the
   *  persistent chip row is off. */
  activeFilterCount?: number;
  onOpenFilters?: () => void;
  /** Active-filter summary shown as a chip in the Material quick row. Tapping it
   *  clears the (non-grade) filters. Absent = no filters. */
  filterSummary?: { text: string; onClear: () => void };
  gradeBound?: GradeBound;
  grades?: readonly Grade[];
  /** Last-used grade id; centres an unselected rail on a familiar grade. */
  lastUsedGradeId?: number;
  gradeRailVisible?: boolean;
  /** Passed to the rail: a change centres it on the selection again. */
  gradeRecenterKey?: number;
  gradeChip?: { label: string; active: boolean; onClear?: () => void };
  onOpenGrade?: () => void;
  onGradeChange?: (grade: GradeBound, change: GradeRailChange) => void;
  /** Persistent native filter-chip row + token row, rendered under the header on
   *  Liquid Glass. On Material it renders under the app bar when
   *  `showPersistentChips` is set. The caller composes it so every filter handler and
   *  the search-provider state stay in the screen, not drilled through here. */
  filterChrome?: ReactNode;
  /** Android Material only: the native chip row (`filterChrome`) is the default
   *  filtering surface. When set, the Material top-chrome filter affordances (grade
   *  control, filter button, condensed summary) are suppressed and `filterChrome` is
   *  rendered under the app bar instead; the angle chip and the in-chrome grade rail
   *  stay. Always false on Liquid Glass (its own path renders `filterChrome`). */
  showPersistentChips?: boolean;
  /** Legacy native scroll-edge wiring. The filter row draws only its individual capsules. */
  scrollEdge?: ScrollEdgeBackdrop;
};

function ClimbTopChromeComponent({
  title,
  boardName,
  canCreate,
  onCreate,
  onOpenBoardDetail,
  showBoardBadge = false,
  anchorBoardButton = false,
  onHeightChange,
  onCloseGrade,
  onDismissGradePopover,
  activeFilterCount = 0,
  onOpenFilters,
  filterSummary,
  gradeBound,
  grades = [],
  lastUsedGradeId,
  gradeRailVisible = false,
  gradeRecenterKey,
  gradeChip,
  onOpenGrade,
  onGradeChange,
  filterChrome,
  showPersistentChips = false,
  scrollEdge,
}: ClimbTopChromeProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, variant } = useTheme();
  const { data: activeBoard } = useActiveBoard();
  const glassGradeRail = useFloatingHeaderControls();
  const insets = useSafeAreaInsets();
  // "On the wall" capsule: own the gate here so a falsy centre slot falls back to
  // the title, and the capsule gets a clean mount/unmount (entering/exiting fade).
  // Only present when a board feed lights a climb that differs from the user's own
  // current climb (hidden in the solo case). Settled: the capsule swaps the native
  // header out of large-title mode, which must not happen under the player's
  // dismiss animation (#6619).
  const currentClimbUuid = useActiveClimbUuid();
  const liveWallClimb = useWallClimbIfDistinct(currentClimbUuid);
  const wallClimb = useSettledHeaderValue(liveWallClimb);
  // "You have the board" takes the same slot while this climber holds the board
  // and the wall shows their own climb. Only where the iOS 26 accessory platter
  // mounts: that platter collapses on scroll and drops its bulb, while the
  // Material bar and the iOS 18 floating bar keep theirs on screen. Every input is
  // settled, like the wall capsule, so nothing in the title view changes while
  // the player covers the list (#6619).
  const { nativeAccessory } = useTabChrome();
  const { inAppBoardConnection, ledless: liveLedless, localConnected } = useBoardConnectionState();
  const boardHeld = useSettledHeaderValue(nativeAccessory && inAppBoardConnection === 'connectedByMe');
  const ledless = useSettledHeaderValue(liveLedless);
  const canOpenControls = useSettledHeaderValue(localConnected);
  const wallCapsule = useMemo(() => {
    if (wallClimb) return <WallStatusCapsule climb={wallClimb} boardName={boardName} />;
    if (boardHeld) return <BoardHeldCapsule ledless={ledless} canOpenControls={canOpenControls} />;
    return undefined;
  }, [wallClimb, boardName, boardHeld, ledless, canOpenControls]);
  const hasWallCapsule = wallClimb !== null;
  const loggedWallCapsuleRef = useRef(false);
  useEffect(() => {
    // Skip the "hidden" every Climbs mount would log; only transitions are a trail.
    if (!hasWallCapsule && !loggedWallCapsuleRef.current) return;
    loggedWallCapsuleRef.current = true;
    addErrorBreadcrumb({
      category: 'ui.header',
      message: hasWallCapsule ? 'wall capsule shown' : 'wall capsule hidden',
    });
  }, [hasWallCapsule]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );

  const handleCloseOverlays = useCallback(() => {
    Keyboard.dismiss();
    onDismissGradePopover();
  }, [onDismissGradePopover]);

  useFocusEffect(useCallback(() => () => handleCloseOverlays(), [handleCloseOverlays]));

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  const gradeRail =
    gradeRailVisible && gradeBound && onGradeChange ? (
      <GradeRangeRail
        glass={glassGradeRail}
        grades={grades}
        bound={gradeBound}
        lastUsedGradeId={lastUsedGradeId}
        boardName={boardName}
        onChange={onGradeChange}
        recenterKey={gradeRecenterKey}
      />
    ) : null;
  if (isMaterial) {
    // When the persistent chip row is the default filtering surface, the Material
    // top-chrome filter affordances (grade control, filter button, condensed summary)
    // are suppressed — the chips own filtering. The angle is the row's first chip,
    // view options live in the toolbar menu, and the Grade chip continues to open
    // the in-chrome rail.
    const showTopChromeFilters = !showPersistentChips;
    const hasGradeFilter = gradeChip?.active === true;
    const nonGradeFilterCount = Math.max(0, activeFilterCount - (hasGradeFilter ? 1 : 0));
    const hasNonGradeFilters = nonGradeFilterCount > 0;
    const shouldShowFilterSummary = showTopChromeFilters && filterSummary != null && hasNonGradeFilters;
    const visibleFilterSummary = shouldShowFilterSummary ? filterSummary : null;
    const visibleGradeLabel = gradeChip?.label ?? t('mobile.filter.grade');

    return (
      <View
        // NOT box-none: the Material band is an opaque strip and must swallow every
        // touch in its bounds. RNGH's Android hit-test (GestureHandlerOrchestrator)
        // sees straight through handler-less, background-less subtrees — box-none
        // skips its background check entirely — so list-row Gesture.Tap handlers
        // underneath steal Compose chip taps once the list has scrolled under the
        // chrome. With `auto`, the container's background makes it the RNGH touch
        // target and the full DOWN…UP reaches the Compose chips natively.
        pointerEvents="auto"
        testID="climb-material-chrome"
        style={[
          styles.materialContainer,
          {
            backgroundColor: systemColors.secondaryBackground,
            borderBottomColor: systemColors.separator,
          },
        ]}
      >
        <View pointerEvents="box-none" style={{ paddingTop: insets.top }} onLayout={handleLayout}>
          <Appbar.Header
            statusBarHeight={0}
            mode="small"
            elevated
            style={[styles.materialAppbar, { backgroundColor: systemColors.secondaryBackground }]}
          >
            <UserAvatarToolbarAction variant="material" />
            <ClimbListBoardTitle />
            {canCreate ? (
              <Appbar.Action
                icon={iconMap.plus.android}
                color={systemColors.label as string}
                onPress={onCreate}
                accessibilityLabel={t('mobile.create.fab.ariaLabel')}
              />
            ) : null}
            <ClimbListBoardActions
              material
              onOpenHistory={onOpenBoardDetail}
              badge={showBoardBadge}
              showcaseAnchor={anchorBoardButton}
            />
          </Appbar.Header>

          {/* "On the wall" status — a compact capsule in a slim centred row under the
            app bar (M3 has no centre-slot in the bar), only when a board feed lights
            a climb that differs from the user's own queue head. */}
          {wallCapsule ? (
            <View pointerEvents="box-none" style={styles.materialWallStatusRow}>
              {wallCapsule}
            </View>
          ) : null}

          {/* Inner wrappers stay box-none: once the outer `auto` container claims the
            RNGH pointer, only RN's own hit-testing runs inside, where box-none just
            means "let touches reach the controls". If an inner control ever adopts
            an RNGH gesture it needs no change — the outer container already stops
            the list's handlers from being recorded. */}
          <View pointerEvents="box-none" style={styles.materialFilterStack}>
            {showTopChromeFilters ? (
              <View pointerEvents="box-none" style={styles.materialControlRow}>
                <GradeFilterControl
                  label={visibleGradeLabel}
                  active={hasGradeFilter}
                  expanded={gradeRailVisible}
                  height={MATERIAL_CONTROL_HEIGHT}
                  onPress={() => {
                    if (gradeRailVisible) {
                      onCloseGrade();
                      return;
                    }
                    onOpenGrade?.();
                  }}
                  onClear={hasGradeFilter ? gradeChip?.onClear : undefined}
                  toggleAccessibilityLabel={t('mobile.search.gradeAction')}
                  clearAccessibilityLabel={t('mobile.gradeRail.clearFilterAria')}
                  openHint={t('mobile.search.gradeOpenHint')}
                  closeHint={t('mobile.search.gradeCloseHint')}
                />
                {onOpenFilters ? (
                  <FilterButton activeFilterCount={nonGradeFilterCount} onPress={onOpenFilters} />
                ) : null}
              </View>
            ) : null}

            {/* The persistent native chip row owns filtering when the Material
              default; it sits directly under the app bar, like Liquid Glass. */}
            {showPersistentChips ? filterChrome : null}

            {/* The quick row carries the condensed summary when the persistent
              chip row is off. The angle rides the persistent chip row above. */}
            {visibleFilterSummary ? (
              <View pointerEvents="box-none" style={styles.materialQuickRow}>
                <Chip
                  compact
                  mode="flat"
                  icon={iconMap.filter.android}
                  onPress={visibleFilterSummary.onClear}
                  onClose={visibleFilterSummary.onClear}
                  closeIcon={iconMap.close.android}
                  accessibilityLabel={visibleFilterSummary.text}
                  style={styles.materialChip}
                  textStyle={styles.materialChipText}
                >
                  {visibleFilterSummary.text}
                </Chip>
              </View>
            ) : null}
          </View>
          {/* Measure the disclosed rail with the rest of the chrome so the first
              result clears it. Keep the rail's own chip insets. */}
          {gradeRail ? <View style={styles.materialGradeRail}>{gradeRail}</View> : null}
        </View>
      </View>
    );
  }

  // Liquid-glass variant: the shared chrome (left/right glass islands over the
  // progressive blur) with the filter chips as its below-row content. The native
  // header draws no title; off it, an optional filter summary can sit in the
  // centre via `centerTitle`.
  //
  // `hideLight`: the climbs tab suppresses the toolbar BLE lightbulb. Board-LED
  // control already lives on the queue bar / current-climb pill
  // (BoardControlIndicator); a second bulb in the top-right island reads like a
  // list/filter affordance next to the filter chips and confused users. Discover
  // and the other chromes keep their bulb.
  return (
    <CollapsingTopChrome
      centerTitle={title}
      // The tab names the screen: the iOS native header draws no "Climbs" title.
      titleHidden
      // "On the wall" status — a compact capsule in the centre islands slot (where
      // the title used to sit) when a board feed lights a climb that differs from
      // the user's own current climb; otherwise undefined, so the centre falls back
      // to the title.
      centerContent={wallCapsule}
      canCreate={canCreate}
      onCreate={onCreate}
      createAccessibilityLabel={t('mobile.create.fab.ariaLabel')}
      onOpenBoardSwitcher={onOpenBoardDetail}
      boardBadge={showBoardBadge}
      anchorBoardButton={anchorBoardButton}
      boardControls={{
        content: (
          <ClimbListBoardActions
            onOpenHistory={onOpenBoardDetail}
            badge={showBoardBadge}
            showcaseAnchor={anchorBoardButton}
          />
        ),
        actionCount: climbListBoardActionCount(activeBoard),
      }}
      onHeightChange={onHeightChange}
      scrollEdge={scrollEdge}
      hideLight
    >
      {/* Persistent filter chips sit right under the header on every glass path,
          so filtering is always glanceable. */}
      {filterChrome}
      {/* The disclosed rail participates in the measured chrome height. At rest,
          even compact climb rows start below it; glass stays on each capsule. */}
      {gradeRail ? (
        <View
          testID="climb-grade-rail"
          style={[styles.gradeRail, glassGradeRail ? null : { backgroundColor: systemColors.background }]}
        >
          {gradeRail}
        </View>
      ) : null}
    </CollapsingTopChrome>
  );
}

// Memoized so a climbs-list re-render (e.g. a per-keystroke state change) skips
// the chrome when its props are unchanged. Callers must keep object/function
// props stable (the screen memoizes filterSummary + hoists its callbacks).
export const ClimbTopChrome = memo(ClimbTopChromeComponent);

const styles = StyleSheet.create({
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
  materialWallStatusRow: {
    // Full-bleed "On the wall" status band — it owns its own padding, accent rail
    // and bottom divider, so the wrapper adds no inset.
    width: '100%',
  },
  materialFilterStack: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
    gap: spacing[2],
  },
  materialControlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing[2],
  },
  materialQuickRow: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  materialChip: {
    minHeight: 32,
  },
  materialChipText: {
    fontWeight: '600',
  },
  materialGradeRail: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
  },
  gradeRail: {
    paddingBottom: spacing[2],
  },
});

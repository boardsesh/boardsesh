// Top chrome for the climbs list. The glass action islands are shared with the
// Discover chrome via CollapsingTopChrome (`../chrome`) so both tabs read as one
// system: on the liquid-glass variant this file delegates to CollapsingTopChrome
// (left/right glass islands over the progressive blur), fills its right island
// with the climb-list board actions (angle · history · ⋯ menu) and adds the
// filter chips under it. There is no search field: the climb-name search is the
// first row of the Filters sheet, like the Logbook. On iOS the native header draws
// no title (`titleHidden`), because the tab already names the screen. The Material
// variant matches it on MaterialTopAppBar: the avatar, an empty title slot that
// TalkBack still reads as "Climbs" (or the climb on the wall as a compact pill),
// then history and the ⋮ menu. Create is ⋮'s first row on a phone, + in the bar
// on a regular-width tablet. Its angle is the first chip in the filter row
// (FilterChipRow), pinned under the bar in a dense 48dp row.

import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
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
import { ClimbListBoardActions, climbListBoardActionCount } from '../chrome/ClimbListBoardActions';
import { MaterialTopAppBar } from '../chrome/MaterialTopAppBar';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { GradeRangeRail, type GradeRailChange } from '../grade';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';
import { WallStatusCapsule } from '../queue-control/WallStatusCapsule';
import { BoardHeldCapsule } from '../queue-control/BoardHeldCapsule';
import { useOwedDropAnnouncement } from '../queue-control/bar-bulb-tap';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { useTabChrome } from '../../hooks/use-bottom-accessory';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { useLiveWallClimb } from '../queue-control/use-wall-or-queue-climb';
import { trustedWallCapsuleClimb, usePresenceFresh } from '../../lib/board-presence/presence-freshness';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import {
  dismissWallCapsule,
  useWallCapsuleDismissal,
  wallCapsuleOccurrenceKey,
} from '../../lib/wall-capsule-dismissal-store';
import { useWallCapsuleHistoryAge } from '../queue-control/use-wall-capsule-history-age';
import { resolveClimbsHeaderCapsule, type TrustedWallClimb } from './climbs-header-capsule';
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
  const { t: tCommon } = useTranslation('common');
  const { systemColors, variant } = useTheme();
  const { data: activeBoard } = useActiveBoard();
  const glassGradeRail = useFloatingHeaderControls();
  // The centre slot: the climb on the wall, the "You have the board" capsule, or
  // nothing (`resolveClimbsHeaderCapsule`). Owned here so a falsy slot falls back
  // to the title and the capsule gets a clean mount/unmount. The climb on the
  // wall shows whenever presence trusts it (lit under an hour ago, or a live link
  // says it is lit), whatever the queue, the link or the layout, until the
  // climber hides it. Settled: the capsule swaps the native header out of
  // large-title mode, which must not happen under the player's dismiss
  // animation (#6619).
  const queueHeadUuid = useActiveClimbUuid();
  const wallClimb = useLiveWallClimb();
  const { inAppBoardConnection, ledless: liveLedless, localConnected } = useBoardConnectionState();
  // The pill's tap during a drive can let go of the board (Disconnect Bluetooth
  // when driving ends), and the pill goes with the hold: this header says it.
  useOwedDropAnnouncement(localConnected);
  // Presence follows the board the Climbs list shows (the drawer host binds it
  // to the selected board), so this is that board's wall.
  const { boardId } = useBoardPresenceControls();
  const linked = inAppBoardConnection !== 'disconnected';
  // Hidden past an hour with no live link (#7095): the same trust rule as the player.
  const wallPresenceFresh = usePresenceFresh(wallClimb?.sentAt ?? null);
  const liveWallClimb = trustedWallCapsuleClimb(wallClimb, {
    linked,
    presenceFresh: wallPresenceFresh,
  });
  const occurrenceKey =
    boardId !== null && liveWallClimb !== null ? wallCapsuleOccurrenceKey(boardId, liveWallClimb) : null;
  const trustedWall = useMemo<TrustedWallClimb | null>(
    () =>
      liveWallClimb !== null && boardId !== null && occurrenceKey !== null
        ? { climb: liveWallClimb, boardId, occurrenceKey }
        : null,
    [liveWallClimb, boardId, occurrenceKey],
  );
  // Reads the raw wall climb, trusted or not: a different climb on the wall ends
  // the board's Hide even past the hour.
  const { loaded: dismissalLoaded, dismissed, hiddenClimbUuid } = useWallCapsuleDismissal(boardId, wallClimb);
  const historyAge = useWallCapsuleHistoryAge(
    liveWallClimb?.sentAt ?? null,
    !linked && dismissalLoaded && !dismissed && liveWallClimb !== null,
  );
  // Strings, not the hook's fresh object, so the memo below holds between ticks.
  const historyAgeLabel = historyAge?.label ?? '';
  const historyAgeByline = historyAge?.byline ?? '';
  // "You have the board" is the slot's skin while this climber holds the board,
  // only where the iOS 26 accessory platter mounts on iPhone: that platter
  // collapses on scroll and drops its bulb, while the Material bar and the iOS
  // 18 floating bar keep theirs on screen. A regular-width iPad has no bottom
  // tab bar for the platter to collapse into, so its bulb stays in view; an iPad
  // in a narrow Split View has the phone's bottom bar and keeps the cue. Where
  // the cue is off, the climb on the wall still shows, as the wall capsule.
  const { nativeAccessory } = useTabChrome();
  const { isPad, widthClass } = useDeviceLayout();
  const accessoryCollapses = !(isPad && widthClass === 'regular');
  const heldCue = nativeAccessory && accessoryCollapses && inAppBoardConnection === 'connectedByMe';
  // Booleans, not the queue head's uuid, so a queue change that alters neither
  // (a crew advancing, the MiniPlayer moving) builds no new capsule and leaves
  // the native header's options alone. Only the held cue reads the queue head.
  const wallIsQueueHead = heldCue && queueHeadUuid !== null && liveWallClimb?.climbUuid === queueHeadUuid;
  const queueHeadHidden = heldCue && queueHeadUuid !== null && hiddenClimbUuid === queueHeadUuid;
  // Keep the climb, its meaning and its dismissal scope together while a modal
  // covers the list. None may change the native title during player dismissal.
  const liveHeaderCapsule = useMemo(() => {
    const capsule = resolveClimbsHeaderCapsule({
      wall: trustedWall,
      dismissal: { loaded: dismissalLoaded, dismissed },
      heldCue,
      wallIsQueueHead,
      queueHeadHidden,
    });
    if (capsule === null || capsule.kind === 'held') return capsule;
    return {
      ...capsule,
      presentation: linked
        ? { kind: 'live' as const }
        : { kind: 'history' as const, ageLabel: historyAgeLabel, ageByline: historyAgeByline },
    };
  }, [
    trustedWall,
    dismissalLoaded,
    dismissed,
    heldCue,
    wallIsQueueHead,
    queueHeadHidden,
    linked,
    historyAgeLabel,
    historyAgeByline,
  ]);
  const headerCapsule = useSettledHeaderValue(liveHeaderCapsule);
  const settledWall = headerCapsule?.wall ?? null;
  const handleDismissWallCapsule = useCallback(
    (dismissedOccurrence: string) => {
      if (settledWall === null || dismissedOccurrence !== settledWall.occurrenceKey) return;
      dismissWallCapsule(settledWall.boardId, settledWall.climb);
    },
    [settledWall],
  );
  const ledless = useSettledHeaderValue(liveLedless);
  const wallCapsule = useMemo(() => {
    if (headerCapsule === null) return undefined;
    if (headerCapsule.kind === 'held') {
      return (
        <BoardHeldCapsule
          ledless={ledless}
          dismiss={
            headerCapsule.wall
              ? { occurrenceKey: headerCapsule.wall.occurrenceKey, onDismiss: handleDismissWallCapsule }
              : undefined
          }
        />
      );
    }
    return (
      <WallStatusCapsule
        climb={headerCapsule.wall.climb}
        boardName={boardName}
        presentation={headerCapsule.presentation}
        occurrenceKey={headerCapsule.wall.occurrenceKey}
        onDismiss={handleDismissWallCapsule}
      />
    );
  }, [headerCapsule, boardName, handleDismissWallCapsule, ledless]);
  // The climb on the wall is in the header, in either skin.
  const hasWallCapsule = settledWall !== null;
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

  // The same history and ⋯ actions for the iOS 26 header: the iPhone's trailing
  // glass island, or native items on iPad and the Duo rail.
  const climbListBarActions = useMemo(
    () => ({ onOpenHistory: onOpenBoardDetail, badge: showBoardBadge }),
    [onOpenBoardDetail, showBoardBadge],
  );

  const handleCloseOverlays = useCallback(() => {
    Keyboard.dismiss();
    onDismissGradePopover();
  }, [onDismissGradePopover]);

  useFocusEffect(useCallback(() => () => handleCloseOverlays(), [handleCloseOverlays]));

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  // Material, as on iOS (CollapsingTopChrome): on a compact width + leaves the
  // bar for ⋮'s first row; a regular-width tablet keeps it in the bar.
  const materialCreateInMenu = isMaterial && canCreate && widthClass === 'compact';
  const createLabel = t('mobile.create.fab.ariaLabel');
  const materialCreateRow = useMemo(
    () => (materialCreateInMenu ? { label: createLabel, onPress: onCreate } : undefined),
    [materialCreateInMenu, createLabel, onCreate],
  );
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
    const persistentChips = showPersistentChips ? filterChrome : null;

    return (
      <MaterialTopAppBar
        testID="climb-material-chrome"
        onHeightChange={onHeightChange}
        scrollEdge={scrollEdge}
        below={
          <>
            {/* Inner wrappers stay box-none: once the outer `auto` container claims the
            RNGH pointer, only RN's own hit-testing runs inside, where box-none just
            means "let touches reach the controls". If an inner control ever adopts
            an RNGH gesture it needs no change — the outer container already stops
            the list's handlers from being recorded. The stack (and its padding)
            renders only while it holds the legacy controls or the summary chip. */}
            {showTopChromeFilters || visibleFilterSummary ? (
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

                {/* The quick row carries the condensed summary when the persistent
                chip row is off. The angle rides the persistent chip row instead. */}
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
            ) : null}
            {/* The persistent chip row runs full-bleed under the app bar, always
              pinned: its own 16dp content inset is the gutter, and chips scroll to
              the screen edge. The screen builds it dense, so Compose's 48dp chip
              targets are the row's only vertical space. */}
            {persistentChips ? (
              <View pointerEvents="box-none" style={styles.materialChipRow}>
                {persistentChips}
              </View>
            ) : null}
            {/* Measure the disclosed rail with the rest of the chrome so the first
              result clears it. Its own content inset is the gutter too. */}
            {gradeRail ? <View style={styles.materialGradeRail}>{gradeRail}</View> : null}
          </>
        }
      >
        <UserAvatarToolbarAction variant="material" />
        {/* The title slot, empty as on iOS: the tab names the screen and ⋮ switches
          boards. The climb on the wall sits in it as a compact pill while presence
          trusts it. TalkBack reads the screen's name from the header under it in
          either state; the header fills the slot (a zero-size node has no bounds,
          and TalkBack skips those) and takes no touches, so the pill stays on top. */}
        <View pointerEvents="box-none" style={styles.materialTitleSlot}>
          <View
            accessible
            accessibilityRole="header"
            accessibilityLabel={tCommon('mobile.nav.climbs')}
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
          />
          {wallCapsule}
        </View>
        {canCreate && !materialCreateInMenu ? (
          <Appbar.Action
            icon={iconMap.plus.android}
            color={systemColors.label as string}
            onPress={onCreate}
            accessibilityLabel={createLabel}
          />
        ) : null}
        <ClimbListBoardActions
          material
          onOpenHistory={onOpenBoardDetail}
          badge={showBoardBadge}
          showcaseAnchor={anchorBoardButton}
          createRow={materialCreateRow}
        />
      </MaterialTopAppBar>
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
      materialTitle={tCommon('mobile.nav.climbs')}
      centerTitle={title}
      // The tab names the screen: the iOS native header draws no "Climbs" title.
      titleHidden
      // "On the wall" status — a compact capsule in the centre islands slot (where
      // the title used to sit) while the wall's climb is trusted and not hidden, or
      // "You have the board"; otherwise undefined, so the centre falls back to the
      // title.
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
      climbListBarActions={climbListBarActions}
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
  // Between the avatar and the actions: the wall pill centred in it (capped at
  // 280dp by the pill), or the empty header.
  materialTitleSlot: {
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: spacing[1],
  },
  materialFilterStack: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
    gap: spacing[2],
  },
  materialChipRow: {
    // `filterChrome` is a fragment (chip row + sheet-only filter tokens). The
    // dense chip row is 48dp of touch targets with 8dp visible above and below
    // each chip, so nothing pads under it.
    paddingBottom: 0,
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
    paddingBottom: spacing[3],
  },
  gradeRail: {
    paddingBottom: spacing[2],
  },
});

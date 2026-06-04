// The bottom toolbar's search affordance (Climbs tab only): a collapsed glass FAB
// pinned bottom-LEFT — into the gutter the global capsule + tick reserve — that
// speed-dials open to its RIGHT into a single row: [🔍/✕] [search field] [grade]
// [filter]. The FAB morphs 🔍→✕ and stays put; the row rides above the keyboard
// (useAnimatedKeyboard on iOS) so the field stays usable. While expanded it
// signals `setSearchExpanded`, so the global capsule + tick fade out and the
// field has the full width. Tapping the scrim or ✕ collapses; while typing the
// grade/filter swap for a "done" ✓. Collapsed, the FAB carries a filter-count
// badge. Controls are individual glass elements over the list (no glass-on-glass).

import { type RefObject, useCallback, useEffect, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedKeyboard,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useFocusEffect } from 'expo-router';
import type { Grade } from '@boardsesh/shared-schema';
import { type ClimbBoardFilterState, type GradeBound } from '@boardsesh/climb-filters';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { TOOLBAR_FAB_SIZE, TOOLBAR_SIDE_MARGIN } from '../../theme/layout';
import { hapticLight, hapticSelection } from '../../lib/haptics';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { setSearchExpanded } from '../../lib/search-expanded-state';
import type { ClimbFilters } from '../../lib/climb-filter-types';
import { SearchHeader, type SearchHeaderHandle } from '../SearchHeader';
import { GlassIconButton } from '../GlassIconButton';
import { Text } from '../Text';
import { GradePill } from './GradePill';
import { FilterButton } from './FilterButton';
import { ActiveFilterChips } from './ActiveFilterChips';

type SearchFabProps = {
  searchFieldRef: RefObject<SearchHeaderHandle | null>;
  searchInitialValue: string;
  searchPlaceholder: string;
  onSearchChange: (text: string) => void;
  /** Commit the current text immediately (flush the debounce) — fired by "done". */
  onSearchSubmit: (text: string) => void;
  onSearchFocus: () => void;
  onSearchBlur: () => void;
  bound: GradeBound;
  grades: readonly Grade[];
  filters: ClimbFilters;
  boardFilters: ClimbBoardFilterState;
  count: number | undefined;
  activeFilterCount: number;
  onOpenGrade: () => void;
  onOpenFilters: () => void;
  onPatchFilters: (patch: Partial<ClimbFilters>) => void;
  onPatchBoardFilters: (patch: Partial<ClimbBoardFilterState>) => void;
  /** Resting bottom for the cluster (clears the tab bar + floating toolbar). */
  toolbarBottom: number;
};

export function SearchFab({
  searchFieldRef,
  searchInitialValue,
  searchPlaceholder,
  onSearchChange,
  onSearchSubmit,
  onSearchFocus,
  onSearchBlur,
  bound,
  grades,
  filters,
  boardFilters,
  count,
  activeFilterCount,
  onOpenGrade,
  onOpenFilters,
  onPatchFilters,
  onPatchBoardFilters,
  toolbarBottom,
}: SearchFabProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const reduceMotion = useReduceMotion();
  const keyboard = useAnimatedKeyboard();
  const [expanded, setExpanded] = useState(false);
  // While the field is focused (actively typing) we swap grade/filter for a
  // "done typing" tick that dismisses the keyboard and commits the live search.
  const [focused, setFocused] = useState(false);

  // The cluster's bottom slides with the toolbar (toolbarBottom) and rises above
  // the keyboard when the field focuses. `useAnimatedKeyboard` reports the IME
  // height on BOTH platforms (0 when closed), which matters on Android: this app
  // runs edge-to-edge, so the window doesn't resize and a bottom-anchored cluster
  // wouldn't otherwise clear the keyboard. The fab sits at the cluster's bottom-left.
  const restingBottom = useSharedValue(toolbarBottom);
  useEffect(() => {
    restingBottom.value = reduceMotion ? toolbarBottom : withTiming(toolbarBottom, { duration: 200 });
  }, [toolbarBottom, reduceMotion, restingBottom]);

  const clusterStyle = useAnimatedStyle(() => {
    return { bottom: Math.max(restingBottom.value, keyboard.height.value + spacing[2]) };
  });

  const handleCollapse = useCallback(() => {
    searchFieldRef.current?.blur();
    Keyboard.dismiss();
    setExpanded(false);
    setSearchExpanded(false);
  }, [searchFieldRef]);

  // The tabs stay mounted across switches, so an unmount cleanup never fires on a
  // tab change. Collapse on blur instead — fully resetting local + global state —
  // so leaving the Climbs tab mid-search makes the global capsule + tick reappear
  // on the other tabs, and returning never lands on a half-open search. This also
  // covers unmount-while-focused (e.g. switching search layouts).
  useFocusEffect(useCallback(() => () => handleCollapse(), [handleCollapse]));

  const handleFabPress = useCallback(() => {
    hapticLight();
    if (expanded) {
      handleCollapse();
    } else {
      setExpanded(true);
      setSearchExpanded(true);
    }
  }, [expanded, handleCollapse]);

  const handleFocus = useCallback(() => {
    setFocused(true);
    onSearchFocus();
  }, [onSearchFocus]);

  const handleBlur = useCallback(() => {
    setFocused(false);
    onSearchBlur();
  }, [onSearchBlur]);

  // "Finished typing": commit the current text immediately (flush the debounce),
  // drop the keyboard, and shrink the field back to its small state with
  // grade/filter beside it. We flip `focused` here directly rather than waiting
  // on the blur→onBlur round-trip, so the row reflows immediately on tap.
  const handleDone = useCallback(() => {
    setFocused(false);
    hapticSelection();
    onSearchSubmit(searchFieldRef.current?.getText() ?? '');
    searchFieldRef.current?.blur();
    Keyboard.dismiss();
  }, [searchFieldRef, onSearchSubmit]);

  const enter = reduceMotion ? undefined : FadeIn.duration(200);
  const exit = reduceMotion ? undefined : FadeOut.duration(150);
  const showMetadataRow = expanded && !focused && (count != null || activeFilterCount > 0);

  return (
    <>
      {expanded ? (
        <Pressable
          style={styles.scrim}
          onPress={handleCollapse}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : null}

      <Animated.View pointerEvents="box-none" style={[styles.cluster, clusterStyle]}>
        {showMetadataRow ? (
          <Animated.View entering={enter} exiting={exit} style={styles.metadataRow}>
            {count != null ? (
              <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.countText}>
                {t('mobile.search.climbsCount', { count })}
              </Text>
            ) : null}
            <ActiveFilterChips
              filters={filters}
              boardFilters={boardFilters}
              onPatchFilters={onPatchFilters}
              onPatchBoardFilters={onPatchBoardFilters}
              chipHeight={32}
              style={styles.chips}
              contentContainerStyle={styles.chipsContent}
            />
          </Animated.View>
        ) : null}
        <View pointerEvents="box-none" style={styles.fabRow}>
          {/* The FAB is pinned LEFT and morphs 🔍→✕; everything speed-dials to its
              right. Collapsed, it carries the active-filter count as a badge. */}
          <GlassIconButton
            iconName="search"
            secondaryIconName="close"
            active={expanded}
            iconColor={systemColors.label as string}
            fallbackColor={systemColors.fill}
            onPress={handleFabPress}
            accessibilityLabel={expanded ? t('mobile.search.fab.close') : t('mobile.search.fab.open')}
            accessibilityHint={expanded ? undefined : t('mobile.search.fab.hint')}
            badgeCount={expanded ? undefined : activeFilterCount}
            size={TOOLBAR_FAB_SIZE}
          />
          {expanded ? (
            <Animated.View entering={enter} exiting={exit} style={styles.searchSlot}>
              <SearchHeader
                ref={searchFieldRef}
                initialValue={searchInitialValue}
                placeholder={searchPlaceholder}
                onChangeText={onSearchChange}
                onFocus={handleFocus}
                onBlur={handleBlur}
                height={TOOLBAR_FAB_SIZE}
              />
            </Animated.View>
          ) : null}
          {expanded && !focused ? (
            <Animated.View entering={enter} exiting={exit}>
              <GradePill bound={bound} grades={grades} onPress={onOpenGrade} maxWidth={140} />
            </Animated.View>
          ) : null}
          {expanded && !focused ? (
            <Animated.View entering={enter} exiting={exit}>
              <FilterButton activeFilterCount={activeFilterCount} onPress={onOpenFilters} />
            </Animated.View>
          ) : null}
          {expanded && focused ? (
            <Animated.View entering={enter} exiting={exit}>
              <GlassIconButton
                iconName="tick"
                iconColor={systemColors.label as string}
                fallbackColor={systemColors.fill}
                onPress={handleDone}
                accessibilityLabel={t('mobile.search.fab.done')}
                size={TOOLBAR_FAB_SIZE}
              />
            </Animated.View>
          ) : null}
        </View>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 18,
  },
  cluster: {
    position: 'absolute',
    left: TOOLBAR_SIDE_MARGIN,
    right: TOOLBAR_SIDE_MARGIN,
    zIndex: 19,
  },
  metadataRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    marginBottom: spacing[2],
    marginLeft: TOOLBAR_FAB_SIZE + spacing[2],
  },
  countText: {
    flexShrink: 0,
  },
  chips: {
    flex: 1,
  },
  chipsContent: {
    paddingRight: spacing[2],
  },
  searchSlot: {
    flex: 1,
    flexDirection: 'row',
  },
  fabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: spacing[2],
  },
});

// The climbs list's quick-filter capsules: turns FilterChipRow's props into the
// CapsuleRow descriptors, in the row's fixed order. Pure (no React, no native
// imports), so the order, labels, active states and visibility rules are locked
// by a unit test instead of three hand-written platform trees.
//
// Order: Filters · N, then the pinnable chips in catalog order
// (lib/pinnable-chips.ts): Recent, Grade, Grade accuracy, Your progress,
// Collection, Climb type, Tall, Wide, Beta videos, Popularity, Min rating, Sort.
//   • Recent shows only while pinned (the default) and there are saved
//     searches. Unpinning it hides the chip, never the searches.
//   • Your progress hides when signed out (`canFilterProgress`); its pin persists.
//   • Tall / Wide show only on board sizes that have them (`dimensionChips`) and
//     only while pinned. Their long-press Lock / Unlock is iOS-only (CapsuleRow
//     draws a plain toggle elsewhere; the rules are in lib/dimension-chips.ts).
// Labels reuse the filter sheet's i18n keys (FilterChipRow.logic) so a filter is
// never worded two ways.

import type { TFunction } from 'i18next';
import { PROGRESS_FILTER_VALUES, SORT_OPTIONS, GRADE_ACCURACY_VALUES } from '@boardsesh/climb-filters';
import { applyRecentFilterById, findCurrentRecentFilter } from '../../lib/recent-filter-selection';
import {
  POPULARITY_BUCKETS,
  popularityTag,
  popularityFromTag,
  RATING_BUCKETS,
  ratingTag,
  ratingFromTag,
} from '../../lib/filter-chip-menus';
import { buildSortLabel } from '../../lib/filter-labels';
import { visibleCollectionValues } from '../../lib/collection-filter';
import type { Capsule, CapsuleOption } from '../filter-capsules/CapsuleRow.types';
import {
  accuracyChipLabel,
  climbTypeChipLabel,
  collectionChipLabel,
  isAccuracyTag,
  isClimbType,
  isCollectionFilter,
  isProgressFilter,
  isSortOption,
  popularityChipLabel,
  progressFilterLabel,
  ratingChipLabel,
} from './FilterChipRow.logic';
import type { FilterChipRowProps } from './FilterChipRow.types';

const CLIMB_TYPE_VALUES = ['boulders', 'routes', 'both'] as const;

/** Builds the climbs capsule row. Memoise the call on the props it reads. */
export function buildClimbCapsules(props: FilterChipRowProps, t: TFunction<'climbs'>): Capsule[] {
  const {
    pinnedChips,
    activeFilterCount,
    onOpenFilters,
    recentFilters,
    currentFilters,
    currentSearchText,
    onApplyRecent,
    onClearRecent,
    gradeLabel,
    gradeActive,
    onOpenGrade,
    gradeRailOpen,
    onCloseGrade,
    gradePopoverContent,
    dimensionChips,
    minAscents,
    onChangePopularity,
    minRating,
    onChangeRating,
    progress,
    onChangeProgress,
    canFilterProgress,
    collection,
    onChangeCollection,
    canFilterPersonalCollections,
    isSprayWall,
    sortBy,
    sortActive,
    onChangeSort,
    accuracyValue,
    onChangeAccuracy,
    climbType,
    onChangeClimbType,
    betaActive,
    onToggleBeta,
  } = props;
  const isPinned = (kind: (typeof pinnedChips)[number]) => pinnedChips.includes(kind);
  const capsules: Capsule[] = [];

  // The compact icon/count control retains its full localised spoken label.
  const filtersLabel =
    activeFilterCount > 0
      ? t('mobile.search.chips.filtersWithCount', { count: activeFilterCount })
      : t('mobile.filter.title');
  capsules.push({
    kind: 'sheet',
    key: 'filters',
    label: filtersLabel,
    accessibilityLabel: filtersLabel,
    presentation: 'iconBadge',
    count: activeFilterCount,
    icon: 'filters',
    onPress: onOpenFilters,
  });

  // Recent ▾: shown while pinned and there are saved searches. Each one is
  // something to apply, so a tap re-applies even the checked (current) one.
  if (isPinned('recent') && recentFilters.length > 0) {
    const current = findCurrentRecentFilter(recentFilters, currentFilters, currentSearchText);
    capsules.push({
      kind: 'menu',
      key: 'recent',
      label: t('mobile.search.recentFilters'),
      active: false,
      icon: 'recent',
      optionStyle: 'commands',
      options: recentFilters.map((recent) => ({ value: recent.id, label: recent.label })),
      selected: current?.id,
      onSelect: (id) => applyRecentFilterById(recentFilters, id, onApplyRecent),
      actions: [
        { key: 'clear', label: t('mobile.search.clearRecentSearches'), destructive: true, onPress: onClearRecent },
      ],
    });
  }

  // Grade → shows and hides the range rail (a popover on regular-width iPad).
  if (isPinned('grade')) {
    capsules.push({
      kind: 'rail',
      key: 'grade',
      label: gradeLabel,
      active: gradeActive,
      expanded: gradeRailOpen,
      onPress: gradeRailOpen ? onCloseGrade : onOpenGrade,
      accessibilityHint: gradeRailOpen ? t('mobile.search.gradeCloseHint') : t('mobile.search.gradeOpenHint'),
      popover: gradePopoverContent ? { content: gradePopoverContent, onDismiss: onCloseGrade } : undefined,
    });
  }

  // Grade accuracy ▾: Off / Loose / Moderate / Tight; 'off' tags the neutral '0'.
  if (isPinned('accuracy')) {
    capsules.push({
      kind: 'menu',
      key: 'accuracy',
      label: accuracyValue === 'off' ? t('mobile.filter.accuracy.label') : accuracyChipLabel(accuracyValue, t),
      active: accuracyValue !== 'off',
      options: GRADE_ACCURACY_VALUES.map((value) => ({
        value: value === '0' ? 'off' : value,
        label: accuracyChipLabel(value, t),
      })),
      selected: accuracyValue,
      onSelect: (value) => {
        if (isAccuracyTag(value)) onChangeAccuracy(value);
      },
    });
  }

  // Your progress ▾: auth-gated. Resting label is the dimension name.
  if (canFilterProgress && isPinned('progress')) {
    capsules.push({
      kind: 'menu',
      key: 'progress',
      label: progress === 'all' ? t('mobile.filter.progress.label') : progressFilterLabel(progress, t),
      active: progress !== 'all',
      options: PROGRESS_FILTER_VALUES.map((value) => ({ value, label: progressFilterLabel(value, t) })),
      selected: progress,
      onSelect: (value) => {
        if (isProgressFilter(value)) onChangeProgress(value);
      },
    });
  }

  // Collection ▾: Any / Benchmarks / My drafts / Liked (personal collections
  // auth-gated, benchmarks hidden on a spray wall unless already active).
  if (isPinned('collection')) {
    capsules.push({
      kind: 'menu',
      key: 'collection',
      label: collection === 'any' ? t('mobile.filter.collection.label') : collectionChipLabel(collection, t),
      active: collection !== 'any',
      options: visibleCollectionValues({ canFilterPersonalCollections, isSprayWall, current: collection }).map(
        (value) => ({ value, label: collectionChipLabel(value, t) }),
      ),
      selected: collection,
      onSelect: (value) => {
        if (isCollectionFilter(value)) onChangeCollection(value);
      },
    });
  }

  // Climb type ▾: boulders-only is the default, so it rests as "Climb type".
  if (isPinned('climbType')) {
    capsules.push({
      kind: 'menu',
      key: 'climbType',
      label: climbType === 'boulders' ? t('mobile.filter.climbType.label') : climbTypeChipLabel(climbType, t),
      active: climbType !== 'boulders',
      options: CLIMB_TYPE_VALUES.map((value) => ({ value, label: climbTypeChipLabel(value, t) })),
      selected: climbType,
      onSelect: (value) => {
        if (isClimbType(value)) onChangeClimbType(value);
      },
    });
  }

  // Tall / Wide: tap toggles; the iOS long-press offers Lock / Unlock. A locked
  // chip shows a lock and ignores tap until unlocked (lib/dimension-chips.ts).
  for (const dimension of dimensionChips) {
    if (!isPinned(dimension.key)) continue;
    capsules.push({
      kind: 'toggleMenu',
      key: dimension.key,
      label: dimension.key === 'tall' ? t('mobile.search.chips.tall') : t('mobile.search.chips.wide'),
      active: dimension.active,
      icon: dimension.locked ? 'locked' : undefined,
      onPress: dimension.onToggle,
      actions: [
        {
          key: 'lock',
          label: dimension.locked ? t('mobile.search.chips.unlock') : t('mobile.search.chips.lock'),
          icon: dimension.locked ? 'unlock' : 'lock',
          onPress: dimension.onToggleLock,
        },
      ],
    });
  }

  // Beta videos: a plain on/off toggle.
  if (isPinned('beta')) {
    capsules.push({
      kind: 'toggle',
      key: 'beta',
      label: t('mobile.filter.betaVideos'),
      active: betaActive,
      onPress: onToggleBeta,
    });
  }

  // Popularity ▾: min-ascents buckets (the conflict-clear is upstream).
  if (isPinned('popularity')) {
    capsules.push({
      kind: 'menu',
      key: 'popularity',
      label: minAscents != null ? popularityChipLabel(minAscents, t) : t('mobile.filter.popularity'),
      active: minAscents != null,
      options: POPULARITY_BUCKETS.map((bucket): CapsuleOption => ({
        value: popularityTag(bucket),
        label: popularityChipLabel(bucket, t),
      })),
      selected: popularityTag(minAscents),
      onSelect: (value) => onChangePopularity(popularityFromTag(value)),
    });
  }

  // Min rating ▾: star buckets.
  if (isPinned('rating')) {
    capsules.push({
      kind: 'menu',
      key: 'rating',
      label: minRating != null ? ratingChipLabel(minRating, t) : t('mobile.filter.minRating'),
      active: minRating != null,
      options: RATING_BUCKETS.map((bucket): CapsuleOption => ({
        value: ratingTag(bucket),
        label: ratingChipLabel(bucket, t),
      })),
      selected: ratingTag(minRating),
      onSelect: (value) => onChangeRating(ratingFromTag(value)),
    });
  }

  // Sort ▾: the sort key only (direction stays in the sheet). Picking Random
  // reseeds a fresh shuffle. Sits last.
  if (isPinned('sort')) {
    const sortLabelFor = buildSortLabel(t);
    capsules.push({
      kind: 'menu',
      key: 'sort',
      label: sortActive ? (sortLabelFor(sortBy) ?? sortBy) : t('mobile.filter.sortBy'),
      active: sortActive,
      options: SORT_OPTIONS.map((value) => ({ value, label: sortLabelFor(value) ?? value })),
      selected: sortBy,
      onSelect: (value) => {
        if (isSortOption(value)) onChangeSort(value);
      },
    });
  }

  return capsules;
}

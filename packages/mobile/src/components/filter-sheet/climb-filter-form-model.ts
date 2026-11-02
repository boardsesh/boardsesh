// The rows of the iOS Filters form (ClimbFilterForm.ios, #6872), built from the
// state and handlers ClimbFilterSheet already owns. Pure: the sheet decides what
// shows and what each control does; this only lays the same controls out as
// settings rows, in the same order as the RN sheet's sections.
//
// A Form row has no room for a label row above its control, so each control's
// label moves onto the row itself (a menu Picker's label, a Toggle's title) and
// the descriptions that explain a section's last control become its footer. The
// pins leave the sheet: the last row opens Settings › Quick filters, where the
// chips are switched on and ordered.

import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import {
  SORT_OPTIONS,
  type ClimbTypeFilter,
  type GradeAccuracyValue,
  type ProgressFilter,
  type SortOption,
  type SortOrder,
  type StatusFilter,
} from '@boardsesh/climb-filters';
import { formatMinAscentsFilterCount } from '@boardsesh/climb-filters';
import type { ClimbFilters } from '../../lib/climb-filter-types';
import type { CollectionFilter } from '../../lib/collection-filter';
import type { RecentFilter } from '../../lib/recent-filter-store';
import type { MoreOption, MoreRow } from '../MoreForm.types';
import type { SegmentOption } from '../SegmentedControl.types';
import type { ClimbFilterFormModel, ClimbFilterFormRow, ClimbFilterFormSection } from '../ClimbFilterForm.types';

/** The Popularity menu: Unrepeated, then Any and the min-ascents buckets. */
const POPULARITY_KEYS = ['any', 'projects', '2', '10', '100', '1000'] as const;
const STAR_VALUES = [1, 2, 3, 4, 5] as const;
const ANY = 'any';

/** The three rows that push a picker route. */
type FilterPickerRowKey = 'setters' | 'holds' | 'zone';

type PickerRowInput = {
  show: boolean;
  /** No board to pick against: the row is left out (the RN sheet greys it). */
  disabled: boolean;
  value: string;
  onPress: () => void;
};

type SortInput =
  | {
      kind: 'climbs';
      sortBy: SortOption;
      sortOrder: SortOrder;
      labels: Record<SortOption, string>;
      orderOptions: MoreOption[];
      onSortBy: (sortBy: SortOption) => void;
      onSortOrder: (order: string) => void;
      onReshuffle: () => void;
    }
  | {
      kind: 'list';
      options: readonly { key: string; label: string }[];
      selected: string;
      orderOptions: SegmentOption<SortOrder>[] | null;
      order: SortOrder;
      showReshuffle: boolean;
      onSelect: (key: string) => void;
      onOrderChange: (order: SortOrder) => void;
      onReshuffle: () => void;
    };

export type ClimbFilterFormInput = {
  t: TFunction<'climbs'>;
  filters: ClimbFilters;
  isAuthenticated: boolean;
  name: {
    value: string;
    placeholder: string;
    clearLabel: string;
    onChangeText: (text: string) => void;
    onClear: () => void;
    onFocus: () => void;
  };
  /** Null hides Recent (a playlist). */
  recent: { items: readonly RecentFilter[]; currentId: string | undefined; onSelect: (id: string) => void } | null;
  grade: { rail: ReactNode; height: number };
  accuracy: {
    options: { key: GradeAccuracyValue | 'off'; label: string }[];
    onSelect: (key: GradeAccuracyValue | 'off') => void;
  };
  /** Null hides Your progress (signed out, or a list without it). */
  progress: {
    labels: Record<ProgressFilter, string>;
    selected: ProgressFilter;
    onSelect: (progress: ProgressFilter) => void;
    showMyRating: boolean;
  } | null;
  collection: {
    options: { key: CollectionFilter; label: string }[];
    selected: CollectionFilter;
    onSelect: (key: CollectionFilter) => void;
  };
  popularity: { onStatusChange: (status: StatusFilter) => void; onBucket: (bucket: number | undefined) => void };
  climbType: {
    show: boolean;
    options: SegmentOption<ClimbTypeFilter>[];
    selected: ClimbTypeFilter;
    onSelect: (key: ClimbTypeFilter) => void;
  };
  showOtherAngles: boolean;
  tall: { show: boolean; locked: boolean };
  wide: { show: boolean; locked: boolean };
  showFollowing: boolean;
  showBeta: boolean;
  boardFit: { value: boolean; onChange: (value: boolean) => void } | null;
  pickers: Record<FilterPickerRowKey, PickerRowInput>;
  sort: SortInput;
  /** The last row: opens the Quick filters settings screen. */
  quickFilters: { label: string; footer: string; onPress: () => void };
  setFiltersPatch: (patch: Partial<ClimbFilters>) => void;
};

function starOptions(t: TFunction<'climbs'>): MoreOption[] {
  return [
    { key: ANY, label: t('mobile.filter.anyRating') },
    ...STAR_VALUES.map((stars) => ({ key: String(stars), label: t('mobile.filter.ratingAtLeast', { count: stars }) })),
  ];
}

function starKey(value: number | undefined): string {
  return value == null ? ANY : String(value);
}

function starValue(key: string): number | undefined {
  return key === ANY ? undefined : Number(key);
}

function popularityKey(filters: ClimbFilters): string {
  if (filters.status === 'projects') return 'projects';
  return filters.minAscents == null ? ANY : String(filters.minAscents);
}

function nameSection(input: ClimbFilterFormInput): ClimbFilterFormSection {
  const { t, name, recent } = input;
  const rows: ClimbFilterFormRow[] = [
    {
      kind: 'name',
      key: 'name',
      value: name.value,
      placeholder: name.placeholder,
      accessibilityLabel: t('mobile.filter.section.name'),
      clearLabel: name.clearLabel,
      onChangeText: name.onChangeText,
      onClear: name.onClear,
      onFocus: name.onFocus,
    },
  ];
  let footer: string | undefined;
  if (recent && recent.items.length > 0) {
    const current = recent.items.find((item) => item.id === recent.currentId);
    rows.push({
      kind: 'menu',
      key: 'recent',
      label: t('mobile.search.recentFilters'),
      value: current?.label,
      items: recent.items.map((item) => ({ key: item.id, label: item.label, checked: item.id === recent.currentId })),
      onSelect: recent.onSelect,
    });
  } else if (recent) {
    footer = t('mobile.filter.recentDescription');
  }
  return { key: 'name', title: t('mobile.filter.section.name'), footer, rows };
}

function difficultySection(input: ClimbFilterFormInput): ClimbFilterFormSection {
  const { t, grade, accuracy, filters } = input;
  return {
    key: 'difficulty',
    title: t('mobile.filter.section.difficulty'),
    footer: t('mobile.filter.accuracy.description'),
    rows: [
      { kind: 'custom', key: 'grade', content: grade.rail, height: grade.height, fullBleed: true },
      {
        kind: 'select',
        key: 'accuracy',
        label: t('mobile.filter.accuracy.label'),
        options: accuracy.options,
        selectedKey: filters.gradeAccuracy ?? 'off',
        onSelect: (key) => accuracy.onSelect(key as GradeAccuracyValue | 'off'),
      },
    ],
  };
}

function progressSection(input: ClimbFilterFormInput): ClimbFilterFormSection | null {
  const { t, progress, filters, setFiltersPatch } = input;
  if (!progress) return null;
  const rows: MoreRow[] = [
    {
      kind: 'select',
      key: 'progress',
      label: t('mobile.filter.progress.label'),
      options: Object.entries(progress.labels).map(([key, label]) => ({ key, label })),
      selectedKey: progress.selected,
      onSelect: (key) => progress.onSelect(key as ProgressFilter),
    },
  ];
  if (progress.showMyRating) {
    rows.push(
      {
        kind: 'select',
        key: 'myRating',
        label: t('mobile.filter.myRating'),
        options: starOptions(t),
        selectedKey: starKey(filters.minUserRating),
        onSelect: (key) => setFiltersPatch({ minUserRating: starValue(key) }),
      },
      {
        kind: 'toggle',
        key: 'onlyRatedByMe',
        label: t('mobile.filter.onlyRatedByMe'),
        value: !!filters.onlyRatedByMe,
        onValueChange: (value) => setFiltersPatch({ onlyRatedByMe: value || undefined }),
      },
    );
  }
  return {
    key: 'progress',
    title: t('mobile.filter.progress.label'),
    footer: progress.showMyRating ? t('mobile.filter.myRatingDescription') : undefined,
    rows,
  };
}

function qualitySection(input: ClimbFilterFormInput): ClimbFilterFormSection {
  const { t, collection, popularity, filters, setFiltersPatch } = input;
  return {
    key: 'quality',
    title: t('mobile.filter.section.quality'),
    rows: [
      {
        kind: 'select',
        key: 'collection',
        label: t('mobile.filter.collection.label'),
        options: collection.options,
        selectedKey: collection.selected,
        onSelect: (key) => collection.onSelect(key as CollectionFilter),
      },
      {
        kind: 'select',
        key: 'minRating',
        label: t('mobile.filter.minRating'),
        options: starOptions(t),
        selectedKey: starKey(filters.minRating),
        onSelect: (key) => setFiltersPatch({ minRating: starValue(key) }),
      },
      {
        kind: 'select',
        key: 'popularity',
        label: t('mobile.filter.popularity'),
        options: POPULARITY_KEYS.map((key) => ({
          key,
          label:
            key === ANY
              ? t('mobile.filter.anyAscents')
              : key === 'projects'
                ? t('mobile.filter.popularityUnrepeated')
                : key === '2'
                  ? t('mobile.filter.established2plus')
                  : `${formatMinAscentsFilterCount(Number(key))}+`,
        })),
        selectedKey: popularityKey(filters),
        onSelect: (key) => {
          if (key === 'projects') popularity.onStatusChange('projects');
          else popularity.onBucket(key === ANY ? undefined : Number(key));
        },
      },
    ],
  };
}

function climbSection(input: ClimbFilterFormInput): ClimbFilterFormSection {
  const { t, filters, climbType, tall, wide, boardFit, setFiltersPatch } = input;
  const rows: MoreRow[] = [];
  if (climbType.show) {
    rows.push({
      kind: 'segmented',
      key: 'climbType',
      label: t('mobile.filter.climbType.label'),
      options: climbType.options,
      selectedKey: climbType.selected,
      onSelect: (key) => climbType.onSelect(key as ClimbTypeFilter),
    });
  }
  if (input.showOtherAngles) {
    rows.push({
      kind: 'toggle',
      key: 'otherAngles',
      label: t('mobile.filter.otherAngles'),
      subtitle: t('mobile.filter.otherAnglesDescription'),
      value: !!filters.includeOtherAngles,
      onValueChange: (value) => setFiltersPatch({ includeOtherAngles: value || undefined }),
    });
  }
  if (tall.show) {
    rows.push({
      kind: 'toggle',
      key: 'tall',
      label: t('mobile.filter.tall'),
      subtitle: tall.locked ? t('mobile.filter.tallLockedHint') : t('mobile.filter.tallDescription'),
      value: tall.locked || !!filters.onlyTallClimbs,
      disabled: tall.locked,
      onValueChange: (value) => setFiltersPatch({ onlyTallClimbs: value || undefined }),
    });
  }
  if (wide.show) {
    rows.push({
      kind: 'toggle',
      key: 'wide',
      label: t('mobile.filter.wide'),
      subtitle: wide.locked ? t('mobile.filter.wideLockedHint') : t('mobile.filter.wideDescription'),
      value: wide.locked || !!filters.onlyWideClimbs,
      disabled: wide.locked,
      onValueChange: (value) => setFiltersPatch({ onlyWideClimbs: value || undefined }),
    });
  }
  if (input.showBeta) {
    rows.push({
      kind: 'toggle',
      key: 'beta',
      label: t('mobile.filter.betaVideosDescription'),
      value: !!filters.onlyWithBetaVideos,
      onValueChange: (value) => setFiltersPatch({ onlyWithBetaVideos: value || undefined }),
    });
  }
  if (boardFit) {
    rows.push({
      kind: 'toggle',
      key: 'boardFit',
      label: t('mobile.filter.boardFit.switch'),
      subtitle: t('mobile.filter.boardFit.description'),
      value: boardFit.value,
      onValueChange: boardFit.onChange,
    });
  }
  return { key: 'theClimb', title: t('mobile.filter.section.theClimb'), rows };
}

/** Setters (with Following under it), Hold types and Board region: the rows that push a picker route. */
function pickerSection(input: ClimbFilterFormInput): ClimbFilterFormSection | null {
  const { t, pickers, filters, setFiltersPatch } = input;
  const rows: MoreRow[] = [];
  const pickerRow = (key: FilterPickerRowKey, label: string) => {
    const picker = pickers[key];
    if (!picker.show || picker.disabled) return;
    rows.push({ kind: 'nav', key, label, value: picker.value, onPress: picker.onPress });
  };
  pickerRow('setters', t('mobile.filter.setters'));
  if (input.showFollowing) {
    rows.push({
      kind: 'toggle',
      key: 'following',
      label: t('authors.followingClimbs'),
      value: !!filters.onlyFollowedAuthors,
      onValueChange: (enabled) => setFiltersPatch({ onlyFollowedAuthors: enabled || undefined }),
    });
  }
  pickerRow('holds', t('mobile.holdFilter.title'));
  pickerRow('zone', t('mobile.zoneFilter.title'));
  return rows.length > 0 ? { key: 'pickers', rows } : null;
}

function sortSection(input: ClimbFilterFormInput): ClimbFilterFormSection {
  const { t, sort } = input;
  const rows: MoreRow[] = [];
  if (sort.kind === 'list') {
    rows.push({
      kind: 'select',
      key: 'sortBy',
      label: t('mobile.filter.sortBy'),
      options: sort.options.map(({ key, label }) => ({ key, label })),
      selectedKey: sort.selected,
      onSelect: sort.onSelect,
    });
    if (sort.showReshuffle) {
      rows.push({
        kind: 'button',
        key: 'reshuffle',
        label: t('mobile.filter.sort.reshuffle'),
        onPress: sort.onReshuffle,
      });
    } else if (sort.orderOptions) {
      rows.push({
        kind: 'segmented',
        key: 'sortOrder',
        label: t('mobile.filter.sortOrderLabel'),
        options: sort.orderOptions,
        selectedKey: sort.order,
        onSelect: (key) => sort.onOrderChange(key as SortOrder),
      });
    }
  } else {
    rows.push({
      kind: 'select',
      key: 'sortBy',
      label: t('mobile.filter.sortBy'),
      options: SORT_OPTIONS.map((option) => ({ key: option, label: sort.labels[option] })),
      selectedKey: sort.sortBy,
      onSelect: (key) => sort.onSortBy(key as SortOption),
    });
    if (sort.sortBy === 'random') {
      rows.push({
        kind: 'button',
        key: 'reshuffle',
        label: t('mobile.filter.sort.reshuffle'),
        onPress: sort.onReshuffle,
      });
    } else {
      rows.push({
        kind: 'segmented',
        key: 'sortOrder',
        label: t('mobile.filter.sortOrderLabel'),
        options: sort.orderOptions,
        selectedKey: sort.sortOrder,
        onSelect: sort.onSortOrder,
      });
    }
  }
  return { key: 'sort', title: t('mobile.filter.section.sort'), rows };
}

function quickFiltersSection(input: ClimbFilterFormInput): ClimbFilterFormSection {
  const { quickFilters } = input;
  return {
    key: 'quickFilters',
    footer: quickFilters.footer,
    rows: [{ kind: 'nav', key: 'quickFilters', label: quickFilters.label, onPress: quickFilters.onPress }],
  };
}

export function buildClimbFilterFormModel(input: ClimbFilterFormInput): ClimbFilterFormModel {
  const sections = [
    nameSection(input),
    difficultySection(input),
    progressSection(input),
    qualitySection(input),
    climbSection(input),
    pickerSection(input),
    sortSection(input),
    quickFiltersSection(input),
  ].filter((section): section is ClimbFilterFormSection => section !== null && section.rows.length > 0);
  return { sections };
}

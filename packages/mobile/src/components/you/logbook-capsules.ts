// The Logbook's quick-filter capsules and the removable tokens under them. Pure
// (no React, no native imports): the Logbook tab hands its filter state and
// bound handlers in, and gets CapsuleRow descriptors and FilterTokens out, so
// the order, labels, active states and pin rules are locked by a unit test
// instead of three platform trees.
//
// Order: Filters · N, then the pinned capsules in catalog order
// (lib/logbook-pinnable-chips.ts): Grade, Status, Stars, When, Board, Angle,
// Setter, Benchmarks, Sort.
//   • Grade and Angle show and hide an inline rail (one open at a time; the
//     tab owns which).
//   • When's "Custom…" switches to the Custom window and opens the sheet on its
//     When section, where the From / To rows are.
//   • Board shows only with something to pick: two or more logged boards, or a
//     board already set (so it can be cleared).
//   • Sort switches the sort key; each option says what you get ("Name A–Z").
//     The order itself lives in the sheet.
// Under the row, a token names every active filter whose capsule isn't pinned,
// plus the climb-name search, so a filtered list always says why.

import type { TFunction } from 'i18next';
import {
  DEFAULT_LOGBOOK_ANGLE_RANGE,
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  LOGBOOK_DATE_WINDOWS,
  LOGBOOK_SORT_KEYS,
  LOGBOOK_STATUS_SEGMENTS,
  filtersForStatusSegment,
  isLogbookDateFilterActive,
  logbookSortFor,
  logbookSortKeyOf,
  parseLocalIsoDate,
  statusSegmentFor,
  type LogbookDateWindow,
  type LogbookFilterState,
  type LogbookSortDirection,
  type LogbookSortKey,
  type LogbookSortState,
  type LogbookStatusSegment,
} from '@boardsesh/logbook';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import type { Capsule } from '../filter-capsules/CapsuleRow.types';
import { formatAngleRangeLabel } from '../filter-sheet/angle-labels';
import type { FilterToken } from '../../lib/filter-tokens';
import { gradeBoundLabels, type NamedGradeStop } from '../../lib/grade-stops';
import { LOGBOOK_PINNABLE_CHIP_CATALOG, type LogbookPinnableChipKind } from '../../lib/logbook-pinnable-chips';
import { countActiveLogbookFilters } from './use-logbook-search';
import type { LogbookBoardOption } from './use-logbook-board-options';

/** The inline rails a capsule can open under the row. */
export type LogbookRailKind = 'grade' | 'angle';

/** What the labels need, shared by the capsules, the tokens and the sheet. */
export type LogbookLabelInput = {
  filters: LogbookFilterState;
  sort: LogbookSortState;
  /** False on someone else's logbook: labels say "Their", never "Your". */
  viewerIsOwner: boolean;
  /** The grade rail's stops (`buildGradeRailStops`), so a grade reads as its chip does. Empty while grades load. */
  gradeStops: readonly NamedGradeStop[];
  boardOptions: readonly LogbookBoardOption[];
  /** For the custom date range ("Jun 3 – Jun 30"). */
  locale: string | undefined;
};

export type LogbookCapsuleInput = LogbookLabelInput & {
  pinned: readonly LogbookPinnableChipKind[];
  /** The committed climb-name search; counts toward Filters · N. */
  name: string;
  openRail: LogbookRailKind | null;
  onOpenFilters: () => void;
  /** When's "Custom…": opens the sheet on its When section, where the From / To rows are. */
  onOpenCustomDates: () => void;
  /** One handler for both directions: the caller closes the rail when it is the open one. */
  onToggleRail: (rail: LogbookRailKind) => void;
  onChangeFilters: (patch: Partial<LogbookFilterState>) => void;
  onChangeSort: (sort: LogbookSortState) => void;
  onOpenSetters: () => void;
};

export type LogbookTokenInput = LogbookLabelInput & {
  pinned: readonly LogbookPinnableChipKind[];
  name: string;
  onChangeFilters: (patch: Partial<LogbookFilterState>) => void;
  onChangeSort: (sort: LogbookSortState) => void;
  onClearName: () => void;
};

type YouT = TFunction<'you'>;

/** Filters · N: every active filter dimension, plus one for a climb-name search. */
export function countLogbookFilters(filters: LogbookFilterState, name: string): number {
  return countActiveLogbookFilters(filters) + (name.trim().length > 0 ? 1 : 0);
}

// --- Active tests (mirror countActiveLogbookFilters) -------------------------

function isGradeActive(filters: LogbookFilterState): boolean {
  return filters.minGrade !== '' || filters.maxGrade !== '';
}

function isAngleActive(filters: LogbookFilterState): boolean {
  return (
    filters.angleRange[0] !== DEFAULT_LOGBOOK_ANGLE_RANGE[0] || filters.angleRange[1] !== DEFAULT_LOGBOOK_ANGLE_RANGE[1]
  );
}

/** The sort is off the default (Latest: date, newest first). */
export function isLogbookSortActive(sort: LogbookSortState): boolean {
  const { key, direction } = logbookSortKeyOf(sort);
  return !(key === 'date' && direction === 'desc');
}

function isKindActive(kind: LogbookPinnableChipKind, filters: LogbookFilterState, sort: LogbookSortState): boolean {
  switch (kind) {
    case 'grade':
      return isGradeActive(filters);
    case 'status':
      return statusSegmentFor(filters) !== 'all';
    case 'stars':
      return filters.minQuality !== '';
    case 'date':
      return isLogbookDateFilterActive(filters);
    case 'board':
      return filters.boardType !== '';
    case 'angle':
      return isAngleActive(filters);
    case 'setter':
      return filters.setterUsernames.length > 0;
    case 'benchmarks':
      return filters.benchmarkOnly;
    case 'sort':
      return isLogbookSortActive(sort);
  }
}

/** The angle filter as the rail reads it: null while it spans the whole board. */
export function logbookAngleRailValue(angleRange: readonly [number, number]): readonly [number, number] | null {
  const [minAngle, maxAngle] = angleRange;
  return minAngle === DEFAULT_LOGBOOK_ANGLE_RANGE[0] && maxAngle === DEFAULT_LOGBOOK_ANGLE_RANGE[1]
    ? null
    : [minAngle, maxAngle];
}

/** The angle patch for a rail change: Any widens back to the whole board. */
export function logbookAnglePatch(next: readonly [number, number] | null): Pick<LogbookFilterState, 'angleRange'> {
  return { angleRange: next ? [next[0], next[1]] : DEFAULT_LOGBOOK_ANGLE_RANGE };
}

// --- Labels ------------------------------------------------------------------

/** "V4–V6", "V5", "≥V4", "≤V6", named the way the rail's chips are; null while grades load. */
export function logbookGradeLabel(filters: LogbookFilterState, gradeStops: readonly NamedGradeStop[]): string | null {
  if (!isGradeActive(filters) || gradeStops.length === 0) return null;
  const { min, max } = gradeBoundLabels(gradeStops, {
    minGradeId: filters.minGrade === '' ? undefined : filters.minGrade,
    maxGradeId: filters.maxGrade === '' ? undefined : filters.maxGrade,
  });
  if (min != null && max != null) return min === max ? min : `${min}–${max}`;
  if (min != null && filters.maxGrade === '') return `≥${min}`;
  if (max != null && filters.minGrade === '') return `≤${max}`;
  // A saved grade the scale has no chip for: say only that a grade is set.
  return null;
}

export function logbookStatusLabel(segment: LogbookStatusSegment, t: YouT): string {
  switch (segment) {
    case 'sends':
      return t('mobile.logbook.status.sends');
    case 'flashes':
      return t('mobile.logbook.status.flashes');
    case 'attempts':
      return t('mobile.logbook.status.attempts');
    case 'all':
      return t('mobile.logbook.status.all');
  }
}

/** "3★+" for a minimum, "5★" for the top. */
export function logbookStarsLabel(minQuality: number, t: YouT): string {
  return minQuality >= 5
    ? t('mobile.logbook.row.stars', { count: minQuality })
    : t('mobile.logbook.capsules.starsAtLeast', { count: minQuality });
}

export function logbookDateWindowLabel(window: LogbookDateWindow, t: YouT): string {
  switch (window) {
    case 'any':
      return t('mobile.logbook.dateWindow.any');
    case 'last7':
      return t('mobile.logbook.dateWindow.last7');
    case 'month':
      return t('mobile.logbook.dateWindow.month');
    case 'last3months':
      return t('mobile.logbook.dateWindow.last3months');
    case 'year':
      return t('mobile.logbook.dateWindow.year');
    case 'custom':
      return t('mobile.logbook.dateWindow.custom');
  }
}

function formatShortDate(iso: string, locale: string | undefined): string | null {
  const date = parseLocalIsoDate(iso);
  return date ? date.toLocaleDateString(locale, { month: 'short', day: 'numeric' }) : null;
}

/**
 * The When label: the window's name, or for Custom the range itself ("Jun 3 –
 * Jun 30", "Since Jun 3", "Until Jun 30"). Null while the filter is off.
 */
export function logbookDateLabel(filters: LogbookFilterState, t: YouT, locale: string | undefined): string | null {
  if (!isLogbookDateFilterActive(filters)) return null;
  if (filters.dateWindow !== 'custom') return logbookDateWindowLabel(filters.dateWindow, t);
  const fromLabel = formatShortDate(filters.fromDate, locale);
  const toLabel = formatShortDate(filters.toDate, locale);
  if (fromLabel != null && toLabel != null) return `${fromLabel} – ${toLabel}`;
  if (fromLabel != null) return t('mobile.logbook.dateSince', { date: fromLabel });
  if (toLabel != null) return t('mobile.logbook.dateUntil', { date: toLabel });
  return null;
}

/** "Kilter", the one layout's name ("Kilter Original"), or "Kilter · 2 layouts". Null with no board set. */
export function logbookBoardLabel(
  filters: LogbookFilterState,
  boardOptions: readonly LogbookBoardOption[],
  t: YouT,
): string | null {
  if (!filters.boardType) return null;
  const option = boardOptions.find((board) => board.boardType === filters.boardType);
  const boardLabel = option?.label ?? formatBoardDisplayName(filters.boardType);
  if (filters.layoutIds.length === 1) {
    const layout = option?.layouts.find((layoutOption) => layoutOption.layoutId === filters.layoutIds[0]);
    if (layout) return layout.label;
  }
  if (filters.layoutIds.length > 0) {
    return t('mobile.logbook.capsules.boardLayouts', { board: boardLabel, count: filters.layoutIds.length });
  }
  return boardLabel;
}

/** One setter's name, or "3 setters". Null with none picked. */
export function logbookSetterLabel(setterUsernames: readonly string[], t: YouT): string | null {
  if (setterUsernames.length === 0) return null;
  if (setterUsernames.length === 1) return setterUsernames[0];
  return t('mobile.logbook.capsules.setters', { count: setterUsernames.length });
}

/** The direction each sort key opens with from the capsule menu. */
const NATURAL_SORT_DIRECTION: Readonly<Record<LogbookSortKey, LogbookSortDirection>> = {
  date: 'desc',
  grade: 'desc',
  loggedGrade: 'desc',
  climbName: 'asc',
  attemptCount: 'desc',
};

/** What a sort reads as in a few words: "Latest", "Easiest", "Their hardest", "Name A–Z". */
export function logbookSortLabel(
  key: LogbookSortKey,
  direction: LogbookSortDirection,
  viewerIsOwner: boolean,
  t: YouT,
): string {
  const descending = direction === 'desc';
  switch (key) {
    case 'date':
      return descending ? t('mobile.logbook.sortLabel.latest') : t('mobile.logbook.sortLabel.oldest');
    case 'grade':
      return descending ? t('mobile.logbook.sortLabel.hardest') : t('mobile.logbook.sortLabel.easiest');
    case 'loggedGrade':
      if (viewerIsOwner) {
        return descending ? t('mobile.logbook.sortLabel.yourHardest') : t('mobile.logbook.sortLabel.yourEasiest');
      }
      return descending ? t('mobile.logbook.sortLabel.theirHardest') : t('mobile.logbook.sortLabel.theirEasiest');
    case 'climbName':
      return descending ? t('mobile.logbook.sortLabel.nameDesc') : t('mobile.logbook.sortLabel.nameAsc');
    case 'attemptCount':
      return descending ? t('mobile.logbook.sortLabel.mostTries') : t('mobile.logbook.sortLabel.fewestTries');
  }
}

/** The label a kind's capsule or token shows while it is active (null when inactive). */
function activeLabelFor(kind: LogbookPinnableChipKind, input: LogbookLabelInput, t: YouT): string | null {
  const { filters, sort, viewerIsOwner, gradeStops, boardOptions, locale } = input;
  if (!isKindActive(kind, filters, sort)) return null;
  switch (kind) {
    case 'grade':
      return logbookGradeLabel(filters, gradeStops) ?? t('mobile.logbook.grade');
    case 'status':
      return logbookStatusLabel(statusSegmentFor(filters), t);
    case 'stars':
      return filters.minQuality === '' ? null : logbookStarsLabel(filters.minQuality, t);
    case 'date':
      return logbookDateLabel(filters, t, locale);
    case 'board':
      return logbookBoardLabel(filters, boardOptions, t);
    case 'angle':
      return formatAngleRangeLabel(filters.angleRange[0], filters.angleRange[1]);
    case 'setter':
      return logbookSetterLabel(filters.setterUsernames, t);
    case 'benchmarks':
      return t('mobile.logbook.capsules.benchmarks');
    case 'sort': {
      const { key, direction } = logbookSortKeyOf(sort);
      return logbookSortLabel(key, direction, viewerIsOwner, t);
    }
  }
}

// --- Narrowing the menus' string tags ----------------------------------------

function isStatusSegment(value: string): value is LogbookStatusSegment {
  return (LOGBOOK_STATUS_SEGMENTS as readonly string[]).includes(value);
}

function isDateWindow(value: string): value is LogbookDateWindow {
  return (LOGBOOK_DATE_WINDOWS as readonly string[]).includes(value);
}

function isSortKey(value: string): value is LogbookSortKey {
  return (LOGBOOK_SORT_KEYS as readonly string[]).includes(value);
}

const STAR_VALUES = [1, 2, 3, 4, 5] as const;
const ANY_STARS = 'any';
const ALL_BOARDS = 'all';

// --- Capsules ----------------------------------------------------------------

/** Builds the Logbook capsule row. Memoise the call on the inputs it reads. */
export function buildLogbookCapsules(input: LogbookCapsuleInput, t: YouT): Capsule[] {
  const {
    pinned,
    filters,
    sort,
    name,
    viewerIsOwner,
    boardOptions,
    openRail,
    onOpenFilters,
    onOpenCustomDates,
    onToggleRail,
    onChangeFilters,
    onChangeSort,
    onOpenSetters,
  } = input;
  const pinnedKinds = new Set(pinned);
  const activeCount = countLogbookFilters(filters, name);
  const label = (kind: LogbookPinnableChipKind, restingLabel: string) => activeLabelFor(kind, input, t) ?? restingLabel;

  const capsules: Capsule[] = [
    {
      kind: 'sheet',
      key: 'filters',
      label:
        activeCount > 0
          ? t('mobile.logbook.capsules.filtersWithCount', { count: activeCount })
          : t('mobile.logbook.capsules.filters'),
      count: activeCount,
      icon: 'filters',
      onPress: onOpenFilters,
    },
  ];

  for (const kind of LOGBOOK_PINNABLE_CHIP_CATALOG) {
    if (!pinnedKinds.has(kind)) continue;
    const active = isKindActive(kind, filters, sort);
    switch (kind) {
      case 'grade':
      case 'angle': {
        const expanded = openRail === kind;
        capsules.push({
          kind: 'rail',
          key: kind,
          label: label(kind, kind === 'grade' ? t('mobile.logbook.grade') : t('mobile.logbook.angle')),
          active,
          expanded,
          onPress: () => onToggleRail(kind),
          accessibilityHint:
            kind === 'grade'
              ? expanded
                ? t('mobile.logbook.capsules.gradeCloseHint')
                : t('mobile.logbook.capsules.gradeOpenHint')
              : expanded
                ? t('mobile.logbook.capsules.angleCloseHint')
                : t('mobile.logbook.capsules.angleOpenHint'),
        });
        break;
      }
      case 'status':
        capsules.push({
          kind: 'menu',
          key: kind,
          label: label(kind, t('mobile.logbook.capsules.status')),
          active,
          options: LOGBOOK_STATUS_SEGMENTS.map((segment) => ({
            value: segment,
            label: logbookStatusLabel(segment, t),
          })),
          selected: statusSegmentFor(filters),
          onSelect: (value) => {
            if (isStatusSegment(value)) onChangeFilters(filtersForStatusSegment(value));
          },
        });
        break;
      case 'stars':
        capsules.push({
          kind: 'menu',
          key: kind,
          label: label(kind, t('mobile.logbook.capsules.stars')),
          active,
          options: [
            { value: ANY_STARS, label: t('mobile.logbook.capsules.anyStars') },
            ...STAR_VALUES.map((stars) => ({ value: String(stars), label: logbookStarsLabel(stars, t) })),
          ],
          selected: filters.minQuality === '' ? ANY_STARS : String(filters.minQuality),
          onSelect: (value) => {
            if (value === ANY_STARS) {
              onChangeFilters({ minQuality: '' });
              return;
            }
            const stars = Number(value);
            if (Number.isInteger(stars) && stars >= 1 && stars <= 5) onChangeFilters({ minQuality: stars });
          },
        });
        break;
      case 'date':
        capsules.push({
          kind: 'menu',
          key: kind,
          label: label(kind, t('mobile.logbook.capsules.when')),
          active,
          options: LOGBOOK_DATE_WINDOWS.filter((window) => window !== 'custom').map((window) => ({
            value: window,
            label: logbookDateWindowLabel(window, t),
          })),
          // Custom has no option of its own: its range is the capsule's label.
          selected: filters.dateWindow === 'custom' ? undefined : filters.dateWindow,
          onSelect: (value) => {
            if (isDateWindow(value)) onChangeFilters({ dateWindow: value });
          },
          actions: [
            {
              key: 'custom',
              label: t('mobile.logbook.capsules.customDates'),
              onPress: () => {
                if (filters.dateWindow !== 'custom') onChangeFilters({ dateWindow: 'custom' });
                onOpenCustomDates();
              },
            },
          ],
        });
        break;
      case 'board': {
        if (boardOptions.length < 2 && !filters.boardType) break;
        const knownBoard = boardOptions.some((board) => board.boardType === filters.boardType);
        capsules.push({
          kind: 'menu',
          key: kind,
          label: label(kind, t('mobile.logbook.capsules.board')),
          active,
          options: [
            { value: ALL_BOARDS, label: t('mobile.filter.allBoards') },
            ...boardOptions.map((board) => ({ value: board.boardType, label: board.label })),
            // A board saved from another logbook still shows, so it can be cleared.
            ...(filters.boardType && !knownBoard
              ? [{ value: filters.boardType, label: formatBoardDisplayName(filters.boardType) }]
              : []),
          ],
          selected: filters.boardType || ALL_BOARDS,
          onSelect: (value) => onChangeFilters({ boardType: value === ALL_BOARDS ? '' : value, layoutIds: [] }),
        });
        break;
      }
      case 'setter':
        capsules.push({
          kind: 'sheet',
          key: kind,
          label: label(kind, t('mobile.logbook.capsules.setter')),
          count: filters.setterUsernames.length,
          // Read instead of the label on iOS and the web, so it carries the picks too.
          accessibilityLabel:
            filters.setterUsernames.length > 0
              ? t('mobile.logbook.capsules.setterPickedAria', {
                  setters: logbookSetterLabel(filters.setterUsernames, t),
                })
              : t('mobile.logbook.capsules.setterAria'),
          // Wrapped: a platform's press event must not reach the handler's arguments.
          onPress: () => onOpenSetters(),
        });
        break;
      case 'benchmarks':
        capsules.push({
          kind: 'toggle',
          key: kind,
          label: t('mobile.logbook.capsules.benchmarks'),
          active,
          onPress: () => onChangeFilters({ benchmarkOnly: !filters.benchmarkOnly }),
        });
        break;
      case 'sort': {
        const current = logbookSortKeyOf(sort);
        capsules.push({
          kind: 'menu',
          key: kind,
          label: logbookSortLabel(current.key, current.direction, viewerIsOwner, t),
          active,
          // Each option names what it gives: the current key in its current
          // order, every other key in the order it opens with.
          options: LOGBOOK_SORT_KEYS.map((key) => ({
            value: key,
            label: logbookSortLabel(
              key,
              key === current.key ? current.direction : NATURAL_SORT_DIRECTION[key],
              viewerIsOwner,
              t,
            ),
          })),
          selected: current.key,
          onSelect: (value) => {
            if (!isSortKey(value) || value === current.key) return;
            onChangeSort(logbookSortFor(value, NATURAL_SORT_DIRECTION[value]));
          },
        });
        break;
      }
    }
  }

  return capsules;
}

// --- Tokens ------------------------------------------------------------------

/** The patch that puts one kind's filter back to its default. */
function clearPatchFor(kind: Exclude<LogbookPinnableChipKind, 'sort'>): Partial<LogbookFilterState> {
  switch (kind) {
    case 'grade':
      return { minGrade: '', maxGrade: '' };
    case 'status':
      return filtersForStatusSegment('all');
    case 'stars':
      return { minQuality: '' };
    case 'date':
      return {
        dateWindow: DEFAULT_LOGBOOK_FILTERS.dateWindow,
        fromDate: DEFAULT_LOGBOOK_FILTERS.fromDate,
        toDate: DEFAULT_LOGBOOK_FILTERS.toDate,
      };
    case 'board':
      return { boardType: '', layoutIds: [] };
    case 'angle':
      return { angleRange: DEFAULT_LOGBOOK_ANGLE_RANGE };
    case 'setter':
      return { setterUsernames: [] };
    case 'benchmarks':
      return { benchmarkOnly: false };
  }
}

/**
 * The removable tokens under the capsule row: the climb-name search first, then
 * every active filter whose capsule isn't pinned, in catalog order. A pinned
 * capsule already shows and clears its own filter, so it gets no token.
 */
export function buildLogbookFilterTokens(input: LogbookTokenInput, t: YouT): FilterToken[] {
  const { pinned, name, onChangeFilters, onChangeSort, onClearName } = input;
  const pinnedKinds = new Set(pinned);
  const tokens: FilterToken[] = [];
  const trimmedName = name.trim();
  if (trimmedName.length > 0) {
    tokens.push({
      key: 'name',
      label: t('mobile.logbook.capsules.nameToken', { name: trimmedName }),
      clear: onClearName,
    });
  }
  for (const kind of LOGBOOK_PINNABLE_CHIP_CATALOG) {
    if (pinnedKinds.has(kind)) continue;
    const tokenLabel = activeLabelFor(kind, input, t);
    if (tokenLabel == null) continue;
    tokens.push({
      key: kind,
      label: tokenLabel,
      clear: kind === 'sort' ? () => onChangeSort(DEFAULT_LOGBOOK_SORT) : () => onChangeFilters(clearPatchFor(kind)),
    });
  }
  return tokens;
}

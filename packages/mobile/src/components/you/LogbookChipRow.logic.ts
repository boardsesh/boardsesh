// Pure label builders for the logbook chip row (LogbookChipRow.ios.tsx renders
// the native @expo/ui SwiftUI chips on top of these). No @expo/ui / react-native
// imports so the chip wording is unit-testable without a native host (the
// LogbookChipRow vite alias swaps the COMPONENT for a null stub under Vitest, but
// this `.logic` module is not aliased, so its functions run for real).
//
// The row mirrors the climbs search: every facet (grade / angle / show / date)
// is ALWAYS present — neutral with a resting placeholder until its field is set,
// then amber with the value. A facet's `active` flag mirrors
// countActiveLogbookFilters in use-logbook-search.ts so the chip's amber and the
// badge never disagree about what counts as "set".

import type { TFunction } from 'i18next';
import type { Grade } from '@boardsesh/shared-schema';
import { DEFAULT_LOGBOOK_ANGLE_RANGE, DEFAULT_LOGBOOK_FILTERS, type LogbookFilterState } from '@boardsesh/logbook';

/** The facet chips the row controls inline (grade/angle/date open a rail; show is a menu). */
export type LogbookFacetKey = 'grade' | 'angle' | 'show' | 'date';

/** A facet chip: its key (for React + open-state routing), label, and active flag. */
export type LogbookFacet = { key: LogbookFacetKey; label: string; active: boolean };

/**
 * Resolve a difficulty id to its display label via the same grade list +
 * V/font formatter the filter sheet's GradeRangeRail uses, so the chip and the
 * rail never word a grade differently. Falls back to the raw scale name (then the
 * id) when the formatter can't render it.
 */
function gradeName(
  difficultyId: number,
  gradesById: Map<number, string>,
  formatGrade: (name: string) => string | null,
): string {
  const rawName = gradesById.get(difficultyId);
  if (rawName == null) return String(difficultyId);
  return formatGrade(rawName) ?? rawName;
}

/**
 * Grade-bound chip wording: "V4–V6" (both bounds, en dash), "V5" (equal bounds),
 * "≥V4" (only min set), "≤V6" (only max set). Caller guards that at least one
 * bound is set before calling.
 */
export function gradeChipLabel(
  minGrade: number | '',
  maxGrade: number | '',
  gradesById: Map<number, string>,
  formatGrade: (name: string) => string | null,
): string {
  const minLabel = minGrade === '' ? null : gradeName(minGrade, gradesById, formatGrade);
  const maxLabel = maxGrade === '' ? null : gradeName(maxGrade, gradesById, formatGrade);
  if (minLabel != null && maxLabel != null) {
    return minGrade === maxGrade ? minLabel : `${minLabel}–${maxLabel}`;
  }
  if (minLabel != null) return `≥${minLabel}`;
  if (maxLabel != null) return `≤${maxLabel}`;
  // Both bounds empty — callers guard against this; defensive fallback so the
  // function never returns a stray "≤null".
  return '';
}

/** Localise one ISO date short ("Jun 30"); null when the ISO can't be parsed. */
function formatShortDate(iso: string): string | null {
  if (!iso) return null;
  // Parse as LOCAL midnight: `new Date("2024-01-15")` is UTC midnight, which
  // renders a day early in negative-offset zones and would disagree with the date
  // picker's local-midnight parse (parseIsoDate in logbook-facet-controls).
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Date-range chip wording: both bounds → "<from> – <to>"; only from → "Since
 * <from>"; only to → "Until <to>". Returns null when neither bound parses (so the
 * chip is dropped rather than showing a half-formed range). Caller guards that at
 * least one bound is set before calling.
 */
export function dateChipLabel(fromDate: string, toDate: string, t: TFunction<'you'>): string | null {
  const fromLabel = formatShortDate(fromDate);
  const toLabel = formatShortDate(toDate);
  if (fromLabel != null && toLabel != null) return `${fromLabel} – ${toLabel}`;
  if (fromLabel != null) return t('mobile.logbook.dateSince', { date: fromLabel });
  if (toLabel != null) return t('mobile.logbook.dateUntil', { date: toLabel });
  return null;
}

/** Angle-range chip wording: "20°–40°". Caller guards non-default before calling. */
export function angleChipLabel(angleRange: [number, number]): string {
  return `${angleRange[0]}°–${angleRange[1]}°`;
}

/** Whether the grade facet is set (either bound). */
function isGradeActive(filters: LogbookFilterState): boolean {
  return filters.minGrade !== '' || filters.maxGrade !== '';
}

/** Whether the angle facet is narrowed off the shared full-board default. */
function isAngleActive(filters: LogbookFilterState): boolean {
  return (
    filters.angleRange[0] !== DEFAULT_LOGBOOK_ANGLE_RANGE[0] || filters.angleRange[1] !== DEFAULT_LOGBOOK_ANGLE_RANGE[1]
  );
}

/** Whether the Show facet (status / flash / benchmarks) is off its default. */
function isShowActive(filters: LogbookFilterState): boolean {
  // The status resting state is the shared default (now sends + attempts). Any
  // status narrowing off it — sends-only or attempts-only — is an active (amber)
  // state, as are flash-only and benchmarks-only.
  const statusNarrowed =
    filters.includeSends !== DEFAULT_LOGBOOK_FILTERS.includeSends ||
    filters.includeAttempts !== DEFAULT_LOGBOOK_FILTERS.includeAttempts;
  return statusNarrowed || filters.flashOnly || filters.benchmarkOnly;
}

/** Whether the date facet has either bound set. */
function isDateActive(filters: LogbookFilterState): boolean {
  return Boolean(filters.fromDate || filters.toDate);
}

/**
 * The four facet chips for the row, ALWAYS in [grade, angle, show, date] order.
 * Each carries its `active` flag (its non-default test, mirroring
 * countActiveLogbookFilters) and its label: the formatted value when active, the
 * resting placeholder when not. The Show facet has no single value to read back,
 * so it shows "Show" in both states (active is conveyed by amber, like the climbs
 * search's Show menu).
 */
export function buildLogbookFacets(
  filters: LogbookFilterState,
  grades: readonly Grade[],
  formatGrade: (name: string) => string | null,
  t: TFunction<'you'>,
): LogbookFacet[] {
  const gradeActive = isGradeActive(filters);
  // Show the placeholder (not the raw difficulty id) while the grade facet is set
  // but the grade scale hasn't loaded yet — the chip stays amber (active) and
  // swaps to the formatted "V4–V6" once `grades` arrives. Building the id→name map
  // only when both are ready keeps the resting/loading cases on the placeholder.
  const gradesById =
    gradeActive && grades.length > 0 ? new Map(grades.map((grade) => [grade.difficultyId, grade.name])) : null;
  const gradeLabel = gradesById
    ? gradeChipLabel(filters.minGrade, filters.maxGrade, gradesById, formatGrade)
    : t('mobile.logbook.grade');

  const angleActive = isAngleActive(filters);
  const angleLabel = angleActive ? angleChipLabel(filters.angleRange) : t('mobile.logbook.angle');

  const dateActive = isDateActive(filters);
  // A half-formed range (neither bound parses) falls back to the placeholder so
  // the chip never shows a stray dash.
  const dateLabel =
    (dateActive ? dateChipLabel(filters.fromDate, filters.toDate, t) : null) ?? t('mobile.logbook.dateRange');

  return [
    { key: 'grade', label: gradeLabel, active: gradeActive },
    { key: 'angle', label: angleLabel, active: angleActive },
    { key: 'show', label: t('mobile.logbook.show'), active: isShowActive(filters) },
    { key: 'date', label: dateLabel, active: dateActive },
  ];
}

/** True when any facet is active — drives the Filter chip's amber. */
export function anyFilterActive(facets: readonly LogbookFacet[]): boolean {
  return facets.some((facet) => facet.active);
}

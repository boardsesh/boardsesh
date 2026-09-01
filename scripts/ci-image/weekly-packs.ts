/// <reference types="node" />

/**
 * Pure date/tag/revlist math for the prebaked CI image's git-history layering
 * (issue #5008, part of epic #5005). No filesystem or git I/O here — that
 * lives in generate-weekly-packs.ts, which imports this module. Kept separate
 * so the arithmetic that decides "which week is this, and what does
 * `git pack-objects` need on stdin" can be unit-tested without a git repo.
 *
 * Why this math exists at all: `.git` is one big packfile that grows without
 * bound, so a naive daily CI-image rebuild re-pushes the whole thing (~400 MB
 * measured on this repo) every day. Splitting history into 7-day slices turns
 * that into a handful of small, PERMANENTLY FROZEN layers plus one small
 * layer that legitimately changes daily — see Dockerfile.ci's header comment
 * for the full chaining rationale (historical packs are never regenerated,
 * only ever chained via `FROM <previous week's published tag>`).
 */

/** One week, in milliseconds. Boundaries are always exactly this far apart. */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` in UTC, the format every tag in this scheme is built from. */
export function toDateOnlyUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Parse a strict `YYYY-MM-DD` as UTC midnight. Deliberately rejects anything
 * looser (a full ISO timestamp, a locale-formatted date) — this value flows
 * straight into an image tag and into `git log --before`, so an ambiguous
 * parse would silently shift which commits land in which week.
 */
export function parseDateOnlyUTC(dateOnly: string): Date {
  if (!DATE_ONLY_PATTERN.test(dateOnly)) {
    throw new Error(`expected an ISO date (YYYY-MM-DD), got ${JSON.stringify(dateOnly)}`);
  }
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid calendar date ${JSON.stringify(dateOnly)}`);
  }
  // Reject e.g. 2026-02-30, which Date() silently rolls forward into March.
  if (toDateOnlyUTC(date) !== dateOnly) {
    throw new Error(`invalid calendar date ${JSON.stringify(dateOnly)}`);
  }
  return date;
}

/**
 * Every week-end boundary strictly after `baselineDate` up to and including
 * `asOf`, one every 7 days. Deliberately NOT calendar weeks (Mon-Sun) —
 * boundaries are 7-day multiples of the baseline date, so a quarterly
 * re-baseline resets the cadence to whatever day it lands on rather than
 * snapping to a fixed weekday. Matches the measured layering in issue #5008:
 * baseline 2026-07-28 -> 2026-08-04, 2026-08-11, 2026-08-18, 2026-08-25,
 * 2026-09-01.
 */
export function computeWeekBoundaries(baselineDate: Date, asOf: Date): Date[] {
  if (asOf.getTime() < baselineDate.getTime()) {
    throw new Error('asOf must not be before baselineDate');
  }
  const boundaries: Date[] = [];
  for (let boundary = baselineDate.getTime() + WEEK_MS; boundary <= asOf.getTime(); boundary += WEEK_MS) {
    boundaries.push(new Date(boundary));
  }
  return boundaries;
}

/** Tag for the quarterly re-baseline image: `boardsesh-ci-git:baseline-<date>`. */
export function baselineTag(baselineDate: Date): string {
  return `baseline-${toDateOnlyUTC(baselineDate)}`;
}

/** Tag for one frozen week: `boardsesh-ci-git:week-<date>`. Immutable once pushed. */
export function weekTag(weekEndDate: Date): string {
  return `week-${toDateOnlyUTC(weekEndDate)}`;
}

/** Fixed name for the still-accumulating, NOT-yet-frozen current week's pack. */
export const CURRENT_WEEK_PACK_NAME = 'current-week';

export interface WeekPlanEntry {
  readonly weekEndDate: Date;
  readonly tag: string;
  /** The image tag this week's freeze must build `FROM` — the previous week, or baseline for the first week. */
  readonly historyBaseTag: string;
}

/**
 * The full list of completed (freezable) weeks between `baselineDate` and
 * `asOf`, each carrying the tag of the image its freeze must chain from. Pure
 * function of the two dates — no registry state, no git state. The caller
 * (generate-weekly-packs.ts) intersects this with "which tags already exist
 * in the registry" to decide what actually needs building today.
 */
export function planCompletedWeeks(baselineDate: Date, asOf: Date): WeekPlanEntry[] {
  const boundaries = computeWeekBoundaries(baselineDate, asOf);
  return boundaries.map((weekEndDate, index) => ({
    weekEndDate,
    tag: weekTag(weekEndDate),
    historyBaseTag: index === 0 ? baselineTag(baselineDate) : weekTag(boundaries[index - 1]),
  }));
}

/** The literal `GIT_HISTORY_BASE` Dockerfile.ci's `toolchain` stage's own default resolves to. */
export const TOOLCHAIN_STAGE = 'toolchain';

export interface HistoryLayerToBuild {
  readonly tag: string;
  /** `TOOLCHAIN_STAGE` for a fresh baseline (no external base image), else a previously published tag. */
  readonly historyBaseTag: string;
}

/**
 * The next single git-history layer that needs building, given the set of
 * tags that already exist in the registry (baseline AND week tags, same
 * namespace). `null` once everything through `asOf` is frozen.
 *
 * The baseline check comes first and is not folded into `planCompletedWeeks`
 * on purpose: on a brand-new repo for this scheme (or right after a
 * re-baseline), NEITHER the baseline NOR any week exists yet, and every week
 * ultimately chains back to the baseline tag — building a week before the
 * baseline exists would try to `FROM` an image that is not there. Callers
 * loop this function (build the returned layer, re-query the registry, call
 * again) until it returns `null`, which correctly bootstraps baseline then
 * each missing week in order, one build per call.
 */
export function nextHistoryLayer(
  baselineDate: Date,
  asOf: Date,
  existingTags: ReadonlySet<string>,
): HistoryLayerToBuild | null {
  const baseline = baselineTag(baselineDate);
  if (!existingTags.has(baseline)) {
    return { tag: baseline, historyBaseTag: TOOLCHAIN_STAGE };
  }
  const nextWeek = planCompletedWeeks(baselineDate, asOf).find((week) => !existingTags.has(week.tag));
  return nextWeek ? { tag: nextWeek.tag, historyBaseTag: nextWeek.historyBaseTag } : null;
}

/**
 * The image tag the DAILY build's `FROM` must resolve to: the most recently
 * frozen week, or the baseline itself if no week has been frozen yet (e.g.
 * immediately after a re-baseline, before the first week has elapsed). Only
 * meaningful once `nextHistoryLayer` returns `null` for the same arguments —
 * callers are expected to finish freezing before computing this.
 */
export function latestHistoryTag(baselineDate: Date, asOf: Date, existingTags: ReadonlySet<string>): string {
  const completed = planCompletedWeeks(baselineDate, asOf).filter((week) => existingTags.has(week.tag));
  return completed.length > 0 ? completed[completed.length - 1].tag : baselineTag(baselineDate);
}

/**
 * The exact stdin `git pack-objects --revs` expects: the pack tip, optionally
 * excluding everything reachable from `excludeTip`. This is the invisible
 * pairing the whole freeze scheme depends on — get the `^` prefix or a
 * trailing newline wrong and `git pack-objects` either silently packs the
 * WHOLE history again (a 340+ MB "weekly" layer) or errors on bad revision
 * syntax. See scripts/ci-image/generate-weekly-packs.ts for the caller.
 */
export function packObjectsRevListInput(tip: string, excludeTip: string | null): string {
  if (tip.length === 0) throw new Error('tip must not be empty');
  if (excludeTip === null) return `${tip}\n`;
  if (excludeTip.length === 0) throw new Error('excludeTip must not be empty when provided');
  return `${tip}\n^${excludeTip}\n`;
}

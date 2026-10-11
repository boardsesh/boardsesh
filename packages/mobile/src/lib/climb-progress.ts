import { normalizeAscentStatus, pickHighestAscentStatus, type AscentStatusValue } from './ascent-status-utils';

/**
 * What the climber has done on ONE climb at ONE angle — the personal half of a
 * climbs-list row (#4796), plus the mirror state that #4801 asks for.
 *
 * Pure and clock-injected: the hook feeds it the handful of logbook entries the
 * `logbookByClimbAngle` index already holds for that key, so a row never scans
 * the whole logbook (docs/react-native-performance.md §4).
 */

/** A logbook tick narrowed to the fields the progress line reads. */
export type ClimbProgressEntry = {
  is_mirror?: boolean | null;
  tries?: number | null;
  climbed_at?: string | null;
  status?: AscentStatusValue | null;
  is_ascent?: boolean | null;
};

/**
 * The outcome token. `flash` and `send` carry no try count on purpose — once
 * you have topped it, how many goes it took is logbook detail, not scan-line
 * information. `attempt` is the one case where the count IS the story.
 */
export type ClimbProgressOutcome =
  | { kind: 'flash'; sendCount: number }
  | { kind: 'send'; sendCount: number }
  | { kind: 'attempt'; tries: number };

/**
 * Which orientations the climber has ticks in. `original` is the DEFAULT and is
 * never rendered — a token that appears on nearly every row says nothing.
 */
export type ClimbProgressMirror = 'original' | 'mirror' | 'both';

export type ClimbProgress = {
  /** Highest status across every orientation — drives the leading glyph. */
  status: AscentStatusValue;
  outcome: ClimbProgressOutcome;
  mirror: ClimbProgressMirror;
  originalStatus: AscentStatusValue | null;
  mirrorStatus: AscentStatusValue | null;
  /** Most recent tick, as an absolute epoch ms; null when no tick parsed. */
  latestClimbedAtMs: number | null;
};

/** Recency bucket. `date` hands the caller a timestamp to format in-locale. */
export type ClimbProgressRecency = { kind: 'today' } | { kind: 'days'; count: number } | { kind: 'date'; ms: number };

/** Past this many days a relative "{{n}}d" stops being easier to read than a date. */
const RELATIVE_DAY_LIMIT = 7;

const MS_PER_DAY = 86_400_000;

function statusOf(entry: ClimbProgressEntry): AscentStatusValue {
  return normalizeAscentStatus({ status: entry.status, isAscent: entry.is_ascent, tries: entry.tries });
}

function isTopped(status: AscentStatusValue): boolean {
  return status === 'flash' || status === 'send';
}

/**
 * Fold a climb's ticks at one angle into the row's personal summary, or null
 * when the climber has no history with it — the majority case and every
 * signed-out row, where the line must not render at all.
 *
 * `parseClimbedAtMs` is injected so this module stays free of the dayjs/UTC
 * parsing rules that live in `@boardsesh/profile-stats` (the `climbed_at`
 * strings are naive UTC and must not be parsed as local).
 */
export function deriveClimbProgress(
  entries: readonly ClimbProgressEntry[] | undefined,
  parseClimbedAtMs: (climbedAt: string) => number,
): ClimbProgress | null {
  if (!entries || entries.length === 0) return null;

  const statuses: AscentStatusValue[] = [];
  let sendCount = 0;
  let attemptTries = 0;
  let latestClimbedAtMs: number | null = null;

  // Directions stay independent: a mirrored attempt still matters after an original send.
  const originalStatuses: AscentStatusValue[] = [];
  const mirrorStatuses: AscentStatusValue[] = [];
  let sentMirrored = false;
  let sentOriginal = false;
  let triedMirrored = false;
  let triedOriginal = false;

  for (const entry of entries) {
    const status = statusOf(entry);
    statuses.push(status);
    const mirrored = entry.is_mirror === true;
    (mirrored ? mirrorStatuses : originalStatuses).push(status);

    if (isTopped(status)) {
      sendCount += 1;
      if (mirrored) sentMirrored = true;
      else sentOriginal = true;
    } else {
      // `tries` is the tick's attemptCount; a null/0 count still means one go.
      attemptTries += Number.isFinite(entry.tries) ? Math.max(1, entry.tries ?? 1) : 1;
      if (mirrored) triedMirrored = true;
      else triedOriginal = true;
    }

    if (entry.climbed_at) {
      const ms = parseClimbedAtMs(entry.climbed_at);
      if (Number.isFinite(ms) && (latestClimbedAtMs === null || ms > latestClimbedAtMs)) {
        latestClimbedAtMs = ms;
      }
    }
  }

  const status = pickHighestAscentStatus(statuses);
  if (status === null) return null;

  const hasMirrored = sentMirrored || triedMirrored;
  const hasOriginal = sentOriginal || triedOriginal;
  const mirror: ClimbProgressMirror =
    hasMirrored && hasOriginal ? 'both' : hasMirrored ? 'mirror' : ('original' as const);

  const outcome: ClimbProgressOutcome =
    status === 'flash'
      ? { kind: 'flash', sendCount }
      : status === 'send'
        ? { kind: 'send', sendCount }
        : { kind: 'attempt', tries: attemptTries };

  return {
    status,
    outcome,
    mirror,
    latestClimbedAtMs,
    originalStatus: pickHighestAscentStatus(originalStatuses),
    mirrorStatus: pickHighestAscentStatus(mirrorStatuses),
  };
}

/**
 * Bucket a tick timestamp for the recency token: "today", "3d", or a date.
 * Both sides are cut to LOCAL midnight first, so a 23:00 tick is "today" until
 * midnight and "1d" the moment after — never "0d" for something 20 hours old.
 */
export function describeClimbProgressRecency(ms: number, nowMs: number): ClimbProgressRecency {
  const tickDay = startOfLocalDay(ms);
  const today = startOfLocalDay(nowMs);
  const dayDiff = Math.round((today - tickDay) / MS_PER_DAY);
  if (dayDiff <= 0) return { kind: 'today' };
  if (dayDiff < RELATIVE_DAY_LIMIT) return { kind: 'days', count: dayDiff };
  return { kind: 'date', ms };
}

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Keep the progress line compact with the same text-size cap as playlist chips.
 * The rich thumbnail provides a 96pt baseline, not a fixed row height: rows with
 * both progress and playlist chips can grow beyond it at larger text sizes.
 * See `climb-row-layout.test.ts` for the stacked text measurements.
 */
export const PROGRESS_MAX_FONT_SCALE = 1.3;

/**
 * How many of the three tokens (outcome · mirror · recency) fit on one line at
 * a given Dynamic Type scale. They drop from the RIGHT — recency first, then
 * mirror — because the outcome is the only one a climber cannot infer from the
 * rest of the row.
 */
export function climbProgressTokenBudget(fontScale: number): number {
  if (!Number.isFinite(fontScale) || fontScale < 1.15) return 3;
  if (fontScale < 1.3) return 2;
  return 1;
}

import { parseTickTime, tickTimeMs } from './format-tick-time';
import type { LogbookEntry } from './types';

/**
 * The climber's whole history on ONE climb, shaped for the play drawer's
 * Logbook card: a one-line verdict, four totals, then one section per angle
 * holding one tile per session with a mark for every try.
 *
 * A session is a distinct LOCAL calendar day, the same convention
 * `deriveAngleLifetimeStats` uses.
 */
export type LedgerStatus = 'flash' | 'send' | 'attempt';

/** One try. A fall is a try that did not top out. */
export type LedgerTryMark = 'fall' | 'send' | 'flash';

export type LedgerSession<T> = {
  /** Local `YYYY-MM-DD`. */
  dayKey: string;
  /** Newest first. */
  entries: T[];
  totalTries: number;
  /** Oldest first, so the send lands at the end of the row it was earned in. */
  marks: LedgerTryMark[];
  /** Falls dropped from `marks` to honour the cap. Still counted in `totalTries`. */
  overflowTries: number;
  /**
   * The best thing that happened that day, whatever order it was logged in:
   * a flash outranks a send, a send outranks an attempt.
   */
  outcome: LedgerStatus;
};

export type LedgerAngleSection<T> = {
  angle: number;
  totalTries: number;
  sessionCount: number;
  sendCount: number;
  /**
   * The first send at this angle. `sessionNumber` is which distinct day it fell
   * on, counting days at this angle from 1. There is deliberately no cumulative
   * try ordinal: an attempt row and a send row logged the same day can both
   * carry the tries that led up to the send, so summing them double counts.
   */
  firstSend: { sessionNumber: number; flash: boolean; climbedAt: string } | null;
  /** Newest first. */
  sessions: LedgerSession<T>[];
};

export type ClimbVerdict =
  | { kind: 'untried' }
  | { kind: 'flash' | 'send' | 'attempt'; angle: number; climbedAt: string };

export type LedgerTotals = {
  /** `angle` when the board's angle has logs and the numbers cover it alone. */
  scope: 'angle' | 'all';
  tries: number;
  sessions: number;
  sends: number;
  personalGrade: number | null;
};

export type ClimbLedger<T> = {
  verdict: ClimbVerdict;
  totals: LedgerTotals;
  /** The board's angle first when it has logs, then the rest steepest first. */
  angles: LedgerAngleSection<T>[];
};

/** Fall marks kept per session. Send and flash marks are never dropped. */
export const DEFAULT_MAX_MARKS_PER_SESSION = 40;

export type DeriveClimbLedgerOptions<T> = {
  currentAngle: number;
  /**
   * The ONLY source of an entry's status. Callers whose entries can arrive
   * without a `status` (the mobile logbook also carries `is_ascent`) pass their
   * own normaliser so the ledger and the rows under it can never disagree.
   */
  statusOf?: (entry: T) => LedgerStatus;
  maxMarksPerSession?: number;
};

function defaultStatusOf(entry: LogbookEntry): LedgerStatus {
  return entry.status ?? 'attempt';
}

function isSent(status: LedgerStatus): boolean {
  return status === 'flash' || status === 'send';
}

// A flash is one try whatever the row's `tries` says, so the marks and the
// tries number always agree. Imported ticks can carry zero tries: floor at 1.
function triesOf(status: LedgerStatus, tries: number): number {
  return status === 'flash' ? 1 : Math.max(1, tries);
}

type Resolved<T> = { entry: T; status: LedgerStatus; tries: number; timeMs: number; dayKey: string };

function buildSession<T>(dayKey: string, chronological: Resolved<T>[], maxMarks: number): LedgerSession<T> {
  const marks: LedgerTryMark[] = [];
  let totalTries = 0;
  let outcome: LedgerStatus = 'attempt';
  for (const { status, tries } of chronological) {
    totalTries += tries;
    if (status === 'flash') {
      marks.push('flash');
      outcome = 'flash';
      continue;
    }
    const falls = status === 'send' ? tries - 1 : tries;
    for (let fall = 0; fall < falls; fall += 1) marks.push('fall');
    if (status === 'send') {
      marks.push('send');
      if (outcome === 'attempt') outcome = 'send';
    }
  }

  // Trim the OLDEST falls only. A send early in a long day keeps its mark.
  const fallCount = marks.reduce((count, mark) => (mark === 'fall' ? count + 1 : count), 0);
  const overflowTries = Math.max(0, fallCount - Math.max(0, maxMarks));
  let toDrop = overflowTries;
  const keptMarks =
    toDrop === 0
      ? marks
      : marks.filter((mark) => {
          if (mark !== 'fall' || toDrop === 0) return true;
          toDrop -= 1;
          return false;
        });

  return {
    dayKey,
    entries: chronological.map((resolved) => resolved.entry).reverse(),
    totalTries,
    marks: keptMarks,
    overflowTries,
    outcome,
  };
}

/** Difficulty of the newest send that has one, else of the newest entry that has one. */
function personalGradeOf<T extends LogbookEntry>(chronological: Resolved<T>[]): number | null {
  let fallback: number | null = null;
  for (let index = chronological.length - 1; index >= 0; index -= 1) {
    const { entry, status } = chronological[index];
    if (entry.difficulty == null) continue;
    if (isSent(status)) return entry.difficulty;
    fallback ??= entry.difficulty;
  }
  return fallback;
}

function sendVerdict<T extends LogbookEntry>(angle: number, chronological: Resolved<T>[]): ClimbVerdict | null {
  const sends = chronological.filter((resolved) => isSent(resolved.status));
  const newest = sends.at(-1);
  if (!newest) return null;
  // Quote the newest send. A flash last year then a repeat today reads "sent
  // today"; the flash still shows in that angle's header.
  const kind = sends.length === 1 && newest.status === 'flash' ? 'flash' : 'send';
  return { kind, angle, climbedAt: newest.entry.climbed_at };
}

export function deriveClimbLedger<T extends LogbookEntry>(
  entries: readonly T[],
  options: DeriveClimbLedgerOptions<T>,
): ClimbLedger<T> {
  const { currentAngle, statusOf = defaultStatusOf, maxMarksPerSession = DEFAULT_MAX_MARKS_PER_SESSION } = options;

  const chronological: Resolved<T>[] = entries
    .map((entry) => {
      const status = statusOf(entry);
      return {
        entry,
        status,
        tries: triesOf(status, entry.tries),
        timeMs: tickTimeMs(entry.climbed_at),
        dayKey: parseTickTime(entry.climbed_at).format('YYYY-MM-DD'),
      };
    })
    .sort((left, right) => left.timeMs - right.timeMs);

  const byAngle = new Map<number, Resolved<T>[]>();
  for (const resolved of chronological) {
    const bucket = byAngle.get(resolved.entry.angle);
    if (bucket) bucket.push(resolved);
    else byAngle.set(resolved.entry.angle, [resolved]);
  }

  const sections = new Map<number, LedgerAngleSection<T>>();
  for (const [angle, angleEntries] of byAngle) {
    // Map insertion order is first-seen, and `angleEntries` is oldest first, so
    // the keys come out as this angle's sessions in order.
    const byDay = new Map<string, Resolved<T>[]>();
    for (const resolved of angleEntries) {
      const day = byDay.get(resolved.dayKey);
      if (day) day.push(resolved);
      else byDay.set(resolved.dayKey, [resolved]);
    }
    const dayKeys = Array.from(byDay.keys());
    const firstSent = angleEntries.find((resolved) => isSent(resolved.status));
    sections.set(angle, {
      angle,
      totalTries: angleEntries.reduce((sum, resolved) => sum + resolved.tries, 0),
      sessionCount: dayKeys.length,
      sendCount: angleEntries.reduce((count, resolved) => (isSent(resolved.status) ? count + 1 : count), 0),
      firstSend: firstSent
        ? {
            sessionNumber: dayKeys.indexOf(firstSent.dayKey) + 1,
            flash: firstSent.status === 'flash',
            climbedAt: firstSent.entry.climbed_at,
          }
        : null,
      sessions: dayKeys.map((dayKey) => buildSession(dayKey, byDay.get(dayKey) ?? [], maxMarksPerSession)).reverse(),
    });
  }

  const currentSection = sections.get(currentAngle);
  const otherSections = Array.from(sections.values())
    .filter((section) => section.angle !== currentAngle)
    .sort((left, right) => right.angle - left.angle);
  const angles = currentSection ? [currentSection, ...otherSections] : otherSections;

  const currentEntries = byAngle.get(currentAngle);
  const totals: LedgerTotals =
    currentSection && currentEntries
      ? {
          scope: 'angle',
          tries: currentSection.totalTries,
          sessions: currentSection.sessionCount,
          sends: currentSection.sendCount,
          personalGrade: personalGradeOf(currentEntries),
        }
      : {
          scope: 'all',
          tries: chronological.reduce((sum, resolved) => sum + resolved.tries, 0),
          // One day at two angles is still one session.
          sessions: new Set(chronological.map((resolved) => resolved.dayKey)).size,
          sends: chronological.reduce((count, resolved) => (isSent(resolved.status) ? count + 1 : count), 0),
          personalGrade: personalGradeOf(chronological),
        };

  return {
    verdict: deriveVerdict(currentAngle, currentEntries, otherSections, byAngle, chronological),
    totals,
    angles,
  };
}

// Lead with the angle the board is at: a send there, else the last try there.
// Only when the climber has never been on it at this angle does another angle
// speak, steepest send first.
function deriveVerdict<T extends LogbookEntry>(
  currentAngle: number,
  currentEntries: Resolved<T>[] | undefined,
  otherSectionsSteepestFirst: LedgerAngleSection<T>[],
  byAngle: Map<number, Resolved<T>[]>,
  chronological: Resolved<T>[],
): ClimbVerdict {
  if (currentEntries) {
    const sent = sendVerdict(currentAngle, currentEntries);
    if (sent) return sent;
    const newest = currentEntries.at(-1);
    if (newest) return { kind: 'attempt', angle: currentAngle, climbedAt: newest.entry.climbed_at };
  }
  for (const section of otherSectionsSteepestFirst) {
    if (section.sendCount === 0) continue;
    const sent = sendVerdict(section.angle, byAngle.get(section.angle) ?? []);
    if (sent) return sent;
  }
  const newest = chronological.at(-1);
  if (newest) return { kind: 'attempt', angle: newest.entry.angle, climbedAt: newest.entry.climbed_at };
  return { kind: 'untried' };
}

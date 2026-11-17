import dayjs, { type Dayjs } from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import { parseTickTime } from './format-tick-time';

dayjs.extend(isoWeek);

// Home's "This week" card (#7690): the current week's day dots, sessions and
// sends, how many weeks in a row the climber has logged, and one record set
// this week. Weekly, never daily: a rest day costs nothing, and the run only
// ends once a whole week passes with nothing logged.
//
// Weeks are ISO weeks (Monday to Sunday) in the phone's time zone, the same
// grid the activity heatmap draws, so the two never disagree about a day.

/** One logged tick, attempts included. */
export type WeekActivityEntry = {
  climbedAt: string;
  status: 'flash' | 'send' | 'attempt';
  /** The climber's grade, else the climb's consensus. Null when neither is known. */
  difficulty: number | null;
  boardType: string;
};

export type WeekDay = {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Something was logged that day, attempts included. */
  active: boolean;
  isToday: boolean;
  isFuture: boolean;
};

export type WeekRecordKind = 'firstGrade' | 'hardestFlash';

export type WeekRecord<T extends WeekActivityEntry> = {
  /** `firstGrade`: the hardest grade the climber has ever sent. `hardestFlash`: the same, for flashes. */
  kind: WeekRecordKind;
  entry: T;
};

export type WeekSummary<T extends WeekActivityEntry> = {
  /** Monday, `YYYY-MM-DD`. */
  weekStart: string;
  /** Sunday, `YYYY-MM-DD`. */
  weekEnd: string;
  /** Monday to Sunday. */
  days: WeekDay[];
  /** Days this week with something logged. One day is one session. */
  sessions: number;
  /** Flashes and sends this week. */
  sends: number;
  /** The hardest graded send this week, the latest one on a tie. */
  hardestSend: T | null;
  /**
   * Weeks in a row with a session, counting this week when it has one. A week
   * still under way never breaks the run: until it ends, the run counts back
   * from last week.
   */
  weeksRunning: number;
  /** At most one record set this week; a new top grade wins over a flash. */
  record: WeekRecord<T> | null;
  /** True when nothing at all is logged. */
  isEmpty: boolean;
  /** True when something is logged, but nothing in the last 28 days. */
  isDormant: boolean;
};

export type BuildWeekSummaryOptions = {
  /** Defaults to now. Pass a fixed day for deterministic tests and screenshots. */
  today?: Dayjs;
  /**
   * The label a grade renders as, such as `V6`. Two difficulties with the same
   * label are the same grade to the climber: a send one step harder that still
   * reads V6 is not a "first V6". Defaults to the number itself.
   */
  gradeLabel?: (difficulty: number, boardType: string) => string | null;
};

const DORMANT_DAYS = 28;

function isSend(entry: WeekActivityEntry): boolean {
  return entry.status === 'flash' || entry.status === 'send';
}

/** An entry with its time parsed once: a heavy logbook holds tens of thousands. */
type Parsed<T> = { entry: T; climbedMs: number };

function hardestOf<T extends WeekActivityEntry>(entries: readonly Parsed<T>[], keep: (entry: T) => boolean): T | null {
  let hardest: T | null = null;
  let hardestMs = 0;
  for (const { entry, climbedMs } of entries) {
    if (entry.difficulty === null || !keep(entry)) continue;
    if (
      hardest === null ||
      entry.difficulty > (hardest.difficulty ?? -Infinity) ||
      (entry.difficulty === hardest.difficulty && climbedMs > hardestMs)
    ) {
      hardest = entry;
      hardestMs = climbedMs;
    }
  }
  return hardest;
}

/**
 * Whether `candidate` (this week) beats everything in `before`. With no graded
 * history it is a first only when `firstCounts` says so.
 */
function isNewTop<T extends WeekActivityEntry>(
  candidate: T | null,
  previousTop: T | null,
  firstCounts: boolean,
  gradeLabel: (difficulty: number, boardType: string) => string | null,
): candidate is T {
  if (candidate === null || candidate.difficulty === null) return false;
  if (previousTop === null || previousTop.difficulty === null) return firstCounts;
  if (candidate.difficulty <= previousTop.difficulty) return false;
  const candidateLabel = gradeLabel(candidate.difficulty, candidate.boardType);
  return candidateLabel !== null && candidateLabel !== gradeLabel(previousTop.difficulty, previousTop.boardType);
}

const numberLabel = (difficulty: number): string => String(difficulty);

export function buildWeekSummary<T extends WeekActivityEntry>(
  entries: readonly T[],
  { today = dayjs(), gradeLabel = numberLabel }: BuildWeekSummaryOptions = {},
): WeekSummary<T> {
  const weekStart = today.startOf('isoWeek');
  const weekEnd = today.endOf('isoWeek');
  const weekStartKey = weekStart.format('YYYY-MM-DD');
  const todayKey = today.format('YYYY-MM-DD');

  const activeDays = new Set<string>();
  const thisWeek: Parsed<T>[] = [];
  const before: Parsed<T>[] = [];
  let latestDay: string | null = null;
  for (const entry of entries) {
    const climbedAt = parseTickTime(entry.climbedAt);
    // A tick dated after today (a phone clock that was ahead) counts as today's,
    // so the dots, the totals and the record always agree.
    const parsedDay = climbedAt.format('YYYY-MM-DD');
    const day = parsedDay > todayKey ? todayKey : parsedDay;
    activeDays.add(day);
    if (latestDay === null || day > latestDay) latestDay = day;
    const parsed = { entry, climbedMs: climbedAt.valueOf() };
    if (day >= weekStartKey) thisWeek.push(parsed);
    else before.push(parsed);
  }

  const days: WeekDay[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = weekStart.add(offset, 'day').format('YYYY-MM-DD');
    days.push({ date, active: activeDays.has(date), isToday: date === todayKey, isFuture: date > todayKey });
  }

  // Weeks with a session, by their Monday.
  const activeWeeks = new Set<string>();
  for (const day of activeDays) activeWeeks.add(dayjs(day).startOf('isoWeek').format('YYYY-MM-DD'));
  let weeksRunning = 0;
  let cursor = activeWeeks.has(weekStartKey) ? weekStart : weekStart.subtract(1, 'week');
  while (activeWeeks.has(cursor.format('YYYY-MM-DD'))) {
    weeksRunning += 1;
    cursor = cursor.subtract(1, 'week');
  }

  const sends = thisWeek.filter(({ entry }) => isSend(entry)).length;
  const hardestSend = hardestOf(thisWeek, isSend);
  const isFlash = (entry: T) => entry.status === 'flash';

  let record: WeekRecord<T> | null = null;
  // A climber's very first graded send is a first; a first flash with no
  // earlier flash is not a record worth a line.
  if (isNewTop(hardestSend, hardestOf(before, isSend), true, gradeLabel)) {
    record = { kind: 'firstGrade', entry: hardestSend };
  } else {
    const hardestFlash = hardestOf(thisWeek, isFlash);
    if (isNewTop(hardestFlash, hardestOf(before, isFlash), false, gradeLabel)) {
      record = { kind: 'hardestFlash', entry: hardestFlash };
    }
  }

  const dormantCutoff = today.subtract(DORMANT_DAYS - 1, 'day').format('YYYY-MM-DD');
  return {
    weekStart: weekStartKey,
    weekEnd: weekEnd.format('YYYY-MM-DD'),
    days,
    sessions: days.filter((day) => day.active).length,
    sends,
    hardestSend,
    weeksRunning,
    record,
    isEmpty: entries.length === 0,
    isDormant: latestDay !== null && latestDay < dormantCutoff,
  };
}

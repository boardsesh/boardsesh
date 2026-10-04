// Pure shaping for the play drawer's "Climber logs" card and its full list:
// other climbers' logs on one climb, folded to one row per climber. No React
// and no I/O, so the card, the sheet and the collapsed Logbook line all read
// the same numbers.
//
// Three rules hold the whole file together:
//   1. Counts come from the server's `summary`, never from `items.length`. The
//      rows are the 100 newest logs; the counts cover every log.
//   2. Filters run on LOGS, then the caller groups. "40° only" must re-pick each
//      climber's lead log at that angle, not hide climbers whose best log sat
//      at another one.
//   3. A log with nothing to add gets no row. A log is "bare" when it has no
//      note and its grade does not disagree with the climb's. Bare climbers
//      share a line on the card and sit two to a line in the full list.
import { parseTickTime, tickTimeMs } from '@boardsesh/profile-stats';
import type { FollowingClimbAscentsSummary } from '@boardsesh/shared-schema';

/**
 * One log by another climber. The explicit field list (no votes, no comment
 * count) is what both the followed-climbers query and the everyone query
 * return, so either item type is assignable.
 */
export type ClimberLog = {
  uuid: string;
  userId: string;
  userDisplayName?: string | null;
  userAvatarUrl?: string | null;
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  status: string;
  attemptCount: number;
  quality?: number | null;
  effectiveQuality?: number | null;
  difficulty?: number | null;
  comment: string;
  climbedAt: string;
};

/**
 * One climber's logs on the climb. Three things are read from them, each from
 * the log that carries it, so a row never says "no send" for a climber who sent:
 * how it went and when (`lead`), their note (`note`), and a grade they disagree
 * on (`disagreeingGradeId`).
 */
export type ClimberLogGroup = {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** Their best log: a send over a no-send, then the board's angle, then the newest. The row's result and time. */
  lead: ClimberLog;
  /** Every other log by this climber, newest first. */
  earlier: ClimberLog[];
  earlierTries: number;
  /** Distinct local calendar days the earlier logs fall on. */
  earlierDays: number;
  /** The note on their newest log that has one, trimmed. It may sit on another log than `lead`. */
  note: string | null;
  hasNote: boolean;
  /** `lead` is at the board's angle. */
  atBoardAngle: boolean;
  /** The grade on their newest log that disagrees with the climb's, or null. */
  disagreeingGradeId: number | null;
  gradeDisagrees: boolean;
  /** Any of their logs is a send or a flash (so `lead` is one). */
  sent: boolean;
  /** No log of theirs has a note or a disagreeing grade: no row for this climber. */
  bare: boolean;
};

export type ClimberLogFilters = { angleOnly: boolean; withNotes: boolean; sendsOnly: boolean };

export type ClimberLogSectionId = 'following' | 'everyone';

/**
 * `count` is the server's number for the header, or null when it has none to
 * give. `capped` says the groups were built from a list the server cut short:
 * a climber's earlier logs and the size of a bare block would both be wrong, so
 * neither is offered.
 */
export type ClimberLogSection = {
  id: ClimberLogSectionId;
  groups: ClimberLogGroup[];
  count: number | null;
  capped?: boolean;
};

export type ClimberLogNotice = { notice: 'capped' | 'otherAngles'; count: number };

export type ClimberLogListItem =
  | { kind: 'header'; key: string; section: ClimberLogSectionId; count: number | null }
  | { kind: 'group'; key: string; section: ClimberLogSectionId; group: ClimberLogGroup }
  | { kind: 'bareHeader'; key: string; section: ClimberLogSectionId; result: BareResult; count: number | null }
  | { kind: 'bare'; key: string; section: ClimberLogSectionId; groups: ClimberLogGroup[]; wide: boolean }
  | { kind: 'earlier'; key: string; log: ClimberLog }
  | { kind: 'earlierFold'; key: string; angle: number; count: number }
  | { kind: 'notice'; key: string; notice: 'capped' | 'otherAngles'; count: number };

export type BareResult = 'sent' | 'tried';

/** One line of a climber's earlier logs: a log worth its own line, or a fold of plain repeats. */
export type EarlierLogLine = { kind: 'log'; log: ClimberLog } | { kind: 'fold'; angle: number; count: number };

export type ClimberLogListOptions = {
  /** Bare climbers to a line. One at large text sizes. */
  columns: 1 | 2;
  boardAngle: number;
  climbGradeId: number | null;
};

/** What the card shows, in order: rows, then the two shared lines. */
export type ClimberLogsCardPlan = {
  rows: ClimberLogGroup[];
  bareSent: ClimberLogGroup[];
  bareTried: ClimberLogGroup[];
};

/** The names on one shared line of the card. A null name is a climber with none set. */
export type BareNames = {
  names: (string | null)[];
  /** Climbers past the named ones. Zero when there are none, or when the number is not known. */
  extra: number;
  /** There are more climbers than named, and how many is not known. */
  andMore: boolean;
};

export type ClimberLogResult = { kind: 'flash' } | { kind: 'sent'; tries: number } | { kind: 'noSend'; tries: number };

export type CrewCounts = {
  climbers: number;
  senders: number;
  climbersAtAngle: number;
  sendersAtAngle: number;
};

/**
 * Rows the card shows inline. The play drawer body is a plain ScrollView, so
 * this cap is what keeps the card's `.map()` legal (docs/react-native-performance.md
 * section 2). The full list lives in a virtualised sheet.
 */
export const INLINE_CLIMBER_LOG_CAP = 4;

const MAX_TALLY_GRADES = 2;
/** Names on one shared line of the card; the rest are "+N". */
const BARE_NAME_CAP = 2;
/** Plain one-try sends at one angle fold into a single line from this many up. */
const FOLD_MIN = 3;

/**
 * A sorted copy. Not `Array.prototype.toSorted`: Hermes, the engine the app
 * runs on, does not have it, so it throws "undefined is not a function" on a
 * phone while passing every test (Node has it).
 */
function sorted<Item>(items: readonly Item[], compare: (first: Item, second: Item) => number): Item[] {
  return [...items].sort(compare);
}

function isSent(log: ClimberLog): boolean {
  return log.status === 'flash' || log.status === 'send';
}

function hasNote(log: ClimberLog): boolean {
  return log.comment.trim().length > 0;
}

/** Imported ticks can carry 0 tries; a log is always at least one try. */
function triesOf(log: ClimberLog): number {
  return Math.max(1, log.attemptCount);
}

function newestFirst(first: ClimberLog, second: ClimberLog): number {
  return tickTimeMs(second.climbedAt) - tickTimeMs(first.climbedAt) || second.uuid.localeCompare(first.uuid);
}

/**
 * True when the log carries a grade, at the board's angle, that is not the
 * climb's. A grade given at another angle never counts: the caller only knows
 * the climb's grade at the board's angle. With no climb grade to compare
 * against (`climbGradeId` null), any grade at the board's angle counts, so it
 * is shown rather than dropped.
 */
export function gradeDisagrees(log: ClimberLog, boardAngle: number, climbGradeId: number | null): boolean {
  return log.angle === boardAngle && log.difficulty != null && log.difficulty !== climbGradeId;
}

/** Nothing to add: no note, and no grade that disagrees. Stars never count. */
export function isBareLog(log: ClimberLog, boardAngle: number, climbGradeId: number | null): boolean {
  return !hasNote(log) && !gradeDisagrees(log, boardAngle, climbGradeId);
}

/**
 * Lead order: a send over a no-send, then the board's angle, then the newest.
 * A send always wins, so a climber who sent it never reads as "no send" and
 * never pools under "Tried, no send", whatever else they logged.
 */
function leadFirst(boardAngle: number) {
  return (first: ClimberLog, second: ClimberLog): number =>
    Number(isSent(second)) - Number(isSent(first)) ||
    Number(second.angle === boardAngle) - Number(first.angle === boardAngle) ||
    newestFirst(first, second);
}

/** One group per climber, in first-seen order. Rank with `rankClimberLogGroups`. */
export function groupClimberLogs(
  logs: readonly ClimberLog[],
  boardAngle: number,
  climbGradeId: number | null,
): ClimberLogGroup[] {
  const logsByUser = new Map<string, ClimberLog[]>();
  for (const log of logs) {
    const existing = logsByUser.get(log.userId);
    if (existing) existing.push(log);
    else logsByUser.set(log.userId, [log]);
  }

  const groups: ClimberLogGroup[] = [];
  for (const [userId, userLogs] of logsByUser) {
    const [lead, ...rest] = sorted(userLogs, leadFirst(boardAngle));
    const earlier = sorted(rest, newestFirst);
    const newest = sorted(userLogs, newestFirst);
    const note = newest.find(hasNote)?.comment.trim() ?? null;
    const disagreeingGradeId = newest.find((log) => gradeDisagrees(log, boardAngle, climbGradeId))?.difficulty ?? null;
    const named = userLogs.find((log) => log.userDisplayName);
    const pictured = userLogs.find((log) => log.userAvatarUrl);
    groups.push({
      userId,
      displayName: named?.userDisplayName ?? null,
      avatarUrl: pictured?.userAvatarUrl ?? null,
      lead,
      earlier,
      earlierTries: earlier.reduce((total, log) => total + triesOf(log), 0),
      earlierDays: new Set(earlier.map((log) => parseTickTime(log.climbedAt).format('YYYY-MM-DD'))).size,
      note,
      hasNote: note !== null,
      atBoardAngle: lead.angle === boardAngle,
      disagreeingGradeId,
      gradeDisagrees: disagreeingGradeId !== null,
      sent: isSent(lead),
      bare: note === null && disagreeingGradeId === null,
    });
  }
  return groups;
}

/** Notes first, then a disagreeing grade, then the board's angle, then the newest lead; ties by user id. */
export function rankClimberLogGroups(groups: readonly ClimberLogGroup[]): ClimberLogGroup[] {
  return sorted(
    groups,
    (first, second) =>
      Number(second.hasNote) - Number(first.hasNote) ||
      Number(second.gradeDisagrees) - Number(first.gradeDisagrees) ||
      Number(second.atBoardAngle) - Number(first.atBoardAngle) ||
      tickTimeMs(second.lead.climbedAt) - tickTimeMs(first.lead.climbedAt) ||
      first.userId.localeCompare(second.userId),
  );
}

export function takeInlineGroups(groups: readonly ClimberLogGroup[]): ClimberLogGroup[] {
  return groups.slice(0, INLINE_CLIMBER_LOG_CAP);
}

/**
 * Splits climbers into those who get a row and the two pools that share a
 * line: bare climbers who sent, and bare climbers who did not. Order is kept.
 */
export function partitionClimberLogGroups(groups: readonly ClimberLogGroup[]): {
  loud: ClimberLogGroup[];
  bareSent: ClimberLogGroup[];
  bareTried: ClimberLogGroup[];
} {
  const loud: ClimberLogGroup[] = [];
  const bareSent: ClimberLogGroup[] = [];
  const bareTried: ClimberLogGroup[] = [];
  for (const group of groups) {
    if (!group.bare) loud.push(group);
    else if (group.sent) bareSent.push(group);
    else bareTried.push(group);
  }
  return { loud, bareSent, bareTried };
}

/**
 * What the card shows for the climbers the viewer follows, from ranked groups:
 * the first `INLINE_CLIMBER_LOG_CAP` climbers with something to say get the
 * rows, and every bare climber stays on the card in one of the two shared
 * lines. A bare climber is never dropped to make room for a row.
 */
export function planClimberLogsCard(followed: readonly ClimberLogGroup[]): ClimberLogsCardPlan {
  const { loud, bareSent, bareTried } = partitionClimberLogGroups(followed);
  return { rows: takeInlineGroups(loud), bareSent, bareTried };
}

/**
 * The names for one shared line of the card: two at most. `complete` says the
 * groups are every climber there is; only then is the rest a number.
 */
export function describeBareNames(groups: readonly ClimberLogGroup[], complete: boolean): BareNames {
  const names = groups.slice(0, BARE_NAME_CAP).map((group) => group.displayName);
  const rest = groups.length - names.length;
  return { names, extra: complete ? rest : 0, andMore: !complete && rest > 0 };
}

/**
 * Who graded the climb differently: each climber counts once, with the grade on
 * their newest disagreeing log. Most common first, two grades at most. Empty
 * when everybody who graded it agrees with the climb.
 */
export function tallyDisagreeingGrades(groups: readonly ClimberLogGroup[]): { difficultyId: number; count: number }[] {
  const countByGrade = new Map<number, number>();
  for (const { disagreeingGradeId } of groups) {
    if (disagreeingGradeId === null) continue;
    countByGrade.set(disagreeingGradeId, (countByGrade.get(disagreeingGradeId) ?? 0) + 1);
  }
  return sorted(
    [...countByGrade].map(([difficultyId, count]) => ({ difficultyId, count })),
    (first, second) => second.count - first.count || first.difficultyId - second.difficultyId,
  ).slice(0, MAX_TALLY_GRADES);
}

export function filterClimberLogs(
  logs: readonly ClimberLog[],
  boardAngle: number,
  filters: ClimberLogFilters,
): ClimberLog[] {
  return logs.filter(
    (log) =>
      (!filters.angleOnly || log.angle === boardAngle) &&
      (!filters.withNotes || hasNote(log)) &&
      (!filters.sendsOnly || isSent(log)),
  );
}

/**
 * A climber's earlier logs as lines. A log keeps its own line for a note, a
 * disagreeing grade, a no-send, or more than one try. One-try sends with
 * nothing else fold into one line per angle once there are three of them; the
 * folds come last, the board's angle first.
 */
export function foldEarlierLogs(
  earlier: readonly ClimberLog[],
  boardAngle: number,
  climbGradeId: number | null,
): EarlierLogLine[] {
  const isPlainRepeat = (log: ClimberLog) =>
    isSent(log) && triesOf(log) === 1 && isBareLog(log, boardAngle, climbGradeId);
  const repeatsByAngle = new Map<number, number>();
  for (const log of earlier) {
    if (isPlainRepeat(log)) repeatsByAngle.set(log.angle, (repeatsByAngle.get(log.angle) ?? 0) + 1);
  }
  const folds = sorted(
    [...repeatsByAngle].filter(([, count]) => count >= FOLD_MIN),
    ([firstAngle], [secondAngle]) =>
      Number(secondAngle === boardAngle) - Number(firstAngle === boardAngle) || firstAngle - secondAngle,
  );
  const foldedAngles = new Set(folds.map(([angle]) => angle));

  const lines: EarlierLogLine[] = [];
  for (const log of earlier) {
    if (isPlainRepeat(log) && foldedAngles.has(log.angle)) continue;
    lines.push({ kind: 'log', log });
  }
  for (const [angle, count] of folds) lines.push({ kind: 'fold', angle, count });
  return lines;
}

const SECTION_ORDER: Record<ClimberLogSectionId, number> = { following: 0, everyone: 1 };

/**
 * The flat array the full list virtualises. A section with no groups emits
 * nothing, not even its header, so an empty result is an empty array and the
 * list's own empty state shows. Notices describe the Following result (the
 * cap, the logs at other angles), so they sit right under its rows. When the
 * chips leave Following with no rows but a notice remains, the header still
 * shows, so "3 more at other angles" never floats with nothing above it.
 *
 * Following always comes before Everyone, whatever order the caller passed,
 * and a climber listed under Following is never repeated under Everyone.
 *
 * Inside Following, climbers with something to say come first, then the bare
 * ones in two blocks ("Also sent", "Tried, no send"). Everyone keeps the
 * server's order, because the next page has to land under this one; bare
 * climbers next to each other share a line.
 */
export function buildClimberLogListItems(
  sections: readonly ClimberLogSection[],
  expandedUserIds: ReadonlySet<string>,
  notices: readonly ClimberLogNotice[],
  options: ClimberLogListOptions,
): ClimberLogListItem[] {
  const items: ClimberLogListItem[] = [];
  const noticeItems: ClimberLogListItem[] = notices.map(({ notice, count }) => ({
    kind: 'notice',
    key: `notice:${notice}`,
    notice,
    count,
  }));
  const ordered = sorted(sections, (first, second) => SECTION_ORDER[first.id] - SECTION_ORDER[second.id]);
  const listedUserIds = new Set<string>();

  const pushEarlier = (section: ClimberLogSection, group: ClimberLogGroup) => {
    if (section.capped || !expandedUserIds.has(group.userId)) return;
    for (const line of foldEarlierLogs(group.earlier, options.boardAngle, options.climbGradeId)) {
      items.push(
        line.kind === 'log'
          ? { kind: 'earlier', key: `earlier:${line.log.uuid}`, log: line.log }
          : {
              kind: 'earlierFold',
              key: `earlierFold:${group.userId}:${line.angle}`,
              angle: line.angle,
              count: line.count,
            },
      );
    }
  };
  const pushBare = (section: ClimberLogSection, groups: ClimberLogGroup[], wide: boolean) => {
    items.push({ kind: 'bare', key: `bare:${section.id}:${groups[0].userId}`, section: section.id, groups, wide });
  };
  /** Bare climbers with no earlier logs to offer, `columns` to a line. */
  const pushBareCells = (section: ClimberLogSection, groups: readonly ClimberLogGroup[]) => {
    for (let index = 0; index < groups.length; index += options.columns) {
      pushBare(section, groups.slice(index, index + options.columns), false);
    }
  };
  /** A climber with earlier logs takes the whole line, so the way into them fits beside the name. */
  const takesLine = (section: ClimberLogSection, group: ClimberLogGroup) => !section.capped && group.earlier.length > 0;
  const pushBareBlock = (section: ClimberLogSection, result: BareResult, groups: readonly ClimberLogGroup[]) => {
    if (groups.length === 0) return;
    items.push({
      kind: 'bareHeader',
      key: `bareHeader:${section.id}:${result}`,
      section: section.id,
      result,
      count: section.capped ? null : groups.length,
    });
    for (const group of groups) {
      if (!takesLine(section, group)) continue;
      pushBare(section, [group], true);
      pushEarlier(section, group);
    }
    pushBareCells(
      section,
      groups.filter((group) => !takesLine(section, group)),
    );
  };

  for (const section of ordered) {
    const groups = section.groups.filter((group) => !listedUserIds.has(group.userId));
    const ownsNotices = section.id === 'following' && noticeItems.length > 0;
    if (groups.length > 0 || ownsNotices) {
      items.push({ kind: 'header', key: `header:${section.id}`, section: section.id, count: section.count });
    }
    if (groups.length > 0) {
      if (section.id === 'following') {
        const { loud, bareSent, bareTried } = partitionClimberLogGroups(groups);
        for (const group of loud) {
          items.push({ kind: 'group', key: `${section.id}:${group.userId}`, section: section.id, group });
          pushEarlier(section, group);
        }
        pushBareBlock(section, 'sent', bareSent);
        pushBareBlock(section, 'tried', bareTried);
      } else {
        let run: ClimberLogGroup[] = [];
        const flush = () => {
          pushBareCells(section, run);
          run = [];
        };
        for (const group of groups) {
          if (group.bare) {
            run.push(group);
            continue;
          }
          flush();
          items.push({ kind: 'group', key: `${section.id}:${group.userId}`, section: section.id, group });
        }
        flush();
      }
      for (const group of groups) listedUserIds.add(group.userId);
    }
    if (ownsNotices) items.push(...noticeItems);
  }
  return items;
}

export function describeResult(log: ClimberLog): ClimberLogResult {
  if (log.status === 'flash') return { kind: 'flash' };
  return { kind: log.status === 'send' ? 'sent' : 'noSend', tries: triesOf(log) };
}

/**
 * The server's counts for the climbers the viewer follows, read for the board's
 * angle. Null while there is no answer and when nobody followed has logged the
 * climb, so callers can drop the crew mention with one check.
 */
export function deriveCrewCounts(
  result: { summary: FollowingClimbAscentsSummary } | undefined,
  boardAngle: number,
): CrewCounts | null {
  if (!result || result.summary.climberCount === 0) return null;
  const atAngle = result.summary.byAngle.find((entry) => entry.angle === boardAngle);
  return {
    climbers: result.summary.climberCount,
    senders: result.summary.senderCount,
    climbersAtAngle: atAngle?.climberCount ?? 0,
    sendersAtAngle: atAngle?.senderCount ?? 0,
  };
}

/**
 * The number for the Following header under the current chips. The server has
 * no count for "with notes", so that chip drops the number instead of showing a
 * row count that the 100-log cap could make wrong.
 */
export function followingSectionCount(counts: CrewCounts | null, filters: ClimberLogFilters): number | null {
  if (!counts || filters.withNotes) return null;
  if (filters.sendsOnly) return filters.angleOnly ? counts.sendersAtAngle : counts.senders;
  return filters.angleOnly ? counts.climbersAtAngle : counts.climbers;
}

/**
 * How many more climbers turning "this angle only" off would add, under the
 * other chips. Each side of the subtraction counts a climber once, so the
 * difference is exactly the climbers whose matching logs all sit at other
 * angles. Zero means there is nothing to offer, and "with notes" always answers
 * zero: the server has no count for it, and a number that a tap does not
 * deliver is worse than no notice.
 */
export function otherAnglesNoticeCount(counts: CrewCounts | null, filters: ClimberLogFilters): number {
  if (!counts || !filters.angleOnly || filters.withNotes) return 0;
  const elsewhere = filters.sendsOnly
    ? counts.senders - counts.sendersAtAngle
    : counts.climbers - counts.climbersAtAngle;
  return Math.max(0, elsewhere);
}

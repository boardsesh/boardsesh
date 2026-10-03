// Pure shaping for the play drawer's "Climber logs" card and its full list:
// other climbers' logs on one climb, folded to one row per climber. No React
// and no I/O, so the card, the sheet and the collapsed Logbook line all read
// the same numbers.
//
// Two rules hold the whole file together:
//   1. Counts come from the server's `summary`, never from `items.length`. The
//      rows are the 100 newest logs; the counts cover every log.
//   2. Filters run on LOGS, then the caller groups. "40° only" must re-pick each
//      climber's lead log at that angle, not hide climbers whose best log sat
//      at another one.
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

/** One climber's logs on the climb: the most useful one leads, the rest wait behind it. */
export type ClimberLogGroup = {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  lead: ClimberLog;
  /** Every other log by this climber, newest first. */
  earlier: ClimberLog[];
  earlierTries: number;
  /** Distinct local calendar days the earlier logs fall on. */
  earlierDays: number;
  hasNote: boolean;
  atBoardAngle: boolean;
};

export type ClimberLogFilters = { angleOnly: boolean; withNotes: boolean; sendsOnly: boolean };

export type ClimberLogSectionId = 'following' | 'everyone';

/** `count` is the server's number for the header, or null when it has none to give. */
export type ClimberLogSection = { id: ClimberLogSectionId; groups: ClimberLogGroup[]; count: number | null };

export type ClimberLogNotice = { notice: 'capped' | 'otherAngles'; count: number };

export type ClimberLogListItem =
  | { kind: 'header'; key: string; section: ClimberLogSectionId; count: number | null }
  | { kind: 'group'; key: string; section: ClimberLogSectionId; group: ClimberLogGroup }
  | { kind: 'earlier'; key: string; log: ClimberLog }
  | { kind: 'notice'; key: string; notice: 'capped' | 'otherAngles'; count: number };

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

const MAX_TALLY_GRADES = 3;

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

/** Lead order: a note, then the board's angle, then a send, then the newest. */
function leadFirst(boardAngle: number) {
  return (first: ClimberLog, second: ClimberLog): number =>
    Number(hasNote(second)) - Number(hasNote(first)) ||
    Number(second.angle === boardAngle) - Number(first.angle === boardAngle) ||
    Number(isSent(second)) - Number(isSent(first)) ||
    newestFirst(first, second);
}

/** One group per climber, in first-seen order. Rank with `rankClimberLogGroups`. */
export function groupClimberLogs(logs: readonly ClimberLog[], boardAngle: number): ClimberLogGroup[] {
  const logsByUser = new Map<string, ClimberLog[]>();
  for (const log of logs) {
    const existing = logsByUser.get(log.userId);
    if (existing) existing.push(log);
    else logsByUser.set(log.userId, [log]);
  }

  const groups: ClimberLogGroup[] = [];
  for (const [userId, userLogs] of logsByUser) {
    const [lead, ...rest] = userLogs.toSorted(leadFirst(boardAngle));
    const earlier = rest.toSorted(newestFirst);
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
      hasNote: hasNote(lead),
      atBoardAngle: lead.angle === boardAngle,
    });
  }
  return groups;
}

/** Notes first, then the board's angle, then the newest lead; ties by user id. */
export function rankClimberLogGroups(groups: readonly ClimberLogGroup[]): ClimberLogGroup[] {
  return groups.toSorted(
    (first, second) =>
      Number(second.hasNote) - Number(first.hasNote) ||
      Number(second.atBoardAngle) - Number(first.atBoardAngle) ||
      tickTimeMs(second.lead.climbedAt) - tickTimeMs(first.lead.climbedAt) ||
      first.userId.localeCompare(second.userId),
  );
}

export function takeInlineGroups(groups: readonly ClimberLogGroup[]): ClimberLogGroup[] {
  return groups.slice(0, INLINE_CLIMBER_LOG_CAP);
}

/**
 * How the group graded the climb: each climber counts once, with the grade on
 * their newest graded log. Most common first, three grades at most.
 */
export function tallyGivenGrades(groups: readonly ClimberLogGroup[]): { difficultyId: number; count: number }[] {
  const countByGrade = new Map<number, number>();
  for (const group of groups) {
    const newestGraded = [group.lead, ...group.earlier].toSorted(newestFirst).find((log) => log.difficulty != null);
    const difficultyId = newestGraded?.difficulty;
    if (difficultyId == null) continue;
    countByGrade.set(difficultyId, (countByGrade.get(difficultyId) ?? 0) + 1);
  }
  return [...countByGrade]
    .map(([difficultyId, count]) => ({ difficultyId, count }))
    .toSorted((first, second) => second.count - first.count || first.difficultyId - second.difficultyId)
    .slice(0, MAX_TALLY_GRADES);
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
 * The flat array the full list virtualises. A section with no groups emits
 * nothing, not even its header, so an empty result is an empty array and the
 * list's own empty state shows. Notices describe the first section's result
 * (the cap, the logs at other angles), so they sit right under its rows.
 */
export function buildClimberLogListItems(
  sections: readonly ClimberLogSection[],
  expandedUserIds: ReadonlySet<string>,
  notices: readonly ClimberLogNotice[],
): ClimberLogListItem[] {
  const items: ClimberLogListItem[] = [];
  const noticeItems: ClimberLogListItem[] = notices.map(({ notice, count }) => ({
    kind: 'notice',
    key: `notice:${notice}`,
    notice,
    count,
  }));

  sections.forEach((section, sectionIndex) => {
    if (section.groups.length > 0) {
      items.push({ kind: 'header', key: `header:${section.id}`, section: section.id, count: section.count });
      for (const group of section.groups) {
        items.push({ kind: 'group', key: `${section.id}:${group.userId}`, section: section.id, group });
        if (!expandedUserIds.has(group.userId)) continue;
        for (const log of group.earlier) items.push({ kind: 'earlier', key: `earlier:${log.uuid}`, log });
      }
    }
    if (sectionIndex === 0) items.push(...noticeItems);
  });
  if (sections.length === 0) items.push(...noticeItems);
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

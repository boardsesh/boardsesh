import 'server-only';
import { cache } from 'react';
import { parseBoardPath, parseNamedBoardPath } from '@boardsesh/board-config';
import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';
import { BOULDER_GRADES } from '@/app/lib/board-data';
import { executeGraphQLInternal } from '@/app/lib/graphql/server-cached-client';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { buildOgVersionToken } from './og';
import { buildOgContentVersion } from './og-family';

// Public previews use the same anonymous backend authorization as public reads,
// and the same documents the backend's share cards read, so a page's words and
// the card it advertises describe the same data. React cache deduplicates only
// within this request; no authorization survives it.

/** A grade as the cards print it (`7b/V8`), or null when this board has no such grade. */
export function formatCardGrade(boardType: string, difficulty: number | null | undefined): string | null {
  if (difficulty === null || difficulty === undefined) return null;
  const grade = getBoulderGradesForBoard(boardType).find((candidate) => candidate.difficulty_id === difficulty);
  return grade ? `${grade.font_grade}/${grade.v_grade}` : null;
}

export type ProfileOgSummary = {
  /** Null when the climber has no display name; the page supplies its own fallback. */
  displayName: string | null;
  /**
   * Board this climber has sent the most distinct climbs on, or null when they
   * have none. Drives the search-first page title ("Marco's Kilter Sessions").
   */
  topBoardType: string | null;
  /** The hardest send a stranger may see, or null when there is none to name. */
  hardestSend: { climbName: string; grade: string | null } | null;
  /** Distinct climbs sent, hidden climbs included, as the public profile counts them. */
  sentClimbCount: number;
  /** Boards with at least one send, most sends first. */
  sentBoardTypes: string[];
  version: string;
};

type ProfileStatsRead = {
  totalDistinctClimbs: number;
  layoutStats: Array<{
    boardType: string;
    distinctClimbCount: number;
    gradeCounts: Array<{ grade: string; count: number }>;
  }>;
};

type HardestSendRead = {
  climbUuid: string;
  climbName: string;
  boardType: string;
  difficulty: number | null;
  consensusDifficulty: number | null;
};

export const getProfileOgSummary = cache(async (userId: string): Promise<ProfileOgSummary | null> => {
  const { publicProfile } = await executeGraphQLInternal<{
    publicProfile: {
      displayName: string | null;
      avatarUrl: string | null;
      isPrivate: boolean;
    } | null;
  }>(
    `query ProfilePreview($userId: ID!) {
    publicProfile(userId: $userId) { displayName avatarUrl isPrivate }
  }`,
    { userId },
  );
  // A private account stops here, before any activity is read.
  if (!publicProfile || publicProfile.isPrivate) return null;

  // The card's own reads: `userProfileStats` takes a tick's grade from the
  // consensus when the climber logged none, and `userAscentsFeed` applies tick
  // privacy, spray visibility and the community-hidden filter.
  const { userProfileStats, userAscentsFeed } = await executeGraphQLInternal<{
    userProfileStats: ProfileStatsRead;
    userAscentsFeed: { items: HardestSendRead[] };
  }>(
    `query ProfilePreviewActivity($userId: ID!, $input: AscentFeedInput) {
    userProfileStats(userId: $userId) {
      totalDistinctClimbs
      layoutStats { boardType distinctClimbCount gradeCounts { grade count } }
    }
    userAscentsFeed(userId: $userId, input: $input) {
      items { climbUuid climbName boardType difficulty consensusDifficulty }
    }
  }`,
    { userId, input: { limit: 1, sortBy: 'hardest', statusMode: 'send', excludeHiddenClimbs: true } },
  );

  const sendsByBoard = new Map<string, number>();
  for (const layout of userProfileStats.layoutStats) {
    if (layout.distinctClimbCount <= 0) continue;
    sendsByBoard.set(layout.boardType, (sendsByBoard.get(layout.boardType) ?? 0) + layout.distinctClimbCount);
  }
  const sentBoardTypes = [...sendsByBoard].sort((first, second) => second[1] - first[1]).map(([board]) => board);

  const hardest = userAscentsFeed.items[0] ?? null;
  // The logged grade, falling back to consensus only when nothing was logged:
  // the same rule the card's hero uses.
  let hardestDifficulty: number | null = null;
  if (hardest) {
    hardestDifficulty =
      hardest.difficulty ?? (hardest.consensusDifficulty === null ? null : Math.round(hardest.consensusDifficulty));
  }

  return {
    displayName: publicProfile.displayName?.trim() || null,
    topBoardType: sentBoardTypes[0] ?? null,
    hardestSend: hardest
      ? { climbName: hardest.climbName, grade: formatCardGrade(hardest.boardType, hardestDifficulty) }
      : null,
    sentClimbCount: userProfileStats.totalDistinctClimbs,
    sentBoardTypes,
    version: buildOgContentVersion(
      publicProfile.displayName,
      publicProfile.avatarUrl,
      userProfileStats,
      hardest?.climbUuid ?? null,
      hardestDifficulty,
    ),
  };
});

export type SetterOgSummary = {
  displayName: string;
  /** Sends across the setter's listable climbs, each at its most-sent angle. */
  totalAscents: number;
  /** Seed for the card URL's token; the page adds the climb it names. */
  version: string;
};

export const getSetterOgSummary = cache(async (username: string): Promise<SetterOgSummary | null> => {
  const { setterProfile } = await executeGraphQLInternal<{
    setterProfile: {
      climbCount: number;
      totalAscents: number;
      linkedUserDisplayName: string | null;
      linkedUserAvatarUrl: string | null;
    } | null;
  }>(
    `query SetterPreview($input: SetterProfileInput!) {
    setterProfile(input: $input) { climbCount totalAscents linkedUserDisplayName linkedUserAvatarUrl }
  }`,
    { input: { username } },
  );
  if (!setterProfile?.climbCount) return null;
  return {
    displayName: setterProfile.linkedUserDisplayName || username,
    totalAscents: setterProfile.totalAscents,
    // The token used to be a constant, so a setter card could stay stale in a
    // chat app's cache forever. These are the numbers the card prints.
    version: buildOgContentVersion(
      setterProfile.climbCount,
      setterProfile.totalAscents,
      setterProfile.linkedUserDisplayName,
      setterProfile.linkedUserAvatarUrl,
    ),
  };
});

export type SessionOgGradeRow = {
  difficulty: number;
  count: number;
};

/**
 * The hardest tick of a kind a stranger may see. No climb name: the backend card
 * never features a community-hidden climb, and the anonymous `sessionDetail`
 * ticks carry no hidden flag to tell one apart, so the share copy names grades,
 * never climbs.
 */
export type SessionOgHighlight = {
  grade: string;
  angle: number;
  flashed: boolean;
};

export type SessionOgSummary = {
  sessionType: 'party' | null;
  sessionName: string;
  leaderName: string | null;
  participantNames: string[];
  participantCount: number;
  totalSends: number;
  gradeRows: SessionOgGradeRow[];
  boardLabel: string | null;
  boardAngle: number | null;
  boardPreviewPath: string | null;
  version: string;
  found: boolean;
  /** True while `session()` answers: the session is live and a stranger may see it. */
  isLive: boolean;
  /** Who an invite names: the leader, else the first climber who may be named. */
  inviteName: string | null;
  /** The live session's board type and angle, from its `boardPath`, when a stranger may see it. */
  liveBoard: { boardType: string; angle: number | null } | null;
  /** Ticks a stranger may see. Zero means there is no recap card to advertise. */
  tickCount: number;
  totalFlashes: number;
  durationMinutes: number | null;
  /** Climbers a stranger can see logging; `name` is null for one they may not name. */
  recapParticipants: Array<{ name: string | null }>;
  boardTypes: string[];
  hardestSend: SessionOgHighlight | null;
  hardestAttempt: SessionOgHighlight | null;
};

type SessionTickRead = {
  boardType: string;
  angle: number;
  status: string;
  difficulty: number | null;
  difficultyName: string | null;
};

const SEND_STATUSES = new Set(['send', 'flash']);

function pickHardestTick(ticks: readonly SessionTickRead[]): SessionOgHighlight | null {
  let picked: SessionTickRead | null = null;
  for (const tick of ticks) {
    if (tick.difficulty === null) continue;
    if (!picked || tick.difficulty > (picked.difficulty ?? -1)) picked = tick;
  }
  if (!picked) return null;
  const grade = formatCardGrade(picked.boardType, picked.difficulty) ?? picked.difficultyName;
  if (!grade) return null;
  return { grade, angle: picked.angle, flashed: picked.status === 'flash' };
}

/**
 * The board a live session is on. The anonymous projection returns `/b/<slug>`
 * only when a stranger may name the board, and the geometry path otherwise, so
 * both forms are read. A slug costs one anonymous `boardBySlug`, which selects
 * the board's type and angle and never its name or location.
 */
async function resolveLiveBoard(boardPath: string | null): Promise<SessionOgSummary['liveBoard']> {
  if (!boardPath) return null;
  const named = parseNamedBoardPath(boardPath);
  if (named) {
    const { boardBySlug } = await executeGraphQLInternal<{
      boardBySlug: { boardType: string; angle: number } | null;
    }>(`query SessionPreviewBoard($slug: String!) { boardBySlug(slug: $slug) { boardType angle } }`, {
      slug: named.slug,
    });
    return boardBySlug ? { boardType: boardBySlug.boardType, angle: named.angle ?? boardBySlug.angle } : null;
  }
  const parsed = parseBoardPath(boardPath);
  return parsed ? { boardType: parsed.boardName, angle: parsed.angle } : null;
}

export const getSessionOgSummary = cache(async (sessionId: string): Promise<SessionOgSummary> => {
  const empty: SessionOgSummary = {
    sessionType: null,
    sessionName: 'Climbing Session',
    leaderName: null,
    participantNames: [],
    participantCount: 0,
    totalSends: 0,
    gradeRows: [],
    boardLabel: null,
    boardAngle: null,
    boardPreviewPath: null,
    version: buildOgVersionToken(null),
    found: false,
    isLive: false,
    inviteName: null,
    liveBoard: null,
    tickCount: 0,
    totalFlashes: 0,
    durationMinutes: null,
    recapParticipants: [],
    boardTypes: [],
    hardestSend: null,
    hardestAttempt: null,
  };
  const { sessionDetail, session } = await executeGraphQLInternal<{
    sessionDetail: {
      sessionName: string | null;
      totalSends: number;
      totalFlashes: number;
      durationMinutes: number | null;
      lastTickAt: string;
      boardTypes: string[];
      gradeDistribution: Array<{ grade: string; flash: number; send: number }>;
      participants: Array<{ displayName: string | null }>;
      ticks: SessionTickRead[];
    } | null;
    session: {
      name: string | null;
      startedAt: string | null;
      boardPath: string | null;
      users: Array<{ userId: string | null; username: string; isLeader: boolean }>;
    } | null;
  }>(
    `query SessionPreview($sessionId: ID!) {
    sessionDetail(sessionId: $sessionId) {
      sessionName totalSends totalFlashes durationMinutes lastTickAt boardTypes
      gradeDistribution { grade flash send }
      participants { displayName }
      ticks { boardType angle status difficulty difficultyName }
    }
    session(sessionId: $sessionId) { name startedAt boardPath users { userId username isLeader } }
  }`,
    { sessionId },
  );
  if (!sessionDetail && !session) return empty;
  const participantNames = sessionDetail
    ? sessionDetail.participants.flatMap((participant) => (participant.displayName ? [participant.displayName] : []))
    : (session?.users ?? []).flatMap((participant) => (participant.userId ? [participant.username] : []));
  const gradeRows = (sessionDetail?.gradeDistribution ?? []).flatMap((row) => {
    const grade = BOULDER_GRADES.find(
      (candidate) =>
        candidate.difficulty_name.toLowerCase() === row.grade.toLowerCase() ||
        candidate.font_grade.toLowerCase() === row.grade.split('/')[0].toLowerCase(),
    );
    return grade && row.flash + row.send > 0 ? [{ difficulty: grade.difficulty_id, count: row.flash + row.send }] : [];
  });
  // The anonymous projection blanks `userId` for a climber who stays unnamed.
  const nameableUsers = (session?.users ?? []).filter((user) => user.userId && user.username.trim());
  const ticks = sessionDetail?.ticks ?? [];
  // The board is a nicety on the invite's words. A failed lookup costs the board,
  // never the session: it must not turn a real session into "not found".
  const liveBoard = session ? await resolveLiveBoard(session.boardPath).catch(() => null) : null;
  return {
    ...empty,
    sessionType: 'party',
    found: true,
    sessionName: sessionDetail?.sessionName || session?.name || empty.sessionName,
    leaderName: session?.users.find((participant) => participant.userId && participant.isLeader)?.username ?? null,
    participantNames,
    participantCount: Math.max(sessionDetail?.participants.length ?? 0, session?.users.length ?? 0),
    totalSends: sessionDetail?.totalSends ?? 0,
    gradeRows,
    boardLabel: sessionDetail?.boardTypes.map(formatBoardDisplayName).join(', ') || null,
    version: buildOgVersionToken(sessionDetail?.lastTickAt ?? session?.startedAt ?? null),
    isLive: !!session,
    inviteName: (nameableUsers.find((user) => user.isLeader) ?? nameableUsers[0])?.username.trim() ?? null,
    liveBoard,
    tickCount: ticks.length,
    totalFlashes: sessionDetail?.totalFlashes ?? 0,
    durationMinutes: sessionDetail?.durationMinutes ?? null,
    recapParticipants: (sessionDetail?.participants ?? []).map((participant) => ({
      name: participant.displayName?.trim() || null,
    })),
    boardTypes: sessionDetail?.boardTypes ?? [],
    hardestSend: pickHardestTick(ticks.filter((tick) => SEND_STATUSES.has(tick.status))),
    hardestAttempt: pickHardestTick(ticks),
  };
});

export type PlaylistOgSummary = {
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  isPublic: boolean;
  boardType: string;
  /**
   * For a public list, the climbs a stranger can open (`playlistClimbs.totalCount`):
   * the number the card prints. `Playlist.climbCount` also counts drafts and
   * hidden spray climbs, and is what a private list carries.
   */
  climbCount: number;
  /** The 10th and 90th percentile grades, or null when too few climbs carry one. */
  gradeSummary: { p10Difficulty: number; p90Difficulty: number } | null;
  version: string;
};

export const getPlaylistOgSummary = cache(async (playlistUuid: string): Promise<PlaylistOgSummary | null> => {
  const { playlist } = await executeGraphQLInternal<{
    playlist:
      | (Omit<PlaylistOgSummary, 'version' | 'gradeSummary'> & {
          updatedAt: string;
          gradeSummary: { p10Difficulty: number; p90Difficulty: number } | null;
        })
      | null;
  }>(
    `
    query PlaylistPreview($playlistId: ID!) {
      playlist(playlistId: $playlistId) {
        name description color icon isPublic boardType climbCount updatedAt
        gradeSummary { p10Difficulty p90Difficulty }
      }
    }`,
    { playlistId: playlistUuid },
  );
  if (!playlist) return null;
  const { updatedAt, gradeSummary, ...rest } = playlist;
  // A private list is never advertised, so its climbs are not read at all.
  if (!playlist.isPublic) return { ...rest, gradeSummary: null, version: buildOgVersionToken(updatedAt) };

  const { playlistClimbs } = await executeGraphQLInternal<{ playlistClimbs: { totalCount: number } }>(
    `query PlaylistPreviewCount($input: GetPlaylistClimbsInput!) {
      playlistClimbs(input: $input) { totalCount }
    }`,
    { input: { playlistId: playlistUuid, page: 0, pageSize: 1 } },
  );
  return {
    ...rest,
    climbCount: playlistClimbs.totalCount,
    gradeSummary,
    // The band's daily refresh does not touch `updatedAt`, so it is in the token.
    version: buildOgContentVersion(updatedAt, gradeSummary, playlistClimbs.totalCount),
  };
});

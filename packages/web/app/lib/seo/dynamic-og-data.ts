import 'server-only';
import { cache } from 'react';
import { BOARD_TYPES } from '@boardsesh/profile-stats';
import { BOULDER_GRADES } from '@/app/lib/board-data';
import { executeGraphQLInternal } from '@/app/lib/graphql/server-cached-client';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { buildOgVersionToken } from './og';

// Public previews use the same anonymous backend authorization as public reads.
// React cache deduplicates only within this request; no authorization survives it.
export type ProfileOgSummary = {
  displayName: string;
  avatarUrl: string | null;
  fallbackImageUrl: string | null;
  /**
   * Board this climber has logged the most ticks on, or null when they have
   * none. Drives the search-first page title ("Marco's Kilter Sessions") — a
   * bare "Marco | Boardsesh" matches nothing anyone types into Google.
   */
  topBoardType: string | null;
  version: string;
  gradeRows: Array<{ difficulty: number; cnt: number }>;
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
  if (!publicProfile || publicProfile.isPrivate) return null;
  const ticksByBoard = await Promise.all(
    BOARD_TYPES.map(async (boardType) => {
      const response = await executeGraphQLInternal<{
        userTicks: Array<{
          climbUuid: string;
          difficulty: number | null;
          status: string;
          climbedAt: string;
        }>;
      }>(
        `query ProfilePreviewTicks($userId: ID!, $boardType: String!) {
      userTicks(userId: $userId, boardType: $boardType) { climbUuid difficulty status climbedAt }
    }`,
        { userId, boardType },
      );
      return { boardType, ticks: response.userTicks };
    }),
  );
  const grades = new Map<number, Set<string>>();
  let latest: string | null = null;
  for (const { boardType, ticks } of ticksByBoard) {
    for (const tick of ticks) {
      if (!latest || tick.climbedAt > latest) latest = tick.climbedAt;
      if (tick.difficulty === null || !['send', 'flash'].includes(tick.status)) continue;
      const climbs = grades.get(tick.difficulty) ?? new Set<string>();
      climbs.add(`${boardType}:${tick.climbUuid}`);
      grades.set(tick.difficulty, climbs);
    }
  }
  ticksByBoard.sort((first, second) => second.ticks.length - first.ticks.length);
  return {
    displayName: publicProfile.displayName || 'Crusher',
    avatarUrl: publicProfile.avatarUrl,
    fallbackImageUrl: null,
    topBoardType: ticksByBoard[0]?.ticks.length ? ticksByBoard[0].boardType : null,
    version: buildOgVersionToken(latest),
    gradeRows: [...grades].map(([difficulty, climbs]) => ({ difficulty, cnt: climbs.size })),
  };
});

export type SetterOgSummary = {
  displayName: string;
  avatarUrl: string | null;
  version: string;
};

export const getSetterOgSummary = cache(async (username: string): Promise<SetterOgSummary | null> => {
  const { setterProfile } = await executeGraphQLInternal<{
    setterProfile: {
      climbCount: number;
      linkedUserDisplayName: string | null;
      linkedUserAvatarUrl: string | null;
    } | null;
  }>(
    `query SetterPreview($input: SetterProfileInput!) {
    setterProfile(input: $input) { climbCount linkedUserDisplayName linkedUserAvatarUrl }
  }`,
    { input: { username } },
  );
  if (!setterProfile?.climbCount) return null;
  return {
    displayName: setterProfile.linkedUserDisplayName || username,
    avatarUrl: setterProfile.linkedUserAvatarUrl,
    version: buildOgVersionToken(null),
  };
});

export type SessionOgGradeRow = {
  difficulty: number;
  count: number;
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
};

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
  };
  const { sessionDetail, session } = await executeGraphQLInternal<{
    sessionDetail: {
      sessionName: string | null;
      totalSends: number;
      lastTickAt: string;
      boardTypes: string[];
      gradeDistribution: Array<{ grade: string; flash: number; send: number }>;
      participants: Array<{ displayName: string | null }>;
    } | null;
    session: {
      name: string | null;
      startedAt: string | null;
      users: Array<{ userId: string | null; username: string; isLeader: boolean }>;
    } | null;
  }>(
    `query SessionPreview($sessionId: ID!) {
    sessionDetail(sessionId: $sessionId) {
      sessionName totalSends lastTickAt boardTypes
      gradeDistribution { grade flash send }
      participants { displayName }
    }
    session(sessionId: $sessionId) { name startedAt users { userId username isLeader } }
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
  };
});

export type PlaylistOgSummary = {
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  isPublic: boolean;
  boardType: string;
  climbCount: number;
  version: string;
};

export const getPlaylistOgSummary = cache(async (playlistUuid: string): Promise<PlaylistOgSummary | null> => {
  const { playlist } = await executeGraphQLInternal<{
    playlist: (Omit<PlaylistOgSummary, 'version'> & { updatedAt: string }) | null;
  }>(
    `
    query PlaylistPreview($playlistId: ID!) {
      playlist(playlistId: $playlistId) { name description color icon isPublic boardType climbCount updatedAt }
    }`,
    { playlistId: playlistUuid },
  );
  if (!playlist) return null;
  return { ...playlist, version: buildOgVersionToken(playlist.updatedAt) };
});

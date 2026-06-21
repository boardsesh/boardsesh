import type { SessionDetail, SessionDetailTick } from '@boardsesh/shared-schema';

const MOCK_SESSION_ID = 'tour-mock-session';
const MOCK_BOARD_TYPE = 'kilter';

type MockParticipant = {
  userId: string;
  displayName: string;
  sends: number;
  flashes: number;
  attempts: number;
};

const PARTICIPANTS: MockParticipant[] = [
  { userId: 'tour-u1', displayName: 'Alex', sends: 7, flashes: 2, attempts: 14 },
  { userId: 'tour-u2', displayName: 'Priya', sends: 5, flashes: 3, attempts: 9 },
  { userId: 'tour-u3', displayName: 'Jordan', sends: 4, flashes: 0, attempts: 11 },
  { userId: 'tour-u4', displayName: 'Sam', sends: 2, flashes: 0, attempts: 8 },
];

type MockTickSeed = {
  climbName: string;
  climbUuid: string;
  grade: string;
  difficulty: number;
  status: 'flash' | 'send' | 'attempt';
  userId: string;
  attemptCount: number;
  minutesAgo: number;
};

const TICK_SEEDS: MockTickSeed[] = [
  {
    climbName: 'Crimp Carousel',
    climbUuid: 'tour-c1',
    grade: 'V4',
    difficulty: 17,
    status: 'flash',
    userId: 'tour-u2',
    attemptCount: 1,
    minutesAgo: 85,
  },
  {
    climbName: 'Slope Symphony',
    climbUuid: 'tour-c2',
    grade: 'V3',
    difficulty: 16,
    status: 'send',
    userId: 'tour-u1',
    attemptCount: 2,
    minutesAgo: 82,
  },
  {
    climbName: 'Pinch Parade',
    climbUuid: 'tour-c3',
    grade: 'V5',
    difficulty: 19,
    status: 'send',
    userId: 'tour-u1',
    attemptCount: 3,
    minutesAgo: 78,
  },
  {
    climbName: 'Heel Hook Highway',
    climbUuid: 'tour-c4',
    grade: 'V4',
    difficulty: 17,
    status: 'send',
    userId: 'tour-u3',
    attemptCount: 4,
    minutesAgo: 74,
  },
  {
    climbName: 'Dyno Dilemma',
    climbUuid: 'tour-c5',
    grade: 'V5',
    difficulty: 19,
    status: 'send',
    userId: 'tour-u2',
    attemptCount: 2,
    minutesAgo: 68,
  },
  {
    climbName: 'Compression King',
    climbUuid: 'tour-c6',
    grade: 'V6',
    difficulty: 21,
    status: 'send',
    userId: 'tour-u1',
    attemptCount: 4,
    minutesAgo: 62,
  },
  {
    climbName: 'Sloper Shuffle',
    climbUuid: 'tour-c7',
    grade: 'V3',
    difficulty: 16,
    status: 'flash',
    userId: 'tour-u2',
    attemptCount: 1,
    minutesAgo: 58,
  },
  {
    climbName: 'Mantle Masters',
    climbUuid: 'tour-c8',
    grade: 'V4',
    difficulty: 17,
    status: 'send',
    userId: 'tour-u4',
    attemptCount: 5,
    minutesAgo: 52,
  },
  {
    climbName: 'Overhang Odyssey',
    climbUuid: 'tour-c9',
    grade: 'V5',
    difficulty: 19,
    status: 'send',
    userId: 'tour-u3',
    attemptCount: 3,
    minutesAgo: 47,
  },
  {
    climbName: 'Crux Crusher',
    climbUuid: 'tour-c10',
    grade: 'V6',
    difficulty: 21,
    status: 'send',
    userId: 'tour-u2',
    attemptCount: 5,
    minutesAgo: 42,
  },
  {
    climbName: 'Arete Assault',
    climbUuid: 'tour-c11',
    grade: 'V5',
    difficulty: 19,
    status: 'send',
    userId: 'tour-u1',
    attemptCount: 2,
    minutesAgo: 38,
  },
  {
    climbName: 'Gaston Gambit',
    climbUuid: 'tour-c12',
    grade: 'V4',
    difficulty: 17,
    status: 'send',
    userId: 'tour-u3',
    attemptCount: 3,
    minutesAgo: 33,
  },
  {
    climbName: 'Sidepull Symphony',
    climbUuid: 'tour-c13',
    grade: 'V6',
    difficulty: 21,
    status: 'send',
    userId: 'tour-u3',
    attemptCount: 4,
    minutesAgo: 28,
  },
  {
    climbName: 'Undercling Underdog',
    climbUuid: 'tour-c14',
    grade: 'V5',
    difficulty: 19,
    status: 'flash',
    userId: 'tour-u2',
    attemptCount: 1,
    minutesAgo: 24,
  },
  {
    climbName: 'Jug Highway',
    climbUuid: 'tour-c15',
    grade: 'V3',
    difficulty: 16,
    status: 'send',
    userId: 'tour-u4',
    attemptCount: 2,
    minutesAgo: 20,
  },
  {
    climbName: 'Pocket Problem',
    climbUuid: 'tour-c16',
    grade: 'V6',
    difficulty: 21,
    status: 'send',
    userId: 'tour-u1',
    attemptCount: 6,
    minutesAgo: 15,
  },
  {
    climbName: 'Crimp Carousel',
    climbUuid: 'tour-c1',
    grade: 'V4',
    difficulty: 17,
    status: 'send',
    userId: 'tour-u4',
    attemptCount: 4,
    minutesAgo: 11,
  },
  {
    climbName: 'Crux Crusher',
    climbUuid: 'tour-c10',
    grade: 'V6',
    difficulty: 21,
    status: 'send',
    userId: 'tour-u3',
    attemptCount: 6,
    minutesAgo: 7,
  },
  {
    climbName: 'The Project',
    climbUuid: 'tour-c17',
    grade: 'V7',
    difficulty: 23,
    status: 'send',
    userId: 'tour-u1',
    attemptCount: 8,
    minutesAgo: 3,
  },
];

export function getMockSessionDetail(): SessionDetail {
  const now = new Date();
  const lastTickAt = now.toISOString();
  const firstTickAt = new Date(now.getTime() - 90 * 60_000).toISOString();

  const ticks: SessionDetailTick[] = TICK_SEEDS.map((seed, idx) => ({
    uuid: `tour-tick-${String(idx + 1).padStart(2, '0')}`,
    userId: seed.userId,
    climbUuid: seed.climbUuid,
    climbName: seed.climbName,
    boardType: MOCK_BOARD_TYPE,
    layoutId: null,
    angle: 40,
    status: seed.status,
    attemptCount: seed.attemptCount,
    difficulty: seed.difficulty,
    difficultyName: seed.grade,
    quality: 3,
    isMirror: false,
    isBenchmark: false,
    isNoMatch: false,
    comment: null,
    frames: null,
    setterUsername: null,
    climbedAt: new Date(now.getTime() - seed.minutesAgo * 60_000).toISOString(),
    upvotes: 0,
    totalAttempts: null,
    betaLinks: [],
  }));

  const totalSends = PARTICIPANTS.reduce((sum, p) => sum + p.sends, 0);
  const totalFlashes = PARTICIPANTS.reduce((sum, p) => sum + p.flashes, 0);
  const totalAttempts = PARTICIPANTS.reduce((sum, p) => sum + p.attempts, 0);

  return {
    sessionId: MOCK_SESSION_ID,
    sessionType: 'party',
    sessionName: 'Thursday crew night',
    ownerUserId: null,
    participants: PARTICIPANTS.map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      avatarUrl: null,
      sends: p.sends,
      flashes: p.flashes,
      attempts: p.attempts,
    })),
    totalSends,
    totalFlashes,
    totalAttempts,
    tickCount: ticks.length,
    gradeDistribution: [
      { grade: 'V3', flash: 1, send: 2, attempt: 0 },
      { grade: 'V4', flash: 1, send: 3, attempt: 0 },
      { grade: 'V5', flash: 1, send: 4, attempt: 0 },
      { grade: 'V6', flash: 0, send: 4, attempt: 0 },
      { grade: 'V7', flash: 0, send: 1, attempt: 0 },
    ],
    boardTypes: [MOCK_BOARD_TYPE],
    hardestGrade: 'V7',
    firstTickAt,
    lastTickAt,
    durationMinutes: 90,
    goal: 'Project the V6 crux',
    ticks,
    upvotes: 0,
    downvotes: 0,
    voteScore: 0,
    commentCount: 0,
  };
}

export const MOCK_SESSION_ID_CONST = MOCK_SESSION_ID;

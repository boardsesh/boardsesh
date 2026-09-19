/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureScreenshotFixtures } from '../lib/screenshot-fixture-snapshot';
import { canonicalJson, type ScreenshotFixtureManifest } from '../lib/screenshot-fixtures';

type HistoryTick = {
  climbUuid: string;
  boardType: string;
  layoutId: number | null;
  angle: number;
  status: 'send' | 'flash' | 'attempt';
  attemptCount: number;
  difficulty: number | null;
  effectiveDifficulty: number | null;
  climbedAt: string;
};
type HistoryAscent = HistoryTick & { uuid: string; climbName: string; difficultyName: string };
type HistorySession = {
  sessionId: string;
  ownerUserId: string;
  boardTypes: string[];
  totalSends: number;
  totalFlashes: number;
  totalAttempts: number;
  tickCount: number;
  hardestGrade: string | null;
  firstTickAt: string;
  lastTickAt: string;
  durationMinutes: number | null;
  participants: Array<{ userId: string; sends: number; flashes: number; attempts: number }>;
  gradeDistribution: Array<{ grade: string; flash: number; send: number; attempt: number }>;
  ticks: HistoryAscent[];
};
type HistoryResponses = {
  userTicks?: HistoryTick[];
  userProfileStats?: {
    totalDistinctClimbs: number;
    layoutStats: Array<{
      boardType: string;
      layoutId: number | null;
      distinctClimbCount: number;
      gradeCounts: Array<{ grade: string; count: number }>;
    }>;
  };
  userGroupedAscentsFeed?: {
    totalCount: number;
    groups: Array<{ boardType: string; date: string; items: HistoryAscent[] }>;
  };
  sessionDetail?: HistorySession | null;
  sessionGroupedFeed?: { sessions: HistorySession[] };
};
type HistoryFixture = {
  operationName: string;
  variables: {
    userId?: string;
    boardType?: string;
    sessionId?: string;
    input?: { userId?: string; offset?: number; cursor?: string | null; entityType?: string; entityIds?: string[] };
  };
  response: { data: HistoryResponses };
};

let manifest: ScreenshotFixtureManifest;
let fixtures: HistoryFixture[];
let canonicalTicks: HistoryTick[];

function tickTime(timestamp: string): number {
  return Date.parse(timestamp.includes('T') ? timestamp : `${timestamp.replace(' ', 'T')}Z`);
}

function canonicalTickFor(ascent: HistoryAscent): HistoryTick | undefined {
  return canonicalTicks.find(
    (tick) =>
      tick.boardType === ascent.boardType &&
      tick.climbUuid === ascent.climbUuid &&
      tick.angle === ascent.angle &&
      tickTime(tick.climbedAt) === tickTime(ascent.climbedAt),
  );
}

// The override lets a locally prepared, unpublished pack pass this same contract.
// CI always resolves and verifies the committed content-addressed snapshot.
beforeAll(async () => {
  const directory = process.env.BOARDSESH_HISTORY_FIXTURES_DIR ?? (await ensureScreenshotFixtures());
  manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
  fixtures = manifest.graphql.map(
    (entry) => JSON.parse(readFileSync(join(directory, entry.file), 'utf8')) as HistoryFixture,
  );
  canonicalTicks = fixtures
    .filter(
      (fixture) => fixture.operationName === 'GetUserTicks' && fixture.variables.userId === manifest.accountUserId,
    )
    .flatMap((fixture) =>
      (fixture.response.data.userTicks ?? []).map((tick) => ({ ...tick, boardType: fixture.variables.boardType! })),
    );
}, 60_000);

describe('cross-board store history fixtures', () => {
  it('keeps overview totals distinct across repeated sends and angles', () => {
    const summary = fixtures.find((fixture) => fixture.operationName === 'GetUserProfileStats')?.response.data
      .userProfileStats;
    expect(summary).toBeDefined();
    const sends = canonicalTicks.filter((tick) => tick.status !== 'attempt');
    const distinctClimbs = new Set(sends.map((tick) => tick.climbUuid));
    expect(canonicalTicks).toHaveLength(296);
    expect(distinctClimbs.size).toBe(254);
    expect(summary!.totalDistinctClimbs).toBe(distinctClimbs.size);
    expect(summary!.layoutStats).toHaveLength(9);
    expect(sends.length).toBeGreaterThan(distinctClimbs.size);
    for (const layout of summary!.layoutStats) {
      const layoutTicks = sends.filter(
        (tick) => tick.boardType === layout.boardType && tick.layoutId === layout.layoutId,
      );
      expect(layout.distinctClimbCount).toBe(new Set(layoutTicks.map((tick) => tick.climbUuid)).size);
      const climbsByGrade = new Map<number, Set<string>>();
      for (const tick of layoutTicks) {
        const grade = tick.effectiveDifficulty ?? tick.difficulty;
        if (grade == null) continue;
        const climbs = climbsByGrade.get(grade) ?? new Set<string>();
        climbs.add(tick.climbUuid);
        climbsByGrade.set(grade, climbs);
      }
      expect(Object.fromEntries(layout.gradeCounts.map((grade) => [grade.grade, grade.count]))).toEqual(
        Object.fromEntries([...climbsByGrade].map(([grade, climbs]) => [String(grade), climbs.size])),
      );
    }
  });

  it('shows three board families using the same canonical tick dates and outcomes', () => {
    const firstPage = fixtures.find(
      (fixture) => fixture.operationName === 'GetUserGroupedAscentsFeed' && fixture.variables.input?.offset === 0,
    )?.response.data.userGroupedAscentsFeed;
    expect(firstPage).toBeDefined();
    expect(firstPage!.groups.slice(0, 3).map((group) => group.boardType)).toEqual(['kilter', 'tension', 'moonboard']);
    const groupedCount = new Set(canonicalTicks.map((tick) => `${tick.climbUuid}|${tick.climbedAt.slice(0, 10)}`)).size;
    expect(groupedCount).toBe(287);
    for (const fixture of fixtures.filter((candidate) => candidate.operationName === 'GetUserGroupedAscentsFeed')) {
      const feed = fixture.response.data.userGroupedAscentsFeed!;
      expect(feed.totalCount).toBe(groupedCount);
      for (const group of feed.groups) {
        for (const ascent of group.items) {
          const tick = canonicalTickFor(ascent);
          expect(tick, ascent.climbName).toBeDefined();
          expect(ascent).toMatchObject({
            status: tick!.status,
            attemptCount: tick!.attemptCount,
            difficulty: tick!.difficulty,
            angle: tick!.angle,
            layoutId: tick!.layoutId,
          });
          expect(group.date).toBe(tick!.climbedAt.slice(0, 10));
        }
      }
    }
  });

  it('derives the single-board recap from existing ticks without inventing sends', () => {
    const sessionId = manifest.capture?.profileSessionId;
    expect(sessionId).toBe('00000000-0000-4000-8000-000000000102');
    const session = fixtures.find(
      (fixture) => fixture.operationName === 'GetSessionDetail' && fixture.variables.sessionId === sessionId,
    )?.response.data.sessionDetail;
    expect(session).toBeTruthy();
    const ticks = session!.ticks;
    expect(ticks).toHaveLength(3);
    expect(session!.boardTypes).toEqual(['grasshopper']);
    for (const ascent of ticks) {
      const canonical = canonicalTickFor(ascent);
      expect(canonical, ascent.climbName).toBeDefined();
      expect(ascent.status).toBe(canonical!.status);
      expect(ascent.attemptCount).toBe(canonical!.attemptCount);
      expect(ascent.difficulty).toBe(canonical!.effectiveDifficulty ?? canonical!.difficulty);
    }
    const sends = ticks.filter((tick) => tick.status !== 'attempt');
    const flashes = ticks.filter((tick) => tick.status === 'flash');
    const burns = ticks.reduce(
      (sum, tick) => sum + Math.max(0, tick.attemptCount - (tick.status === 'attempt' ? 0 : 1)),
      0,
    );
    expect(session).toMatchObject({
      totalSends: sends.length,
      totalFlashes: flashes.length,
      totalAttempts: burns,
      tickCount: ticks.length,
      durationMinutes: 28,
    });
    expect(session!.participants[0]).toMatchObject({ sends: sends.length, flashes: flashes.length, attempts: burns });
    const hardest = [...sends].sort((left, right) => (right.difficulty ?? -1) - (left.difficulty ?? -1))[0];
    expect(session!.hardestGrade).toBe(hardest.difficultyName);
    for (const grade of session!.gradeDistribution) {
      expect(grade).toEqual({
        grade: grade.grade,
        flash: ticks.filter((tick) => tick.difficultyName === grade.grade && tick.status === 'flash').length,
        send: ticks.filter((tick) => tick.difficultyName === grade.grade && tick.status === 'send').length,
        attempt: ticks.filter((tick) => tick.difficultyName === grade.grade && tick.status === 'attempt').length,
      });
    }
  });

  it('keeps repeated personal-feed session summaries and vote cohorts consistent', () => {
    const comparedFields = [
      'totalSends',
      'totalFlashes',
      'totalAttempts',
      'tickCount',
      'hardestGrade',
      'firstTickAt',
      'lastTickAt',
      'durationMinutes',
      'boardTypes',
    ] as const;
    const summaries = new Map<string, string>();
    for (const fixture of fixtures.filter((candidate) => candidate.operationName === 'GetSessionGroupedFeed')) {
      const sessions = fixture.response.data.sessionGroupedFeed!.sessions;
      for (const session of sessions) {
        if (session.ownerUserId !== manifest.accountUserId) continue;
        const details = fixtures.find(
          (candidate) =>
            candidate.operationName === 'GetSessionDetail' && candidate.variables.sessionId === session.sessionId,
        )?.response.data.sessionDetail;
        const current = canonicalJson(Object.fromEntries(comparedFields.map((field) => [field, session[field]])));
        const prior = summaries.get(session.sessionId);
        if (prior) expect(current, session.sessionId).toBe(prior);
        if (details) {
          expect(current, session.sessionId).toBe(
            canonicalJson(Object.fromEntries(comparedFields.map((field) => [field, details[field]]))),
          );
        }
        expect(tickTime(session.lastTickAt) - tickTime(session.firstTickAt)).toBeGreaterThanOrEqual(0);
        summaries.set(session.sessionId, current);
      }
      if (fixture.variables.input?.userId !== manifest.accountUserId) continue;
      expect(
        fixtures.some(
          (candidate) =>
            candidate.operationName === 'GetBulkVoteSummaries' &&
            canonicalJson(candidate.variables.input?.entityIds) ===
              canonicalJson(sessions.map((session) => session.sessionId)),
        ),
      ).toBe(true);
    }
  });
});

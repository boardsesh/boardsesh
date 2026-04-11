import { eq, and, sql, inArray } from 'drizzle-orm';

import type { RequestDbInstance } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { resolveCommunitySetting, DEFAULTS } from '../community-settings';

/**
 * Enrich a single proposal with proposer info, vote counts, climb data, and stats.
 */
export async function enrichProposal(
  db: RequestDbInstance,
  proposal: typeof dbSchema.climbProposals.$inferSelect,
  authenticatedUserId: string | null | undefined,
) {
  // Fetch proposer profile (LEFT JOIN to get OAuth name/image as fallback)
  const [proposer] = await db
    .select({
      name: dbSchema.users.name,
      image: dbSchema.users.image,
      displayName: dbSchema.userProfiles.displayName,
      avatarUrl: dbSchema.userProfiles.avatarUrl,
    })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
    .where(eq(dbSchema.users.id, proposal.proposerId))
    .limit(1);

  // Compute weighted vote counts
  const voteRows = await db
    .select({
      value: dbSchema.proposalVotes.value,
      weight: dbSchema.proposalVotes.weight,
    })
    .from(dbSchema.proposalVotes)
    .where(eq(dbSchema.proposalVotes.proposalId, proposal.id));

  let weightedUpvotes = 0;
  let weightedDownvotes = 0;
  for (const v of voteRows) {
    if (v.value > 0) weightedUpvotes += v.value * v.weight;
    else weightedDownvotes += Math.abs(v.value) * v.weight;
  }

  // Get required upvotes from settings
  const threshold = await resolveCommunitySetting(
    'approval_threshold',
    proposal.climbUuid,
    proposal.angle,
    proposal.boardType,
  );
  const requiredUpvotes = parseInt(threshold, 10) || 5;

  // Get current user's vote
  let userVote = 0;
  if (authenticatedUserId) {
    const [myVote] = await db
      .select({ value: dbSchema.proposalVotes.value })
      .from(dbSchema.proposalVotes)
      .where(
        and(
          eq(dbSchema.proposalVotes.proposalId, proposal.id),
          eq(dbSchema.proposalVotes.userId, authenticatedUserId),
        ),
      )
      .limit(1);
    userVote = myVote?.value || 0;
  }

  // Fetch climb data (name, frames, layoutId, setterUsername, angle)
  const [climb] = await db
    .select({
      name: dbSchema.boardClimbs.name,
      frames: dbSchema.boardClimbs.frames,
      layoutId: dbSchema.boardClimbs.layoutId,
      setterUsername: dbSchema.boardClimbs.setterUsername,
      angle: dbSchema.boardClimbs.angle,
    })
    .from(dbSchema.boardClimbs)
    .where(
      and(
        eq(dbSchema.boardClimbs.uuid, proposal.climbUuid),
        eq(dbSchema.boardClimbs.boardType, proposal.boardType),
      ),
    )
    .limit(1);

  // Fetch climb stats and difficulty grade name
  // For classic proposals (angle null), fall back to the climb's default angle
  let climbDifficulty: string | undefined;
  let climbQualityAverage: string | undefined;
  let climbAscensionistCount: number | undefined;
  let climbDifficultyError: string | undefined;
  let climbBenchmarkDifficulty: string | undefined;

  const effectiveAngle = proposal.angle ?? climb?.angle;
  if (effectiveAngle != null) {
    const [stats] = await db
      .select({
        displayDifficulty: dbSchema.boardClimbStats.displayDifficulty,
        difficultyAverage: dbSchema.boardClimbStats.difficultyAverage,
        qualityAverage: dbSchema.boardClimbStats.qualityAverage,
        ascensionistCount: dbSchema.boardClimbStats.ascensionistCount,
        benchmarkDifficulty: dbSchema.boardClimbStats.benchmarkDifficulty,
        boulderName: dbSchema.boardDifficultyGrades.boulderName,
      })
      .from(dbSchema.boardClimbStats)
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardDifficultyGrades.boardType, dbSchema.boardClimbStats.boardType),
          sql`${dbSchema.boardDifficultyGrades.difficulty} = ROUND(${dbSchema.boardClimbStats.displayDifficulty}::numeric)`,
        ),
      )
      .where(
        and(
          eq(dbSchema.boardClimbStats.climbUuid, proposal.climbUuid),
          eq(dbSchema.boardClimbStats.boardType, proposal.boardType),
          eq(dbSchema.boardClimbStats.angle, effectiveAngle),
        ),
      )
      .limit(1);

    if (stats) {
      climbDifficulty = stats.boulderName || undefined;
      climbQualityAverage = stats.qualityAverage != null ? String(Math.round(stats.qualityAverage * 100) / 100) : undefined;
      climbAscensionistCount = stats.ascensionistCount ?? undefined;
      climbDifficultyError = (stats.difficultyAverage != null && stats.displayDifficulty != null)
        ? String(Math.round((stats.difficultyAverage - stats.displayDifficulty) * 100) / 100)
        : undefined;
      climbBenchmarkDifficulty = (stats.benchmarkDifficulty != null && stats.benchmarkDifficulty > 0)
        ? String(stats.benchmarkDifficulty)
        : undefined;
    }
  }

  return {
    uuid: proposal.uuid,
    climbUuid: proposal.climbUuid,
    boardType: proposal.boardType,
    angle: proposal.angle,
    proposerId: proposal.proposerId,
    proposerDisplayName: proposer?.displayName || proposer?.name || undefined,
    proposerAvatarUrl: proposer?.avatarUrl || proposer?.image || undefined,
    type: proposal.type,
    proposedValue: proposal.proposedValue,
    currentValue: proposal.currentValue,
    status: proposal.status,
    reason: proposal.reason,
    resolvedAt: proposal.resolvedAt?.toISOString() || undefined,
    resolvedBy: proposal.resolvedBy,
    createdAt: proposal.createdAt.toISOString(),
    weightedUpvotes,
    weightedDownvotes,
    requiredUpvotes,
    userVote,
    climbName: climb?.name || undefined,
    frames: climb?.frames || undefined,
    layoutId: climb?.layoutId || undefined,
    climbSetterUsername: climb?.setterUsername || undefined,
    climbDifficulty,
    climbQualityAverage,
    climbAscensionistCount,
    climbDifficultyError,
    climbBenchmarkDifficulty,
  };
}

/**
 * Batch-enrich multiple proposals in 3-4 queries total (instead of 4-7 per proposal).
 */
export async function batchEnrichProposals(
  db: RequestDbInstance,
  proposals: (typeof dbSchema.climbProposals.$inferSelect)[],
  authenticatedUserId: string | null | undefined,
) {
  if (proposals.length === 0) return [];

  const proposalIds = proposals.map((p) => p.id);
  const uniqueProposerIds = [...new Set(proposals.map((p) => p.proposerId))];

  // Query 1: Batch proposer profiles
  const proposerRows = await db
    .select({
      id: dbSchema.users.id,
      name: dbSchema.users.name,
      image: dbSchema.users.image,
      displayName: dbSchema.userProfiles.displayName,
      avatarUrl: dbSchema.userProfiles.avatarUrl,
    })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
    .where(inArray(dbSchema.users.id, uniqueProposerIds));

  const proposerMap = new Map(proposerRows.map((p) => [p.id, p]));

  // Query 2: Batch all votes
  const voteRows = await db
    .select({
      proposalId: dbSchema.proposalVotes.proposalId,
      value: dbSchema.proposalVotes.value,
      weight: dbSchema.proposalVotes.weight,
    })
    .from(dbSchema.proposalVotes)
    .where(inArray(dbSchema.proposalVotes.proposalId, proposalIds));

  const voteMap = new Map<number, { weightedUpvotes: number; weightedDownvotes: number }>();
  for (const v of voteRows) {
    let entry = voteMap.get(v.proposalId);
    if (!entry) {
      entry = { weightedUpvotes: 0, weightedDownvotes: 0 };
      voteMap.set(v.proposalId, entry);
    }
    if (v.value > 0) entry.weightedUpvotes += v.value * v.weight;
    else entry.weightedDownvotes += Math.abs(v.value) * v.weight;
  }

  // Query 3: Batch climb data (name, frames, layoutId, setterUsername, angle)
  const uniqueClimbUuids = [...new Set(proposals.map((p) => p.climbUuid))];
  const climbRows = await db
    .select({
      uuid: dbSchema.boardClimbs.uuid,
      boardType: dbSchema.boardClimbs.boardType,
      name: dbSchema.boardClimbs.name,
      frames: dbSchema.boardClimbs.frames,
      layoutId: dbSchema.boardClimbs.layoutId,
      setterUsername: dbSchema.boardClimbs.setterUsername,
      angle: dbSchema.boardClimbs.angle,
    })
    .from(dbSchema.boardClimbs)
    .where(inArray(dbSchema.boardClimbs.uuid, uniqueClimbUuids));

  const climbMap = new Map(climbRows.map((c) => [`${c.uuid}:${c.boardType}`, c]));

  // Query 3b: Batch climb stats with difficulty grade names
  // Build unique (climbUuid, boardType, angle) tuples from proposals that have an angle
  // For classic proposals (angle null), fall back to the climb's default angle
  const proposalsWithEffectiveAngle = proposals
    .map((p) => ({
      ...p,
      effectiveAngle: p.angle ?? climbMap.get(`${p.climbUuid}:${p.boardType}`)?.angle ?? null,
    }))
    .filter((p): p is typeof p & { effectiveAngle: number } => p.effectiveAngle != null);
  type StatsEntry = {
    boulderName: string | null;
    qualityAverage: number | null;
    ascensionistCount: number | null;
    difficultyAverage: number | null;
    displayDifficulty: number | null;
    benchmarkDifficulty: number | null;
  };
  const statsMap = new Map<string, StatsEntry>();

  if (proposalsWithEffectiveAngle.length > 0) {
    const uniqueStatsKeys = [...new Set(proposalsWithEffectiveAngle.map((p) => `${p.climbUuid}:${p.boardType}:${p.effectiveAngle}`))];
    const statsConditions = uniqueStatsKeys.map((key) => {
      const [climbUuid, boardType, angle] = key.split(':');
      return sql`(${dbSchema.boardClimbStats.climbUuid} = ${climbUuid} AND ${dbSchema.boardClimbStats.boardType} = ${boardType} AND ${dbSchema.boardClimbStats.angle} = ${parseInt(angle, 10)})`;
    });

    const statsRows = await db
      .select({
        climbUuid: dbSchema.boardClimbStats.climbUuid,
        boardType: dbSchema.boardClimbStats.boardType,
        angle: dbSchema.boardClimbStats.angle,
        displayDifficulty: dbSchema.boardClimbStats.displayDifficulty,
        difficultyAverage: dbSchema.boardClimbStats.difficultyAverage,
        qualityAverage: dbSchema.boardClimbStats.qualityAverage,
        ascensionistCount: dbSchema.boardClimbStats.ascensionistCount,
        benchmarkDifficulty: dbSchema.boardClimbStats.benchmarkDifficulty,
        boulderName: dbSchema.boardDifficultyGrades.boulderName,
      })
      .from(dbSchema.boardClimbStats)
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardDifficultyGrades.boardType, dbSchema.boardClimbStats.boardType),
          sql`${dbSchema.boardDifficultyGrades.difficulty} = ROUND(${dbSchema.boardClimbStats.displayDifficulty}::numeric)`,
        ),
      )
      .where(sql`(${sql.join(statsConditions, sql` OR `)})`);

    for (const row of statsRows) {
      statsMap.set(`${row.climbUuid}:${row.boardType}:${row.angle}`, {
        boulderName: row.boulderName,
        qualityAverage: row.qualityAverage,
        ascensionistCount: row.ascensionistCount,
        difficultyAverage: row.difficultyAverage,
        displayDifficulty: row.displayDifficulty,
        benchmarkDifficulty: row.benchmarkDifficulty,
      });
    }
  }

  const uniqueBoardTypes = [...new Set(proposals.map((p) => p.boardType))];

  const thresholdRows = await db
    .select({
      scope: dbSchema.communitySettings.scope,
      scopeKey: dbSchema.communitySettings.scopeKey,
      value: dbSchema.communitySettings.value,
    })
    .from(dbSchema.communitySettings)
    .where(
      and(
        eq(dbSchema.communitySettings.key, 'approval_threshold'),
        sql`(
          (${dbSchema.communitySettings.scope} = 'climb' AND ${dbSchema.communitySettings.scopeKey} IN (${sql.join(uniqueClimbUuids.map((u) => sql`${u}`), sql`, `)}))
          OR (${dbSchema.communitySettings.scope} = 'board' AND ${dbSchema.communitySettings.scopeKey} IN (${sql.join(uniqueBoardTypes.map((b) => sql`${b}`), sql`, `)}))
          OR (${dbSchema.communitySettings.scope} = 'global' AND ${dbSchema.communitySettings.scopeKey} = '')
        )`,
      ),
    );

  const thresholdMap = new Map(thresholdRows.map((r) => [`${r.scope}:${r.scopeKey}`, r.value]));

  function resolveThreshold(climbUuid: string, boardType: string): number {
    const climbVal = thresholdMap.get(`climb:${climbUuid}`);
    if (climbVal) return parseInt(climbVal, 10) || 5;
    const boardVal = thresholdMap.get(`board:${boardType}`);
    if (boardVal) return parseInt(boardVal, 10) || 5;
    const globalVal = thresholdMap.get(`global:`);
    if (globalVal) return parseInt(globalVal, 10) || 5;
    return parseInt(DEFAULTS['approval_threshold'], 10) || 5;
  }

  // Query 5 (conditional): Batch user votes
  const userVoteMap = new Map<number, number>();
  if (authenticatedUserId) {
    const userVoteRows = await db
      .select({
        proposalId: dbSchema.proposalVotes.proposalId,
        value: dbSchema.proposalVotes.value,
      })
      .from(dbSchema.proposalVotes)
      .where(
        and(
          inArray(dbSchema.proposalVotes.proposalId, proposalIds),
          eq(dbSchema.proposalVotes.userId, authenticatedUserId),
        ),
      );

    for (const uv of userVoteRows) {
      userVoteMap.set(uv.proposalId, uv.value);
    }
  }

  // Assemble results
  return proposals.map((proposal) => {
    const proposer = proposerMap.get(proposal.proposerId);
    const votes = voteMap.get(proposal.id) || { weightedUpvotes: 0, weightedDownvotes: 0 };
    const requiredUpvotes = resolveThreshold(proposal.climbUuid, proposal.boardType);
    const userVote = userVoteMap.get(proposal.id) || 0;
    const climb = climbMap.get(`${proposal.climbUuid}:${proposal.boardType}`);

    // Use proposal angle for stats, falling back to climb's default angle for classic proposals
    const effectiveAngle = proposal.angle ?? climb?.angle;
    const stats = effectiveAngle != null
      ? statsMap.get(`${proposal.climbUuid}:${proposal.boardType}:${effectiveAngle}`)
      : undefined;

    return {
      uuid: proposal.uuid,
      climbUuid: proposal.climbUuid,
      boardType: proposal.boardType,
      angle: proposal.angle,
      proposerId: proposal.proposerId,
      proposerDisplayName: proposer?.displayName || proposer?.name || undefined,
      proposerAvatarUrl: proposer?.avatarUrl || proposer?.image || undefined,
      type: proposal.type,
      proposedValue: proposal.proposedValue,
      currentValue: proposal.currentValue,
      status: proposal.status,
      reason: proposal.reason,
      resolvedAt: proposal.resolvedAt?.toISOString() || undefined,
      resolvedBy: proposal.resolvedBy,
      createdAt: proposal.createdAt.toISOString(),
      weightedUpvotes: votes.weightedUpvotes,
      weightedDownvotes: votes.weightedDownvotes,
      requiredUpvotes,
      userVote,
      climbName: climb?.name || undefined,
      frames: climb?.frames || undefined,
      layoutId: climb?.layoutId || undefined,
      climbSetterUsername: climb?.setterUsername || undefined,
      climbDifficulty: stats?.boulderName || undefined,
      climbQualityAverage: stats?.qualityAverage != null ? String(Math.round(stats.qualityAverage * 100) / 100) : undefined,
      climbAscensionistCount: stats?.ascensionistCount ?? undefined,
      climbDifficultyError: (stats?.difficultyAverage != null && stats?.displayDifficulty != null)
        ? String(Math.round((stats.difficultyAverage - stats.displayDifficulty) * 100) / 100)
        : undefined,
      climbBenchmarkDifficulty: (stats?.benchmarkDifficulty != null && stats.benchmarkDifficulty > 0)
        ? String(stats.benchmarkDifficulty)
        : undefined,
    };
  });
}

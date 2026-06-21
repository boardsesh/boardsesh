// Renders a finished session into an external activity and uploads it. Handles
// dedupe (one successful export row per provider/user/session), the manual
// retry path (resolver-driven), and the fire-and-forget auto-sync fan-out
// triggered when a session ends.

import { and, eq, inArray, lt, or } from 'drizzle-orm';
import type { SessionSummary, SessionParticipant, IntegrationExportResult } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { integrationCredentials, integrationExports } from '@boardsesh/db/schema';
import { getProvider, providerDbToEnum, SUPPORTED_PROVIDERS, type ProviderName } from './registry';
import { getFreshAccessToken, recordSyncSuccess, type IntegrationCredentialRow } from './credentials';
import { IntegrationHttpError } from './strava';
import type { SessionActivityInput } from './types';
import { logger } from '../utils/logger';
import { utcIsoToLocalWallClock } from '../utils/timezone';

const EXPORT_SESSION_TYPE = 'party';

// A 'pending' claim older than this is treated as abandoned (the process died
// mid-upload) and may be taken over by a retry.
const PENDING_CLAIM_TAKEOVER_MS = 10 * 60 * 1000;

/** Build the Strava activity name: "Kilter Board session — 3 sends". */
function buildActivityName(boardPath: string | null | undefined, sends: number): string {
  const label = boardLabel(boardPath);
  const sendWord = sends === 1 ? 'send' : 'sends';
  return `${label} — ${sends} ${sendWord}`;
}

/** "Kilter Board session" from a board path; "Board session" when unknown. */
function boardLabel(boardPath: string | null | undefined): string {
  if (!boardPath) return 'Board session';
  const firstSegment = boardPath.split('/').filter(Boolean)[0];
  if (!firstSegment) return 'Board session';
  const capitalized = firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1);
  return `${capitalized} Board session`;
}

/** "V5 ×3, V4 ×2" from the summary grade distribution (count = flash + send). */
function formatGradeDistribution(summary: SessionSummary): string {
  return summary.gradeDistribution.map((entry) => `${entry.grade} ×${entry.count}`).join(', ');
}

/**
 * Render the session summary into the activity payload from one participant's
 * perspective. The activity name uses that participant's own send count.
 */
export function buildSessionActivity(
  summary: SessionSummary,
  boardPath: string | null | undefined,
  participant: SessionParticipant,
  timezone?: string | null,
): SessionActivityInput {
  const descriptionLines: string[] = [];

  if (summary.hardestClimb) {
    descriptionLines.push(`Hardest: ${summary.hardestClimb.climbName} (${summary.hardestClimb.grade})`);
  }

  const gradeDistribution = formatGradeDistribution(summary);
  if (gradeDistribution) {
    descriptionLines.push(gradeDistribution);
  }

  descriptionLines.push(`${participant.sends} sends / ${participant.attempts} attempts`);
  descriptionLines.push('Logged with Boardsesh');

  // Strava interprets start_date_local literally, so convert the stored UTC
  // instant into the session's wall-clock local time. Without a recorded
  // timezone this falls back to UTC (pre-timezone sessions keep old behavior).
  const startDateLocal = utcIsoToLocalWallClock(summary.startedAt ?? new Date().toISOString(), timezone);
  // Strava rejects elapsed_time=0, so a session whose start and end coincide
  // (or arrive skewed) is floored to one second rather than failing upload.
  let elapsedSeconds = 1;
  if (summary.startedAt && summary.endedAt) {
    elapsedSeconds = Math.max(
      1,
      Math.round((new Date(summary.endedAt).getTime() - new Date(summary.startedAt).getTime()) / 1000),
    );
  }

  return {
    name: buildActivityName(boardPath, participant.sends),
    description: descriptionLines.join('\n'),
    startDateLocal,
    elapsedSeconds,
  };
}

function mapExportRowToResult(
  provider: ProviderName,
  sessionId: string,
  row: Pick<typeof integrationExports.$inferSelect, 'externalActivityId' | 'syncedAt' | 'error' | 'status'>,
): IntegrationExportResult {
  const externalActivityId = row.externalActivityId ?? null;
  // URL shape is provider-specific — never hardcode one platform's pattern
  // here or a second provider would silently emit wrong links.
  const providerImpl = getProvider(provider);
  return {
    provider: providerDbToEnum(provider),
    sessionId,
    externalActivityId,
    externalActivityUrl: externalActivityId && providerImpl ? providerImpl.activityUrl(externalActivityId) : null,
    syncedAt: row.syncedAt ? row.syncedAt.toISOString() : null,
    error: row.status === 'error' ? (row.error ?? 'Export failed') : null,
  };
}

async function findExportRow(
  provider: ProviderName,
  userId: string,
  sessionId: string,
): Promise<typeof integrationExports.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(integrationExports)
    .where(
      and(
        eq(integrationExports.provider, provider),
        eq(integrationExports.userId, userId),
        eq(integrationExports.sessionType, EXPORT_SESSION_TYPE),
        eq(integrationExports.sessionId, sessionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Atomically claim the export slot for (provider, user, session) by writing a
 * 'pending' row. The unique index makes this the serialization point between
 * the endSession auto-sync and a near-simultaneous manual sync: without it,
 * both would pass a SELECT-based dedupe check and create two Strava
 * activities. The conditional upsert only steals the slot from an 'error' row
 * (manual retry) or a stale 'pending' claim (abandoned upload); a 'success'
 * or fresh 'pending' row wins the conflict and we report it instead.
 *
 * Postgres only includes rows in RETURNING that were actually inserted or
 * updated — a conflict whose DO UPDATE ... WHERE predicate is false returns
 * nothing (pinned by the concurrent-claim test against real Postgres). The
 * returned-row check below additionally verifies the row carries OUR claim
 * (status + our exact syncedAt) as defense in depth against any driver or
 * ORM change to that contract.
 */
export async function claimExport(
  provider: ProviderName,
  userId: string,
  sessionId: string,
): Promise<{ claimed: boolean; blockingRow: typeof integrationExports.$inferSelect | null }> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - PENDING_CLAIM_TAKEOVER_MS);
  const claimedRows = await db
    .insert(integrationExports)
    .values({
      provider,
      userId,
      sessionType: EXPORT_SESSION_TYPE,
      sessionId,
      externalActivityId: null,
      status: 'pending',
      error: null,
      syncedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        integrationExports.provider,
        integrationExports.userId,
        integrationExports.sessionType,
        integrationExports.sessionId,
      ],
      set: { status: 'pending', error: null, syncedAt: now },
      setWhere: or(
        eq(integrationExports.status, 'error'),
        and(eq(integrationExports.status, 'pending'), lt(integrationExports.syncedAt, staleCutoff)),
      ),
    })
    .returning();

  const claimedRow = claimedRows[0];
  if (claimedRow && claimedRow.status === 'pending' && claimedRow.syncedAt.getTime() === now.getTime()) {
    return { claimed: true, blockingRow: null };
  }
  if (claimedRow) {
    // A returned row that doesn't carry our claim would mean the RETURNING
    // contract changed underneath us — treat it as a lost claim, never as won.
    return { claimed: false, blockingRow: claimedRow };
  }
  return { claimed: false, blockingRow: await findExportRow(provider, userId, sessionId) };
}

async function loadCredential(userId: string, provider: ProviderName): Promise<IntegrationCredentialRow | null> {
  const [row] = await db
    .select()
    .from(integrationCredentials)
    .where(and(eq(integrationCredentials.userId, userId), eq(integrationCredentials.provider, provider)))
    .limit(1);
  return row ?? null;
}

// Exported (like claimExport) so the real-Postgres test can pin the setWhere guard.
export async function upsertSuccessExport(
  provider: ProviderName,
  userId: string,
  sessionId: string,
  externalActivityId: string,
): Promise<void> {
  const now = new Date();
  await db
    .insert(integrationExports)
    .values({
      provider,
      userId,
      sessionType: EXPORT_SESSION_TYPE,
      sessionId,
      externalActivityId,
      status: 'success',
      error: null,
      syncedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        integrationExports.provider,
        integrationExports.userId,
        integrationExports.sessionType,
        integrationExports.sessionId,
      ],
      set: { externalActivityId, status: 'success', error: null, syncedAt: now },
      // Only a live 'pending' claim may be finalized. If our claim was stolen
      // (stale takeover) and the thief already finished, overwriting their
      // 'success' row would clobber its externalActivityId.
      setWhere: eq(integrationExports.status, 'pending'),
    });
}

// Exported (like claimExport) so the real-Postgres test can pin the setWhere guard.
export async function upsertErrorExport(
  provider: ProviderName,
  userId: string,
  sessionId: string,
  message: string,
): Promise<void> {
  const now = new Date();
  await db
    .insert(integrationExports)
    .values({
      provider,
      userId,
      sessionType: EXPORT_SESSION_TYPE,
      sessionId,
      externalActivityId: null,
      status: 'error',
      error: message,
      syncedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        integrationExports.provider,
        integrationExports.userId,
        integrationExports.sessionType,
        integrationExports.sessionId,
      ],
      set: { status: 'error', error: message, syncedAt: now },
      // Same guard as the success path: a late failure from a stolen claim
      // must not downgrade a row another caller already finalized.
      setWhere: eq(integrationExports.status, 'pending'),
    });
}

/** A credential is usable for export unless it has been revoked or expired. */
function isCredentialUsable(credRow: IntegrationCredentialRow, allowErrorStatus: boolean): boolean {
  if (credRow.status === 'active') return true;
  // Manual retries are allowed to run against a credential that previously hit
  // a non-auth error; an expired/revoked token still needs re-connecting.
  if (allowErrorStatus && credRow.status === 'error') return true;
  return false;
}

/**
 * Export one user's view of a party session to a provider. Returns a result
 * shaped for IntegrationExportResult.
 *
 * When `allowErrorStatus` is true (manual retry) a credential in 'error' state
 * is still attempted; 'expired'/'revoked' always require a re-connect.
 *
 * On upload failure an error export row is recorded and a 401 marks the
 * credential expired. The promise rejects so callers can branch (the resolver
 * catches and returns a result with `error` set; auto-sync logs and moves on).
 */
export async function syncPartySessionForUser(
  provider: ProviderName,
  userId: string,
  sessionId: string,
  summary: SessionSummary,
  boardPath: string | null | undefined,
  options: { allowErrorStatus?: boolean; timezone?: string | null } = {},
): Promise<IntegrationExportResult> {
  const allowErrorStatus = options.allowErrorStatus ?? false;

  // Resolve everything that can fail BEFORE taking the claim — a throw after
  // the claim would leave a 'pending' row blocking retries until the stale
  // takeover window elapses.
  const providerImpl = getProvider(provider);
  if (!providerImpl) {
    throw new Error(`Unsupported integration provider: ${provider}`);
  }

  const credRow = await loadCredential(userId, provider);
  if (!credRow) {
    throw new Error('Integration not connected');
  }
  if (!isCredentialUsable(credRow, allowErrorStatus)) {
    throw new Error(`Integration credential is not usable (status: ${credRow.status})`);
  }

  // Serialize against concurrent exports of the same session (endSession
  // auto-sync racing the summary screen's manual share). Losing the claim
  // means the session is already exported (return it) or another upload is in
  // flight (report it as in progress, never start a second one).
  const claim = await claimExport(provider, userId, sessionId);
  if (!claim.claimed) {
    if (claim.blockingRow) {
      return mapExportRowToResult(provider, sessionId, claim.blockingRow);
    }
    throw new Error('Export already in progress');
  }

  const participant = summary.participants.find((entry) => entry.userId === userId) ?? {
    userId,
    sends: 0,
    flashes: 0,
    attempts: 0,
  };
  const activity = buildSessionActivity(summary, boardPath, participant, options.timezone);

  let accessToken: string;
  try {
    accessToken = await getFreshAccessToken(credRow);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Token refresh failed';
    await upsertErrorExport(provider, userId, sessionId, message);
    throw error;
  }

  try {
    const uploaded = await providerImpl.uploadSessionActivity(accessToken, activity);
    await upsertSuccessExport(provider, userId, sessionId, uploaded.externalActivityId);
    await recordSyncSuccess(credRow.id);
    return {
      provider: providerDbToEnum(provider),
      sessionId,
      externalActivityId: uploaded.externalActivityId,
      externalActivityUrl: uploaded.url,
      syncedAt: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload failed';
    await upsertErrorExport(provider, userId, sessionId, message);
    if (error instanceof IntegrationHttpError && error.statusCode === 401) {
      await db
        .update(integrationCredentials)
        .set({ status: 'expired', lastError: message, updatedAt: new Date() })
        .where(eq(integrationCredentials.id, credRow.id));
    }
    throw error;
  }
}

/**
 * Fire-and-forget fan-out: when a session ends, upload it for every
 * participant with ANY supported integration connected and auto-sync on (one
 * activity per connected provider per participant). Never throws; one user's
 * failure does not block the others.
 */
export async function autoSyncSessionToIntegrations(
  sessionId: string,
  summary: SessionSummary | null,
  boardPath: string | null | undefined,
  timezone?: string | null,
): Promise<void> {
  if (!summary) return;
  if (!summary.participants || summary.participants.length === 0) return;
  if (!summary.startedAt || !summary.endedAt) return;

  const participantUserIds = summary.participants.map((entry) => entry.userId).filter(Boolean);
  if (participantUserIds.length === 0) return;

  const credentialRows = await db
    .select()
    .from(integrationCredentials)
    .where(
      and(
        inArray(integrationCredentials.provider, [...SUPPORTED_PROVIDERS]),
        eq(integrationCredentials.autoSyncEnabled, true),
        eq(integrationCredentials.status, 'active'),
        inArray(integrationCredentials.userId, participantUserIds),
      ),
    );

  for (const credRow of credentialRows) {
    const provider = credRow.provider as ProviderName;
    try {
      await syncPartySessionForUser(provider, credRow.userId, sessionId, summary, boardPath, { timezone });
    } catch (error) {
      logger.error(
        `[Integrations] auto-sync failed for ${provider} user ${credRow.userId} session ${sessionId}:`,
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
    }
  }
}

import { and, eq, exists } from 'drizzle-orm';
import type { ConnectionContext, IntegrationStatus, IntegrationExportResult } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import {
  DisconnectIntegrationSchema,
  IntegrationProviderArgsSchema,
  SetIntegrationAutoSyncSchema,
  SyncSessionToIntegrationSchema,
} from '../../../validation/schemas';
import { providerEnumToDb, providerDbToEnum, type ProviderName } from '../../../integrations/registry';
import { IntegrationHttpError } from '../../../integrations/strava';
import { disconnect, setAutoSync, type IntegrationCredentialRow } from '../../../integrations/credentials';
import { signIntegrationHandoff } from '../../../integrations/state';
import { syncPartySessionForUser } from '../../../integrations/export-service';
import { generateSessionSummary } from '../sessions/session-summary';

// Domain errors whose exact wording is ours and safe to show the user. Anything
// else (provider HTTP errors, fetch failures, shape guards) may carry internal
// detail and collapses to a generic message.
const SAFE_EXPORT_ERRORS = new Set<string>(['Integration not connected', 'Export already in progress']);

function sanitizeExportError(error: unknown): string {
  if (error instanceof Error) {
    if (SAFE_EXPORT_ERRORS.has(error.message)) return error.message;
    if (error.message.startsWith('Integration credential is not usable')) return error.message;
    if (error instanceof IntegrationHttpError) {
      return `The provider rejected the upload (status ${error.statusCode})`;
    }
  }
  return 'Export failed';
}

function credentialRowToStatus(provider: ProviderName, row: IntegrationCredentialRow): IntegrationStatus {
  return {
    provider: providerDbToEnum(provider),
    connected: true,
    externalAccountName: row.externalAccountName,
    autoSyncEnabled: row.autoSyncEnabled,
    status: row.status as IntegrationStatus['status'],
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastError: row.lastError,
  };
}

export const integrationMutations = {
  /**
   * Mint the short-lived, single-use handoff code that authenticates the
   * browser navigation to GET /integrations/:provider/start. The session JWT
   * stays in this authenticated GraphQL call's headers; only the 60-second
   * purpose-bound code ever appears in a URL.
   */
  createIntegrationOAuthHandoff: async (
    _: unknown,
    args: { provider: IntegrationStatus['provider'] },
    ctx: ConnectionContext,
  ): Promise<string> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'createIntegrationOAuthHandoff');
    const { provider } = validateInput(IntegrationProviderArgsSchema, args, 'args');
    return signIntegrationHandoff({ userId: ctx.userId!, provider: providerEnumToDb(provider) });
  },

  /**
   * Revoke + delete the user's credential for a provider. Returns false when
   * there was no credential to remove (already disconnected) — deliberately
   * not an error, so a double-tap or a retry after a dropped response stays
   * idempotent for the client.
   */
  disconnectIntegration: async (
    _: unknown,
    args: { provider: IntegrationStatus['provider'] },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    // Disconnect calls the provider's revoke endpoint — rate-limit so rapid
    // disconnect/reconnect cycles can't hammer it.
    await applyRateLimit(ctx, 10, 'disconnectIntegration');
    const { provider } = validateInput(DisconnectIntegrationSchema, args, 'args');
    const userId = ctx.userId!;
    return disconnect(userId, providerEnumToDb(provider));
  },

  /** Toggle automatic upload of finished sessions for a connected provider. */
  setIntegrationAutoSync: async (
    _: unknown,
    args: { provider: IntegrationStatus['provider']; enabled: boolean },
    ctx: ConnectionContext,
  ): Promise<IntegrationStatus> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'setIntegrationAutoSync');
    const { provider, enabled } = validateInput(SetIntegrationAutoSyncSchema, args, 'args');
    const userId = ctx.userId!;
    const providerName = providerEnumToDb(provider);

    const updated = await setAutoSync(userId, providerName, enabled);
    if (!updated) {
      throw new Error('Integration not connected');
    }
    return credentialRowToStatus(providerName, updated);
  },

  /**
   * Manually export a party session to a provider. Upload failures return a
   * result with the `error` field set (rather than throwing) so the mobile
   * client can surface a toast and offer a retry.
   */
  syncSessionToIntegration: async (
    _: unknown,
    args: { provider: IntegrationStatus['provider']; sessionId: string },
    ctx: ConnectionContext,
  ): Promise<IntegrationExportResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'syncSessionToIntegration');
    const { provider, sessionId } = validateInput(SyncSessionToIntegrationSchema, args, 'args');
    const userId = ctx.userId!;
    const providerName = providerEnumToDb(provider);

    // Authorize: the caller must be the session creator or have logged at least
    // one tick in it (the same creator-or-has-ticks rule used by
    // setSessionHealthKitWorkoutId, adapted to party ticks). The tick
    // check rides the session SELECT as an EXISTS so authorization reads one
    // consistent snapshot — two sequential queries would leave a window where
    // membership changes between them.
    const callerTickQuery = db
      .select({ uuid: dbSchema.boardseshTicks.uuid })
      .from(dbSchema.boardseshTicks)
      .where(and(eq(dbSchema.boardseshTicks.sessionId, sessionId), eq(dbSchema.boardseshTicks.userId, userId)));

    const [session] = await db
      .select({
        createdByUserId: dbSchema.boardSessions.createdByUserId,
        boardPath: dbSchema.boardSessions.boardPath,
        startedAt: dbSchema.boardSessions.startedAt,
        endedAt: dbSchema.boardSessions.endedAt,
        timezone: dbSchema.boardSessions.timezone,
        callerHasTick: exists(callerTickQuery).mapWith(Boolean),
      })
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, sessionId))
      .limit(1);

    if (!session) {
      throw new Error('Session not found');
    }
    if (!session.endedAt) {
      throw new Error('Session has not ended');
    }
    if (session.createdByUserId !== userId && !session.callerHasTick) {
      throw new Error('Not a participant of this session');
    }
    if (!session.startedAt) {
      throw new Error('Session has no start time');
    }

    const summary = await generateSessionSummary(sessionId);
    if (!summary) {
      throw new Error('Session has no recorded activity');
    }

    try {
      return await syncPartySessionForUser(providerName, userId, sessionId, summary, session.boardPath, {
        allowErrorStatus: true,
        timezone: session.timezone,
      });
    } catch (error) {
      // Upload-time failures are surfaced through the result rather than thrown
      // so the mobile client can toast them. The error export row is already
      // recorded inside syncPartySessionForUser. The message is sanitized —
      // provider/network errors can carry internal detail that must not reach
      // the client.
      return {
        provider: providerDbToEnum(providerName),
        sessionId,
        externalActivityId: null,
        externalActivityUrl: null,
        syncedAt: null,
        error: sanitizeExportError(error),
      };
    }
  },
};

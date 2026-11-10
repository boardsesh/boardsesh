import { GraphQLError } from 'graphql';
import type { ConnectedApp, ConnectedApps, ConnectionContext } from '@boardsesh/shared-schema';
import {
  disconnectConnectedApp,
  listConnectedApps,
  type ConnectedAppRecord,
} from '../../../auth/partner/connected-apps';
import { readPartnerOAuthMode, type PartnerOAuthMode } from '../../../auth/partner/mode';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';
import { applyRateLimit, requireAuthenticated } from '../shared/helpers';

/**
 * Connected apps: the climber's list of apps connected through partner OAuth,
 * and Disconnect. Unlike the developer console, both work in every
 * PARTNER_OAUTH_MODE, `off` and `hold` included, so a climber can always see
 * and end a connection. Neither loads Better Auth: the module below is plain SQL.
 */

type ConnectedAppsDatabase = Parameters<typeof listConnectedApps>[0];

/** Disconnects a minute: far above a person tapping a confirmation. */
const DISCONNECTS_PER_MINUTE = 30;
const BUSY_RETRY_AFTER_SECONDS = 2;
const MAX_CONNECTION_ID_LENGTH = 128;

let mode: PartnerOAuthMode | undefined;

/** Read once, from the environment, like every other partner surface. */
function partnerMode(): PartnerOAuthMode {
  mode ??= readPartnerOAuthMode();
  return mode;
}

export function __resetConnectedAppsModeForTests(): void {
  mode = undefined;
}

/** The GraphQL pool, like every other climber operation; the partner pool stays for OAuth traffic. */
const database = (): ConnectedAppsDatabase => db as unknown as ConnectedAppsDatabase;

function signedInClimber(ctx: ConnectionContext): string {
  requireAuthenticated(ctx);
  if (!ctx.userId) throw new Error('Authentication required to perform this operation');
  return ctx.userId;
}

function toConnectedApp(record: ConnectedAppRecord): ConnectedApp {
  return {
    connectionId: record.connectionId,
    name: record.name,
    publisherName: record.publisherName,
    scopes: record.scopes,
    connectedAt: record.connectedAt.toISOString(),
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    suspended: record.suspended,
  };
}

function connectionIdArgument(connectionId: unknown): string {
  if (typeof connectionId !== 'string' || connectionId.length === 0 || connectionId.length > MAX_CONNECTION_ID_LENGTH) {
    throw new GraphQLError('Invalid connection ID.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return connectionId;
}

function failed(operation: string, error: unknown): GraphQLError {
  // Name and database code only: a query error's text carries its parameters.
  logger.error('Connected apps operation failed', {
    operation,
    errorName: error instanceof Error ? error.name : 'unknown',
    postgresCode: getPostgresErrorCode(error),
  });
  return new GraphQLError('Something went wrong. Try again.', { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
}

export const connectedAppsQueries = {
  /** No sign-in needed: the mode is not a secret, and every partner route already shows it. */
  partnerAppsEnabled: (): boolean => partnerMode() !== 'off',

  myConnectedApps: async (_: unknown, _args: unknown, ctx: ConnectionContext): Promise<ConnectedApps> => {
    const userId = signedInClimber(ctx);
    let records: ConnectedAppRecord[];
    try {
      records = await listConnectedApps(database(), userId);
    } catch (error) {
      throw failed('myConnectedApps', error);
    }
    return { apps: records.map(toConnectedApp), partnerAppsEnabled: partnerMode() !== 'off' };
  },
};

export const connectedAppsMutations = {
  disconnectApp: async (
    _: unknown,
    { connectionId }: { connectionId: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    const userId = signedInClimber(ctx);
    await applyRateLimit(ctx, DISCONNECTS_PER_MINUTE, 'disconnectApp');
    const id = connectionIdArgument(connectionId);
    let outcome: Awaited<ReturnType<typeof disconnectConnectedApp>>;
    try {
      outcome = await disconnectConnectedApp(database(), { userId, connectionId: id });
    } catch (error) {
      throw failed('disconnectApp', error);
    }
    switch (outcome) {
      case 'disconnected':
        logger.info('Climber disconnected an app', { connectionId: id });
        return true;
      case 'already_disconnected':
        return true;
      case 'not_found':
        // The same answer for an unknown id and another climber's, so it reveals nothing.
        throw new GraphQLError('No such connected app.', { extensions: { code: 'NOT_FOUND' } });
      case 'busy':
        throw new GraphQLError('Busy. Try again shortly.', {
          extensions: { code: 'SERVICE_UNAVAILABLE', retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS },
        });
    }
  },
};

import { GraphQLError } from 'graphql';
import { sql } from 'drizzle-orm';
import { loadPartnerAuthority } from '../../auth/partner/load-authority';
import { findPartnerApiPrincipal, type PartnerApiPrincipal, type PartnerBearerResult } from '../../auth/partner/bearer';
import { lockPartnerConnection } from '../../auth/partner/locks';
import type { PartnerDatabase } from '../../auth/partner/tables';
import { runWithDatabaseTransaction, type DatabaseTransactionOptions } from '../../db/client';
import { GYM_MCP_RESOURCE, gymMcpAllowsUser, gymMcpIsServing, type GymMcpScope } from './configuration';

export type GymMcpPrincipal = PartnerApiPrincipal;
export type { GymMcpScope } from './configuration';

function denied(code: 'UNAUTHENTICATED' | 'FORBIDDEN'): never {
  throw new GraphQLError(
    code === 'UNAUTHENTICATED'
      ? 'Reconnect your assistant to Boardsesh.'
      : 'This connection cannot perform that gym operation.',
    {
      extensions: { code },
    },
  );
}

/** Checked against primary storage on every HTTP request; no first-party session token is accepted. */
export async function authenticateGymMcpBearer(accessToken: string): Promise<PartnerBearerResult> {
  if (!gymMcpIsServing()) return { refusal: 'client_disabled' };
  const runtime = await loadPartnerAuthority();
  if (!runtime?.gymMcpApi) return { refusal: 'client_disabled' };
  const result = await runtime.gymMcpApi.authenticate(accessToken);
  if (!result.principal || !gymMcpAllowsUser(runtime.configuration.gymMcp, result.principal.userId)) {
    return result.principal ? { refusal: 'client_disabled' } : result;
  }
  await runtime.gymMcpApi.recordUse(result.principal);
  return result;
}

/** All domain writes and their receipt commit while Disconnect waits on this same connection. */
export async function withGymMcpWrite<Result>(
  principal: GymMcpPrincipal,
  requiredScope: GymMcpScope,
  work: () => Promise<Result>,
  transactionOptions?: DatabaseTransactionOptions,
): Promise<Result> {
  if (!gymMcpIsServing()) denied('UNAUTHENTICATED');
  const runtime = await loadPartnerAuthority();
  if (!runtime?.gymMcpApi || !gymMcpAllowsUser(runtime.configuration.gymMcp, principal.userId)) denied('FORBIDDEN');
  return runWithDatabaseTransaction(async (executor) => {
    await executor.execute(
      sql`select set_config('lock_timeout', '2s', true), set_config('statement_timeout', '10s', true)`,
    );
    const transaction = executor as unknown as PartnerDatabase;
    const connection = await lockPartnerConnection(transaction, principal.userId, principal.clientId);
    if (
      !connection ||
      connection.id !== principal.connectionId ||
      connection.revokedAt ||
      connection.generation !== principal.connectionGeneration
    )
      denied('UNAUTHENTICATED');
    const current = await findPartnerApiPrincipal(transaction, {
      accessTokenHash: principal.accessTokenHash,
      resource: GYM_MCP_RESOURCE,
    });
    if (
      !current.principal ||
      current.principal.userId !== principal.userId ||
      current.principal.clientId !== principal.clientId ||
      current.principal.connectionGeneration !== principal.connectionGeneration
    )
      denied('UNAUTHENTICATED');
    if (!current.principal.scopes.includes(requiredScope)) denied('FORBIDDEN');
    return work();
  }, transactionOptions);
}

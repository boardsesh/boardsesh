import { and, count, desc, eq, gt, ilike, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import { oauthAppPolicy, oauthClient, oauthConnections, users } from '@boardsesh/db/schema/auth';
import { partnerAppCapAudit } from '@boardsesh/db/schema/app';
import type { AdminPartnerApp, AdminPartnerAppConnection, ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { requireAdmin } from '../social/roles';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const connectionCap = z.number().int().min(0).max(POSTGRES_INTEGER_MAX);
export const AdminPartnerAppsInputSchema = z.object({
  query: z.string().trim().max(200).nullish(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .nullish()
    .transform((limit) => limit ?? 50),
  offset: z
    .number()
    .int()
    .min(0)
    .max(POSTGRES_INTEGER_MAX)
    .nullish()
    .transform((offset) => offset ?? 0),
});
export const UpdatePartnerAppLimitsInputSchema = z.object({
  clientId: z.string().min(1).max(200),
  maxActiveConnections: connectionCap,
  maxNewConnectionsPerDay: connectionCap,
});

type DirectoryDatabase = Pick<typeof db, 'select'>;

function appSelection(database: DirectoryDatabase) {
  return database
    .select({
      clientId: oauthAppPolicy.clientId,
      name: oauthClient.name,
      publisherName: oauthAppPolicy.publisherName,
      ownerUserId: oauthAppPolicy.ownerUserId,
      ownerName: users.name,
      ownerEmail: users.email,
      homepageUrl: oauthClient.uri,
      createdAt: oauthAppPolicy.createdAt,
      disabled: oauthClient.disabled,
      suspendedAt: oauthAppPolicy.suspendedAt,
      suspensionReason: oauthAppPolicy.suspensionReason,
      maxActiveConnections: oauthAppPolicy.maxActiveConnections,
      maxNewConnectionsPerDay: oauthAppPolicy.maxNewConnectionsPerDay,
    })
    .from(oauthAppPolicy)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthAppPolicy.clientId))
    .innerJoin(users, eq(users.id, oauthAppPolicy.ownerUserId));
}

type AppRow = Awaited<ReturnType<typeof appSelection>>[number];

async function presentApps(database: DirectoryDatabase, rows: AppRow[], now: Date): Promise<AdminPartnerApp[]> {
  if (rows.length === 0) return [];
  const appIds = rows.map((app) => app.clientId);
  // Separate grouped counts avoid multiplying connections by token/grant rows.
  // Approval-only connections have no connectedAt and never count. A revoked
  // connection still counts toward the same rolling-day admission limit.
  const [activeCounts, recentCounts] = await Promise.all([
    database
      .select({ clientId: oauthConnections.clientId, connections: count() })
      .from(oauthConnections)
      .where(
        and(
          inArray(oauthConnections.clientId, appIds),
          isNotNull(oauthConnections.connectedAt),
          isNull(oauthConnections.revokedAt),
        ),
      )
      .groupBy(oauthConnections.clientId),
    database
      .select({ clientId: oauthConnections.clientId, connections: count() })
      .from(oauthConnections)
      .where(
        and(
          inArray(oauthConnections.clientId, appIds),
          gt(oauthConnections.connectedAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
        ),
      )
      .groupBy(oauthConnections.clientId),
  ]);
  const activeByClient = new Map(activeCounts.map((row) => [row.clientId, row.connections]));
  const recentByClient = new Map(recentCounts.map((row) => [row.clientId, row.connections]));
  return rows.map((app) => ({
    ...app,
    createdAt: app.createdAt.toISOString(),
    disabled: app.disabled === true,
    suspendedAt: app.suspendedAt?.toISOString() ?? null,
    activeConnections: activeByClient.get(app.clientId) ?? 0,
    newConnectionsLast24Hours: recentByClient.get(app.clientId) ?? 0,
  }));
}

export const adminPartnerAppQueries = {
  adminPartnerApps: async (
    _: unknown,
    { input }: { input?: unknown },
    ctx: ConnectionContext,
  ): Promise<AdminPartnerAppConnection> => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 60, 'adminPartnerApps');
    const { query, limit, offset } = validateInput(AdminPartnerAppsInputSchema, input ?? {}, 'input');
    const escapedQuery = query?.replace(/[\\%_]/g, '\\$&');
    const condition = escapedQuery
      ? or(
          ilike(oauthClient.name, `%${escapedQuery}%`),
          ilike(oauthAppPolicy.clientId, `%${escapedQuery}%`),
          ilike(oauthAppPolicy.publisherName, `%${escapedQuery}%`),
          ilike(users.name, `%${escapedQuery}%`),
          ilike(users.email, `%${escapedQuery}%`),
        )
      : undefined;
    const [totals, page] = await Promise.all([
      db
        .select({ total: count() })
        .from(oauthAppPolicy)
        .innerJoin(oauthClient, eq(oauthClient.clientId, oauthAppPolicy.clientId))
        .innerJoin(users, eq(users.id, oauthAppPolicy.ownerUserId))
        .where(condition),
      appSelection(db)
        .where(condition)
        .orderBy(desc(oauthAppPolicy.createdAt), desc(oauthAppPolicy.clientId))
        .limit(limit + 1)
        .offset(offset),
    ]);
    return {
      apps: await presentApps(db, page.slice(0, limit), new Date()),
      totalCount: totals[0]?.total ?? 0,
      hasMore: page.length > limit,
    };
  },
};

export const adminPartnerAppMutations = {
  updatePartnerAppLimits: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<AdminPartnerApp> => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 20, 'updatePartnerAppLimits');
    const limits = validateInput(UpdatePartnerAppLimitsInputSchema, input, 'input');
    return db.transaction(async (transaction) => {
      // Only this policy row is locked: issuers hold user/connection locks
      // before this same policy lock. This operation never locks those rows.
      const [previous] = await transaction
        .select()
        .from(oauthAppPolicy)
        .where(eq(oauthAppPolicy.clientId, limits.clientId))
        .for('no key update');
      if (!previous) throw new GraphQLError('App not found.', { extensions: { code: 'NOT_FOUND' } });
      await transaction
        .update(oauthAppPolicy)
        .set({
          maxActiveConnections: limits.maxActiveConnections,
          maxNewConnectionsPerDay: limits.maxNewConnectionsPerDay,
          updatedAt: new Date(),
        })
        .where(eq(oauthAppPolicy.clientId, limits.clientId));
      await transaction.insert(partnerAppCapAudit).values({
        clientId: limits.clientId,
        performedBy: ctx.userId!,
        previousMaxActiveConnections: previous.maxActiveConnections,
        previousMaxNewConnectionsPerDay: previous.maxNewConnectionsPerDay,
        maxActiveConnections: limits.maxActiveConnections,
        maxNewConnectionsPerDay: limits.maxNewConnectionsPerDay,
      });
      const rows = await appSelection(transaction).where(eq(oauthAppPolicy.clientId, limits.clientId));
      const [updated] = await presentApps(transaction, rows, new Date());
      if (!updated) throw new Error('Updated app disappeared.');
      return updated;
    });
  },
};

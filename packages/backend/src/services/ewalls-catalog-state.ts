import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { boardSharedSyncs } from '@boardsesh/db/schema';
import type { EwallsRecord, EwallsScope } from '@boardsesh/quantum-sync';
import type { Database } from '../db/client';
import { normalizeEwallsRouteId } from './ewalls-catalog-mapping';

/** Internal cursor rows remain in the existing shared-sync checkpoint table. */
export const EWALLS_CATALOG_STATE_PREFIX = '__local_ewalls_catalog__:';

const scopeSchema = z.object({
  board: z.string().max(256),
  forcedType: z.enum(['big', 'medium', 'small', 'xsmall', 'belay']),
});
const stateSchema = z.object({
  source: z.literal('ewalls-api'),
  upstreamAccountId: z.string().min(1).max(256),
  scope: scopeSchema,
  checkpoint: z.string().min(1).max(4096),
  routeIds: z.array(z.string().min(1).max(64)).max(25_000),
  diodes: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        autocadId: z.union([z.number(), z.string().max(32)]).optional(),
      }),
    )
    .max(25_000),
  hardwareFingerprint: z.string(),
  lastSuccessAt: z.string(),
});

export type EwallsCatalogState = z.infer<typeof stateSchema>;

export function ewallsCatalogStateKey(scope: EwallsScope, upstreamAccountId: string): string {
  scopeSchema.parse(scope);
  z.string().min(1).max(256).parse(upstreamAccountId);
  const digest = createHash('sha256')
    .update(JSON.stringify([upstreamAccountId, scope.board, scope.forcedType]))
    .digest('hex');
  return `${EWALLS_CATALOG_STATE_PREFIX}${digest}`;
}

export function readEwallsCatalogState(metadata: unknown): EwallsCatalogState {
  const parsed = stateSchema.parse(metadata);
  const state = { ...parsed, routeIds: parsed.routeIds.map(normalizeEwallsRouteId) };
  if (new Set(state.routeIds).size !== state.routeIds.length) throw new Error('Duplicate eWalls catalogue membership');
  return state;
}

export async function loadEwallsCatalogState(
  database: Pick<Database, 'select'>,
  scope: EwallsScope,
  upstreamAccountId: string,
): Promise<EwallsCatalogState | null> {
  const [row] = await database
    .select({ metadata: boardSharedSyncs.metadata })
    .from(boardSharedSyncs)
    .where(
      and(
        eq(boardSharedSyncs.boardType, 'quantum'),
        eq(boardSharedSyncs.tableName, ewallsCatalogStateKey(scope, upstreamAccountId)),
      ),
    );
  if (!row) return null;
  const state = readEwallsCatalogState(row.metadata);
  if (
    state.upstreamAccountId !== upstreamAccountId ||
    state.scope.board !== scope.board ||
    state.scope.forcedType !== scope.forcedType
  ) {
    throw new Error('eWalls catalogue checkpoint scope does not match its binding');
  }
  return state;
}

/** Metadata is source state only; bearer tokens and personal collections never enter it. */
export function makeEwallsCatalogState(input: {
  upstreamAccountId: string;
  scope: EwallsScope;
  checkpoint: string;
  routeIds: readonly string[];
  diodes: readonly EwallsRecord[];
  hardwareFingerprint: string;
  importedAt: Date;
}): EwallsCatalogState {
  return readEwallsCatalogState({
    source: 'ewalls-api',
    upstreamAccountId: input.upstreamAccountId,
    scope: input.scope,
    checkpoint: input.checkpoint,
    routeIds: [...input.routeIds].sort(),
    diodes: input.diodes,
    hardwareFingerprint: input.hardwareFingerprint,
    lastSuccessAt: input.importedAt.toISOString(),
  });
}

import { GraphQLError, type GraphQLFieldResolver, type GraphQLSchema } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import {
  CatalogRateLimitError,
  runCatalogQuery,
  type CatalogBudgetRequest,
  type CatalogIdentity,
} from '../utils/catalog-budget';

type CatalogResolver = GraphQLFieldResolver<unknown, ConnectionContext, Record<string, unknown>>;

/** Only authenticated credentials select an account bucket; client labels never do. */
export function catalogIdentity(context: ConnectionContext): CatalogIdentity {
  return {
    userId: context.isAuthenticated ? context.userId : undefined,
    service: !context.isAuthenticated && context.catalogClientIp === 'server-cache' ? 'www-catalog-cache' : undefined,
    trustedClientIp: context.catalogClientIp ?? context.trustedClientIp ?? context.socketPeerIp ?? 'unknown',
  };
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function boundedInteger(input: unknown, fallback: number, maximum: number): number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? Math.min(input, maximum) : fallback;
}

/** Reserve schema-enforced maxima. Aggregates are metered as work, not invented row counts. */
function requestFor(operation: string, args: Record<string, unknown>): CatalogBudgetRequest {
  const input = record(args.input);
  if (operation.startsWith('sync')) {
    return { operation, lane: 'sync', requestedRows: boundedInteger(args.limit, 500, 500) };
  }
  if (operation === 'setterStats') {
    return { operation, lane: 'interactive', requestedRows: 50, workUnits: 10 };
  }
  if (operation === 'holdHeatmap') {
    return { operation, lane: 'interactive', requestedRows: 0, workUnits: 10 };
  }
  if (operation === 'similarClimbs') {
    return { operation, lane: 'interactive', requestedRows: boundedInteger(input.limit, 25, 200), workUnits: 3 };
  }
  if (['setterClimbs', 'setterClimbsFull', 'userClimbs'].includes(operation)) {
    const offset = boundedInteger(input.offset, 0, 50_000);
    return {
      operation,
      lane: 'interactive',
      requestedRows: boundedInteger(input.limit, 20, 100),
      workUnits: 4 + Math.floor(offset / 5_000),
    };
  }
  if (['playlistClimbs', 'smartPlaylist', 'userFavoriteClimbs'].includes(operation)) {
    const page = boundedInteger(input.page, 0, 500);
    return {
      operation,
      lane: 'interactive',
      requestedRows: boundedInteger(input.pageSize, 20, 100),
      workUnits: 4 + Math.floor(page / 50),
    };
  }
  if (operation === 'climbStatsForClimbs') {
    const uuids = Array.isArray(args.climbUuids) ? args.climbUuids.length : 50;
    return { operation, lane: 'interactive', requestedRows: Math.min(uuids, 50) * 181, workUnits: 2 };
  }
  const requestedRows = ['climbStatsHistory', 'climbStatsForAngles', 'boardseshGradesForAngles'].includes(operation)
    ? 181
    : 1;
  return { operation, lane: 'interactive', requestedRows };
}

function returnedRows(result: unknown): number {
  if (result === null || result === undefined) return 0;
  if (Array.isArray(result)) return result.length;
  const { documents, climbs } = record(result);
  if (Array.isArray(documents)) return documents.length;
  return Array.isArray(climbs) ? climbs.length : 1;
}

async function guarded<Result>(
  context: ConnectionContext,
  request: CatalogBudgetRequest,
  work: () => Promise<Result>,
): Promise<Result> {
  try {
    return await runCatalogQuery(
      catalogIdentity(context),
      request,
      work,
      request.requestedRows === 0 ? () => 0 : returnedRows,
    );
  } catch (error) {
    if (!(error instanceof CatalogRateLimitError)) throw error;
    throw new GraphQLError(error.message, {
      extensions: {
        code: 'RATE_LIMITED',
        operation: request.operation,
        retryAfterSeconds: error.retryAfterSeconds,
        snapshotManifestUrl: error.snapshotManifestUrl,
      },
    });
  }
}

export const CATALOG_QUERY_OPERATIONS = [
  'climb',
  'setterStats',
  'setterClimbs',
  'setterClimbsFull',
  'userClimbs',
  'playlistClimbs',
  'smartPlaylist',
  'userFavoriteClimbs',
  'similarClimbs',
  'holdHeatmap',
  'climbStatsHistory',
  'climbStatsForAngles',
  'climbStatsForClimbs',
  'boardseshGrade',
  'boardseshGradesForAngles',
  'syncClimbs',
  'syncClimbStats',
  'syncClimbGrades',
] as const;

/** One schema serves both HTTP and WebSockets; aliases cannot escape these guards. */
export function instrumentCatalogAccess(schema: GraphQLSchema): void {
  const queryFields = schema.getQueryType()?.getFields();
  if (queryFields) {
    for (const operation of CATALOG_QUERY_OPERATIONS) {
      const field = queryFields[operation];
      if (!field?.resolve) continue;
      const resolve: CatalogResolver = field.resolve;
      field.resolve = (source, args, context: ConnectionContext, info) =>
        guarded(context, requestFor(operation, args), async () => resolve(source, args, context, info));
    }
  }

  // Search returns a lazy context. Hold permits around the child resolvers that
  // actually read Postgres, not the already-completed root resolver.
  const searchType = schema.getType('ClimbSearchResult');
  // Schema factories can load graphql's CJS entry while instrumentation loads
  // ESM. Inspect this known composite type's API without cross-realm instanceof.
  if (!searchType || !('getInterfaces' in searchType)) return;
  const fields = searchType.getFields();
  const resolveClimbs = fields.climbs?.resolve as CatalogResolver | undefined;
  const resolveHasMore = fields.hasMore?.resolve as CatalogResolver | undefined;
  const resolveCount = fields.totalCount?.resolve as CatalogResolver | undefined;
  const rowReads = new WeakMap<object, Promise<unknown>>();
  const countReads = new WeakMap<object, Promise<unknown>>();

  if (resolveClimbs) {
    const readClimbs: CatalogResolver = (source, args, context, info) => {
      const parent = record(source);
      const pending = rowReads.get(parent);
      if (pending) return pending;
      const searchParams = record(parent.searchParams);
      const page = boundedInteger(searchParams.page, 0, 500);
      const result = guarded(
        context,
        {
          operation: 'searchClimbs.climbs',
          lane: 'interactive',
          requestedRows: boundedInteger(searchParams.pageSize, 20, 100),
          workUnits: 1 + Math.floor(page / 50),
        },
        async () => resolveClimbs(source, args, context, info),
      );
      rowReads.set(parent, result);
      return result;
    };
    fields.climbs.resolve = readClimbs;
    if (resolveHasMore) {
      fields.hasMore.resolve = async (source, args, context: ConnectionContext, info) => {
        await readClimbs(source, args, context, info);
        return resolveHasMore(source, args, context, info);
      };
    }
  }
  if (resolveCount) {
    fields.totalCount.resolve = (source, args, context: ConnectionContext, info) => {
      const parent = record(source);
      const pending = countReads.get(parent);
      if (pending) return pending;
      const result = guarded(
        context,
        { operation: 'searchClimbs.totalCount', lane: 'interactive', requestedRows: 0, workUnits: 3 },
        async () => resolveCount(source, args, context, info),
      );
      countReads.set(parent, result);
      return result;
    };
  }
}

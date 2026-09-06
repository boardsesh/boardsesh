import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type { CncOrder } from '@boardsesh/db/schema';
import { CNC_CATALOG, CNC_CATALOG_VERSION, type CncCatalogEntry } from '../../../services/cnc/catalog';
import { getOrderByLicenceId, listOrdersForUser, toPublicOrder } from '../../../services/cnc/orders';
import {
  CncConfigMappingError,
  CncWorkerUnavailableError,
  CncWorkerValidationError,
  fetchLayout,
} from '../../../services/cnc/worker-client';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { CncLicenceIdSchema } from '../../../validation/schemas';
import { CNC_WORKER_UNAVAILABLE_CODE, invalidConfigError, resolveCncConfig } from './config';

/**
 * Read side of CNC build packs: what is on sale, what a configuration looks
 * like laid out on sheets, and the caller's own orders.
 */

/**
 * Ceiling on layout previews per minute.
 *
 * The preview is public and each one is a call out to the generator, so this
 * is what stands between an open endpoint and a way to make Boardsesh hammer
 * its own worker. Thirty is generous for a person flipping options (the 60 s
 * response cache absorbs the repeats) and low enough that a script gets bored.
 */
const RATE_LIMIT_CNC_LAYOUT = 30;
const RATE_LIMIT_CNC_LAYOUT_OP = 'cncLayout';

/**
 * Ceiling on hole-included layout previews per minute.
 *
 * Tighter than the hole-free preview because the response is ~40 KB bigger
 * and the endpoint is authenticated-only: there is no anonymous caller to
 * protect it from, only an authenticated one hammering it, so a lower human
 * ceiling is the right default.
 */
const RATE_LIMIT_CNC_LAYOUT_HOLES = 10;
const RATE_LIMIT_CNC_LAYOUT_HOLES_OP = 'cncLayoutHoles';

/**
 * What a buyer is told when generation failed.
 *
 * Fixed text, never `lastError`: the generator's message names internal
 * modules, config keys and occasionally file paths. The real error is in the
 * logs and in the admin email.
 */
const CNC_PUBLIC_FAILURE_MESSAGE =
  'This pack could not be generated. Boardsesh has been notified and will be in touch by email.';

type GraphQLManufacturingOption = {
  key: string;
  values: string[];
  defaultValue: string;
  valueType: string;
  kickerOnly: boolean;
};

/**
 * Flatten one catalogue option for the wire.
 *
 * The catalogue mixes strings, numbers and booleans inside a single option's
 * value list, which GraphQL has no type for short of a JSON blob. Sending the
 * values as strings alongside the `valueType` they should be read back as
 * keeps the field typed, keeps the client's select trivial, and keeps the
 * backend as the only place that decides what an allowed value actually is —
 * `validateCatalogOptions` matches a submitted value by its string form and
 * stores the catalogue's own typed one.
 */
function toGraphQLManufacturingOption(option: CncCatalogEntry['manufacturingOptions'][number]) {
  return {
    key: option.key,
    values: option.values.map((value) => String(value)),
    defaultValue: String(option.defaultValue),
    valueType: typeof option.defaultValue,
    kickerOnly: option.kickerOnly,
  } satisfies GraphQLManufacturingOption;
}

/**
 * Catalogue entry for the wire.
 *
 * `sizeAliases` is dropped on purpose: it is Aurora's LED-kit numbering, it is
 * only ever used server-side to resolve an alias onto the canonical size, and
 * publishing it would invite clients to do that resolution themselves and
 * diverge from us.
 */
function toGraphQLCatalogEntry(entry: CncCatalogEntry) {
  return {
    boardName: entry.boardName,
    layoutId: entry.layoutId,
    sizeId: entry.sizeId,
    setIds: entry.setIds,
    label: entry.label,
    kickerOptional: entry.kickerOptional,
    manufacturingOptions: entry.manufacturingOptions.map(toGraphQLManufacturingOption),
    tiers: entry.tiers.map((tier) => ({
      tier: tier.tier,
      amountCents: tier.priceCents,
      currency: tier.currency,
    })),
  };
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * One order row as the GraphQL `CncOrder` type.
 *
 * Runs on the output of `toPublicOrder`, so the fingerprint manifest, the claim
 * token, the worker id and the raw error are already gone by the time this is
 * reached — this function cannot leak them because it never sees them.
 */
export function toGraphQLOrder(order: CncOrder) {
  const publicOrder = toPublicOrder(order);
  return {
    id: String(publicOrder.id),
    licenceId: publicOrder.licenceId,
    tier: publicOrder.tier,
    status: publicOrder.status,
    boardName: publicOrder.boardName,
    layoutId: publicOrder.layoutId,
    sizeId: publicOrder.sizeId,
    setIds: publicOrder.setIds,
    options: publicOrder.options,
    artwork: publicOrder.artwork ?? [],
    licenseeName: publicOrder.licenseeName,
    customerSiteName: publicOrder.customerSiteName,
    amountCents: publicOrder.amountCents,
    currency: publicOrder.currency,
    createdAt: publicOrder.createdAt.toISOString(),
    paidAt: isoOrNull(publicOrder.paidAt),
    generatedAt: isoOrNull(publicOrder.generatedAt),
    zipSizeBytes: publicOrder.zipSizeBytes,
    downloadCount: publicOrder.downloadCount,
    lastDownloadedAt: isoOrNull(publicOrder.lastDownloadedAt),
    errorMessage: publicOrder.status === 'failed' ? CNC_PUBLIC_FAILURE_MESSAGE : null,
  };
}

/**
 * Turn a generator failure into a GraphQL error.
 *
 * The two cases stay apart all the way to the client: `CNC_WORKER_UNAVAILABLE`
 * means try again shortly, `CNC_INVALID_CONFIG` means change something. A UI
 * that cannot tell them apart shows "something went wrong" for both, and the
 * buyer with a genuinely bad configuration keeps retrying it.
 *
 * `resolveCncConfig` runs inside the same try/catch as the generator call
 * (see `cncLayout` / `validateCncArtwork`), so this also sees its errors: a
 * `CncConfigMappingError` classifies the same as a worker-side rejection, and
 * anything else — a `GraphQLError` `resolveCncConfig` already threw with its
 * own `extensions.code`, or a plain validation `Error` — passes through
 * unchanged rather than being reclassified as an outage.
 */
export function toGraphQLWorkerError(error: unknown): Error {
  if (error instanceof CncWorkerValidationError || error instanceof CncConfigMappingError) {
    return invalidConfigError(error.message, undefined);
  }
  if (error instanceof CncWorkerUnavailableError) {
    return new GraphQLError('The build-pack service is unavailable right now. Try again in a minute.', {
      extensions: { code: CNC_WORKER_UNAVAILABLE_CODE },
    });
  }
  if (error instanceof Error) {
    return error;
  }
  return new GraphQLError('The build-pack service could not be reached.', {
    extensions: { code: CNC_WORKER_UNAVAILABLE_CODE },
  });
}

export const cncPackQueries = {
  /**
   * Everything on sale. Public and unauthenticated: the configurator renders
   * boards, sizes and prices before anyone is asked to sign in.
   */
  cncCatalog: () => ({
    version: CNC_CATALOG_VERSION,
    entries: CNC_CATALOG.map(toGraphQLCatalogEntry),
  }),

  /**
   * Panel layout for a configuration, from the generator.
   *
   * Public, because the preview is the thing that makes someone want to buy —
   * but rate-limited and catalogue-gated first, so an unauthenticated caller
   * can only ask for layouts of walls that are actually for sale, and only at
   * a human pace. The hole-included variant is authenticated and held to a
   * tighter ceiling: it is roughly 40 KB bigger per response and exists for
   * the placement editor, not the anonymous preview that sells the pack.
   */
  cncLayout: async (
    _: unknown,
    { config, includeHoles }: { config: unknown; includeHoles?: boolean | null },
    ctx: ConnectionContext,
  ): Promise<unknown> => {
    const wantsHoles = includeHoles ?? false;
    if (wantsHoles) {
      requireAuthenticated(ctx);
      await applyRateLimit(ctx, RATE_LIMIT_CNC_LAYOUT_HOLES, RATE_LIMIT_CNC_LAYOUT_HOLES_OP);
    } else {
      await applyRateLimit(ctx, RATE_LIMIT_CNC_LAYOUT, RATE_LIMIT_CNC_LAYOUT_OP);
    }

    try {
      // Throws CNC_INVALID_CONFIG before any request leaves the process, so a
      // bad tuple or an out-of-range option never costs a generator round
      // trip. Run inside this try so a mapping error (bad option, unparseable
      // sheet stock) classifies the same way a worker rejection would.
      const { layoutRequest } = resolveCncConfig(config);
      return await fetchLayout(layoutRequest, { includeHoles: wantsHoles });
    } catch (error) {
      throw toGraphQLWorkerError(error);
    }
  },

  /** The caller's own orders, newest first. */
  myCncOrders: async (_: unknown, __: unknown, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const orders = await listOrdersForUser(ctx.userId!);
    return orders.map(toGraphQLOrder);
  },

  /**
   * One order by licence id.
   *
   * A licence id someone else owns returns null, exactly as a licence id that
   * does not exist does. Distinguishing them would turn the 29-bit id space
   * into an oracle for "is this licence real", which is worth nothing to a
   * legitimate caller and something to a leaker.
   */
  cncOrder: async (_: unknown, { licenceId }: { licenceId: string }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const validLicenceId = validateInput(CncLicenceIdSchema, licenceId, 'licenceId');

    const order = await getOrderByLicenceId(validLicenceId);
    if (!order || order.userId !== ctx.userId) return null;
    return toGraphQLOrder(order);
  },
};

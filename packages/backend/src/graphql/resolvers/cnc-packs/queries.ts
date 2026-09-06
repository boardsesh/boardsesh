import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import {
  CNC_ALLOWED_ARTWORK_KINDS,
  CNC_ARTWORK_FONTS,
  CNC_CATALOG,
  CNC_CATALOG_VERSION,
  CNC_DEFAULT_ARTWORK_FONT,
  type CncCatalogEntry,
} from '../../../services/cnc/catalog';
import { getOrderByLicenceId, listOrdersForUser } from '../../../services/cnc/orders';
import {
  CncConfigMappingError,
  CncWorkerUnavailableError,
  CncWorkerValidationError,
  fetchLayout,
} from '../../../services/cnc/worker-client';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { logger } from '../../../utils/logger';
import {
  CNC_MAX_ARTWORK_ITEMS,
  CNC_MAX_ARTWORK_TEXT_LENGTH,
  CNC_MAX_ARTWORK_WIDTH_MM,
  CNC_MIN_ARTWORK_WIDTH_MM,
  CncLicenceIdSchema,
} from '../../../validation/schemas';
import { CNC_WORKER_UNAVAILABLE_CODE, invalidConfigError, resolveCncConfig } from './config';
import { toGraphQLOrder } from './order-mapper';

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
 * Ceiling on catalogue and order reads per minute.
 *
 * These are cheap — the catalogue is a constant and an order read is one
 * indexed row — so the number is not about protecting a backend, it is about
 * not leaving an unmetered endpoint on the public schema. Sixty a minute is
 * far above any configurator or orders page and still bounds a scripted
 * caller. `cncOrder` gets its own bucket rather than sharing with the list so
 * a licence-id sweep cannot hide inside normal orders-page traffic.
 */
const RATE_LIMIT_CNC_READ = 60;
const RATE_LIMIT_CNC_CATALOG_OP = 'cncCatalog';
const RATE_LIMIT_MY_CNC_ORDERS_OP = 'myCncOrders';
const RATE_LIMIT_CNC_ORDER_OP = 'cncOrder';

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
  // Not an Error at all: a rejected promise carrying a string, a thrown
  // object, an undici `undefined`. Nothing downstream can classify it, so it
  // is reported as an outage — log it here or the only trace of the real
  // cause is a generic message the buyer sees. The value only; never the
  // request body, which carries the buyer's configuration.
  logger.error('[CNC] Non-Error thrown while reaching the pack generator', { error });
  return new GraphQLError('The build-pack service could not be reached.', {
    extensions: { code: CNC_WORKER_UNAVAILABLE_CODE },
  });
}

/**
 * The caller's user id, or a thrown error.
 *
 * `requireAuthenticated` proves `isAuthenticated`, but the context type does
 * not tie that flag to `userId` being set. A non-null assertion would turn a
 * context bug into a lookup for `userId = undefined` — which reads as "every
 * order" or "no orders" depending on the query — instead of an error.
 */
function requireUserId(ctx: ConnectionContext): string {
  requireAuthenticated(ctx);
  if (!ctx.userId) {
    throw new Error('Authentication required to perform this operation');
  }
  return ctx.userId;
}

/**
 * The font list with the default at the front.
 *
 * The schema documents position rather than adding a `defaultFont` field: a
 * client renders a select and preselects the first entry, which is exactly the
 * behaviour a separate field would have to be wired up to produce. Computed
 * once at module load — the list is a constant.
 */
const ARTWORK_FONTS_DEFAULT_FIRST: string[] = [
  CNC_DEFAULT_ARTWORK_FONT,
  ...CNC_ARTWORK_FONTS.filter((font) => font !== CNC_DEFAULT_ARTWORK_FONT),
];

export const cncPackQueries = {
  /**
   * Everything on sale. Public and unauthenticated: the configurator renders
   * boards, sizes and prices before anyone is asked to sign in.
   */
  cncCatalog: async (_: unknown, __: unknown, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, RATE_LIMIT_CNC_READ, RATE_LIMIT_CNC_CATALOG_OP);
    return {
      version: CNC_CATALOG_VERSION,
      entries: CNC_CATALOG.map(toGraphQLCatalogEntry),
      artworkFonts: ARTWORK_FONTS_DEFAULT_FIRST,
      // Published from the same constants that enforce them at checkout, so a
      // configurator's slider bounds and the server's rejection can never
      // disagree. A client that ignores them still gets CNC_INVALID_CONFIG.
      artworkRules: {
        maxItems: CNC_MAX_ARTWORK_ITEMS,
        minWidthMm: CNC_MIN_ARTWORK_WIDTH_MM,
        maxWidthMm: CNC_MAX_ARTWORK_WIDTH_MM,
        maxTextChars: CNC_MAX_ARTWORK_TEXT_LENGTH,
        // Spread into a fresh array: the constant is readonly and GraphQL
        // hands the value straight to the serialiser.
        allowedKinds: [...CNC_ALLOWED_ARTWORK_KINDS],
      },
    };
  },

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
    const userId = requireUserId(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_CNC_READ, RATE_LIMIT_MY_CNC_ORDERS_OP);
    const orders = await listOrdersForUser(userId);
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
    const userId = requireUserId(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_CNC_READ, RATE_LIMIT_CNC_ORDER_OP);
    const validLicenceId = validateInput(CncLicenceIdSchema, licenceId, 'licenceId');

    const order = await getOrderByLicenceId(validLicenceId);
    if (!order || order.userId !== userId) return null;
    return toGraphQLOrder(order);
  },
};

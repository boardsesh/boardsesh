import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { validateArtwork } from '../../../services/cnc/worker-client';
import {
  attachCheckoutSession,
  createPendingOrder,
  getAccountEmail,
  getOrderByLicenceId,
  transitionOrder,
} from '../../../services/cnc/orders';
import { attachAssetsToOrder } from '../../../services/cnc/art-assets';
import { createCheckoutSessionForOrder, isStripeConfigured } from '../../../services/cnc/stripe';
import { sendCncOrderStuckAdminEmail } from '../../../email/cnc-emails';
import { isDownloadable } from '../../../services/cnc/order-state';
import { createDownloadGrant, isDownloadGrantConfigured } from '../../../services/cnc/download-grant';
import { backendPublicUrl, webPublicUrl } from '../../../utils/public-urls';
import { logger } from '../../../utils/logger';
import { CncLicenceIdSchema, CreateCncCheckoutSessionInputSchema } from '../../../validation/schemas';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { requireAdmin } from '../social/roles';
import { artworkAssetIds, invalidConfigError, resolveArtworkAssets, resolveCncConfig } from './config';
import { toGraphQLOrder } from './order-mapper';
import { toGraphQLWorkerError } from './queries';

/**
 * Write side of CNC build packs: artwork validation, checkout, the download
 * grant a browser redeems, and the admin rebuild.
 */

/**
 * Ceiling on artwork validations per minute.
 *
 * Higher than the layout limit because the placement editor debounces against
 * this while the buyer drags — a minute of steady repositioning is genuinely
 * dozens of calls. Authenticated-only, so the bucket is per user rather than
 * per IP.
 */
const RATE_LIMIT_VALIDATE_ARTWORK = 60;
const RATE_LIMIT_VALIDATE_ARTWORK_OP = 'validateCncArtwork';

/**
 * Ceiling on checkout sessions per minute.
 *
 * Deliberately tiny. Every call writes an order row and asks Stripe for a
 * session, so a loop here fills the table with abandoned `pending_payment`
 * rows and burns Stripe's rate limit. Five is more attempts than anyone makes
 * honestly — a buyer who bounces off Checkout and comes back is one or two.
 */
const RATE_LIMIT_CREATE_CHECKOUT = 5;
const RATE_LIMIT_CREATE_CHECKOUT_OP = 'createCncCheckoutSession';

/** Stripe is off, misconfigured, or would not open a session. Nothing the buyer can fix. */
export const CNC_CHECKOUT_UNAVAILABLE_CODE = 'CNC_CHECKOUT_UNAVAILABLE';

function checkoutUnavailableError(): GraphQLError {
  return new GraphQLError('Checkout is unavailable right now. Nothing has been charged — try again in a minute.', {
    extensions: { code: CNC_CHECKOUT_UNAVAILABLE_CODE },
  });
}

/**
 * Ceiling on download grants per minute.
 *
 * A grant is cheap to mint but it is the thing that turns into a licensed file,
 * so this is what stops a compromised session from farming an unbounded supply
 * of five-minute links. Twenty is far more than a person clicking Download.
 */
const RATE_LIMIT_DOWNLOAD_GRANT = 20;
const RATE_LIMIT_DOWNLOAD_GRANT_OP = 'createCncDownloadGrant';

/** The order exists and is the caller's, but there is nothing to download yet. */
export const CNC_PACK_NOT_DOWNLOADABLE_CODE = 'CNC_PACK_NOT_DOWNLOADABLE';

/**
 * Not this caller's order — or not an order at all.
 *
 * One error for both, exactly as `Query.cncOrder` returns null for both: a
 * licence id identifies an order, it never grants access to one, and a
 * distinguishable "exists but not yours" turns the 29-bit id space into an
 * oracle for which licences are real.
 */
function orderNotFoundError(): GraphQLError {
  return new GraphQLError('No such order.', { extensions: { code: 'NOT_FOUND' } });
}

export const cncPackMutations = {
  /**
   * The authoritative verdict on a configuration's artwork.
   *
   * The placement editor runs its own collision maths for live feedback while
   * the buyer drags, but that copy exists to feel instant, not to be right.
   * This is the generator's own answer, computed by the same code that will
   * route the panel, and it is what the Buy button waits on.
   *
   * Authenticated because artwork items reference uploaded assets, and because
   * there is no reason for an anonymous caller to be exercising the generator's
   * most expensive endpoint.
   */
  validateCncArtwork: async (
    _: unknown,
    { config }: { config: unknown },
    ctx: ConnectionContext,
  ): Promise<{ ok: boolean; collisions: unknown }> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_VALIDATE_ARTWORK, RATE_LIMIT_VALIDATE_ARTWORK_OP);

    let verdict: unknown;
    try {
      // Run inside this try, alongside the generator call, so a mapping
      // error out of resolveCncConfig (bad option, unparseable sheet stock)
      // classifies as CNC_INVALID_CONFIG the same way a worker rejection does.
      const { layoutRequest, artwork, artworkInput } = resolveCncConfig(config);
      // The same ownership gate checkout runs, and for the same reason: this
      // call makes the generator FETCH an asset, so an unchecked id here would
      // be a way to have Boardsesh read somebody else's upload on request —
      // even if the only thing that comes back is "it fits".
      await resolveArtworkAssets(ctx.userId!, artworkInput);
      verdict = await validateArtwork(layoutRequest, artwork);
    } catch (error) {
      throw error instanceof GraphQLError ? error : toGraphQLWorkerError(error);
    }

    // Fail closed on a shape we do not recognise. A malformed verdict read as
    // "no collisions" would let unroutable artwork through to checkout, which
    // is the one outcome this call exists to prevent.
    const body = (typeof verdict === 'object' && verdict !== null ? verdict : {}) as {
      ok?: unknown;
      collisions?: unknown;
    };
    return {
      ok: body.ok === true,
      collisions: Array.isArray(body.collisions) ? body.collisions : [],
    };
  },

  /**
   * Reserve an order and open Stripe Checkout for it.
   *
   * The order row is written before the session, in `pending_payment`. That
   * order matters: the webhook finds the row by `metadata.orderId`, so the row
   * has to exist before a payment can possibly complete. An abandoned checkout
   * then leaves a `pending_payment` row that the `checkout.session.expired`
   * webhook cancels — a far better failure than a paid session whose order does
   * not exist.
   *
   * Nothing here queues generation. `pending_payment -> queued` happens in one
   * place only, the paid webhook, and that is what stops an unpaid order
   * reaching the worker.
   */
  createCncCheckoutSession: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<{ orderId: string; licenceId: string; checkoutUrl: string }> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_CREATE_CHECKOUT, RATE_LIMIT_CREATE_CHECKOUT_OP);

    const validated = validateInput(CreateCncCheckoutSessionInputSchema, input, 'input');

    // Checked before the order row is written, not after: an order created for
    // a checkout that can never open is a row that only ever gets cancelled.
    if (!isStripeConfigured()) {
      logger.error('[cnc-checkout] STRIPE_SECRET_KEY is not set; refusing to take an order');
      throw checkoutUnavailableError();
    }

    // Catalogue gate: board on sale, set ids real, options within their allowed
    // values. Throws CNC_INVALID_CONFIG before anything is written or charged.
    //
    // Inside a try because translating a configuration for the generator can
    // fail too, and `toGraphQLWorkerError` is the one place that decides which
    // code a failure carries. An error that is already a GraphQLError has been
    // classified — `resolveCncConfig`'s own CNC_INVALID_CONFIG — so it goes
    // through untouched rather than being relabelled as an outage.
    let resolved: ReturnType<typeof resolveCncConfig>;
    try {
      resolved = resolveCncConfig(validated.config);
    } catch (error) {
      throw error instanceof GraphQLError ? error : toGraphQLWorkerError(error);
    }
    const { entry, options, setIds, layoutRequest, artwork, artworkInput } = resolved;

    // Every asset the buyer named has to be theirs. Checked before the order
    // row and before Stripe, because the alternative is charging for a pack
    // built from a file we had no right to route — and because a foreign id is
    // the buyer's to fix, not an outage.
    const storedArtwork = await resolveArtworkAssets(ctx.userId!, artworkInput);

    const tierPrice = entry.tiers.find((candidate) => candidate.tier === validated.tier);
    if (!tierPrice) {
      throw invalidConfigError(`The ${validated.tier} tier is not sold for ${entry.label}.`);
    }

    // The generator's own verdict, and it has to pass. The editor's live
    // collision maths is an approximation that exists to feel instant; buying a
    // pack whose artwork cannot actually be routed produces a paid order that
    // is guaranteed to fail generation. Skipped entirely when there is no
    // artwork — most orders — so the common path costs no round trip.
    if (artwork.length > 0) {
      let verdict: unknown;
      try {
        verdict = await validateArtwork(layoutRequest, artwork);
      } catch (error) {
        throw toGraphQLWorkerError(error);
      }
      // Fails closed on an unrecognised verdict too: anything that is not an
      // explicit `ok: true` is a configuration we refuse to charge for.
      const isRoutable = (typeof verdict === 'object' && verdict !== null ? verdict : {}) as { ok?: unknown };
      if (isRoutable.ok !== true) {
        throw invalidConfigError('That artwork does not fit on the panel. Move it and try again.');
      }
    }

    const order = await createPendingOrder({
      userId: ctx.userId!,
      tier: validated.tier,
      // The catalogue's canonical tuple, not whatever alias the client asked
      // with, so the row records the wall that will actually be generated.
      boardName: entry.boardName,
      layoutId: entry.layoutId,
      sizeId: entry.sizeId,
      setIds: setIds.join(','),
      options,
      // The enriched copy, not the raw input: it carries each asset's key and
      // mime, so the order can still be generated after the upload rows are
      // gone with their owner's account.
      artwork: storedArtwork.length > 0 ? storedArtwork : null,
      licenseeName: validated.licenseeName,
      licenseeEmail: validated.licenseeEmail,
      customerSiteName: validated.customerSiteName,
      // The tick happened on this request. Stripe collects its own acceptance
      // at Checkout as well; this is the one made against the licence text the
      // buyer was actually shown.
      licenceAcceptedAt: new Date(),
      currency: tierPrice.currency,
      amountCents: tierPrice.priceCents,
    });

    // Stamped after the row exists, so an asset is only ever marked as bought
    // once there is an order to point at. Unlike the Stripe session below,
    // this is not best-effort: an attached count short of what was asked for
    // means an asset named in `storedArtwork` is no longer this buyer's (or
    // was already claimed by another order), and charging for a pack that
    // names artwork we did not actually bind to it is worse than refusing the
    // checkout outright.
    const assetIds = artworkAssetIds(artworkInput);
    if (assetIds.length > 0) {
      // Retire the reserved row the same way a failed Stripe session does,
      // then hand the buyer an error that is theirs to fix.
      const cancelForUnattachedArtwork = async (reason: string, details: Record<string, unknown>): Promise<never> => {
        logger.error(`[cnc-checkout] ${reason}; cancelling`, { orderId: order.id, ...details });
        try {
          await transitionOrder(order.id, 'checkoutFailed');
        } catch (cancelError) {
          logger.error('[cnc-checkout] failed to cancel the reserved order', { orderId: order.id, cancelError });
        }
        throw invalidConfigError('That artwork is not yours. Upload it again and retry.');
      };

      // -1 rather than 0: a genuine 0 is itself a mismatch worth its own
      // "attached fewer than named" log line, and must not read as the
      // sentinel for "the call threw before returning anything".
      let attachedCount = -1;
      try {
        attachedCount = await attachAssetsToOrder(order.id, ctx.userId!, assetIds);
      } catch (error) {
        await cancelForUnattachedArtwork('could not attach art assets to the order', { error });
      }
      if (attachedCount !== assetIds.length) {
        await cancelForUnattachedArtwork('attached fewer art assets than the order named', {
          expected: assetIds.length,
          attached: attachedCount,
        });
      }
    }

    const orderUrl = `${webPublicUrl()}/build-plans/orders/${encodeURIComponent(order.licenceId)}`;

    // Stripe's receipt and `customer_email` go to the signed-in account, not
    // the buyer-typed `licenseeEmail` — that field is the licence record (it
    // can name a teammate or a client) and has never been verified as
    // deliverable. A missing account email (the row exists but was never
    // filled in) falls back to it rather than failing the checkout outright.
    const accountEmail = await getAccountEmail(ctx.userId!);
    if (!accountEmail) {
      logger.warn('[cnc-checkout] account has no email on file; using the licensee email for Stripe', {
        userId: ctx.userId,
        orderId: order.id,
      });
    }

    let session: { sessionId: string; url: string };
    try {
      session = await createCheckoutSessionForOrder({
        order: { id: order.id, licenceId: order.licenceId },
        tier: tierPrice,
        successUrl: `${orderUrl}?checkout=success`,
        cancelUrl: `${orderUrl}?checkout=cancelled`,
        customerEmail: accountEmail ?? validated.licenseeEmail,
      });
    } catch (error) {
      logger.error('[cnc-checkout] Stripe would not open a session; cancelling the reserved order', {
        orderId: order.id,
        licenceId: order.licenceId,
        error: error instanceof Error ? error.message : error,
      });
      // Retire the row rather than leave a `pending_payment` order no webhook
      // will ever arrive for: without a session there is no
      // `checkout.session.expired` to cancel it, so it would sit in the buyer's
      // order list looking like an unfinished purchase forever.
      try {
        await transitionOrder(order.id, 'checkoutFailed');
      } catch (cancelError) {
        // Both halves failed, so the row is stranded: no session means no
        // `checkout.session.expired` webhook will ever cancel it, and the
        // cleanup that exists for exactly that case just threw. Nothing was
        // charged, but somebody has to retire this order by hand — so this is
        // the one path here that pages a human rather than only logging.
        logger.error('[cnc-checkout] order is stuck in pending_payment: checkout and its cleanup both failed', {
          orderId: order.id,
          licenceId: order.licenceId,
          error: error instanceof Error ? error.message : error,
          cancelError,
        });
        // Best-effort, like every other send: `sendCncOrderStuckAdminEmail`
        // logs and swallows its own failures, and the buyer's error must not
        // depend on SMTP.
        await sendCncOrderStuckAdminEmail({
          licenceId: order.licenceId,
          orderId: order.id,
          licenseeEmail: validated.licenseeEmail,
          checkoutError: error instanceof Error ? error.message : String(error),
          cancelError: cancelError instanceof Error ? cancelError.message : String(cancelError),
        });
      }
      throw checkoutUnavailableError();
    }

    // Best-effort: the session id is for support and the Stripe dashboard. The
    // webhook finds the order by `metadata.orderId`, so a lost write here costs
    // traceability, never a payment.
    const attached = await attachCheckoutSession(order.id, session.sessionId);
    if (!attached) {
      logger.warn('[cnc-checkout] could not attach the checkout session id', {
        orderId: order.id,
        sessionId: session.sessionId,
      });
    }

    return { orderId: String(order.id), licenceId: order.licenceId, checkoutUrl: session.url };
  },

  /**
   * Mint a five-minute download link for the caller's own pack.
   *
   * The grant exists because a browser navigation cannot carry an
   * Authorization header, and putting a session token in a URL — where it lands
   * in history, in a referrer and in every proxy log — is not an option. So the
   * grant is the weakest thing that works: one order, one user, five minutes,
   * no revocation, and the download route re-checks ownership and refund status
   * when it is redeemed anyway. The token says who asked; it never says what
   * they may have.
   *
   * `isDownloadable` is checked here as well as at redemption, so the order
   * page can show an accurate error rather than handing the buyer a link that
   * 409s.
   */
  createCncDownloadGrant: async (
    _: unknown,
    { licenceId }: { licenceId: string },
    ctx: ConnectionContext,
  ): Promise<{ url: string; expiresAt: string }> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_DOWNLOAD_GRANT, RATE_LIMIT_DOWNLOAD_GRANT_OP);

    const validLicenceId = validateInput(CncLicenceIdSchema, licenceId, 'licenceId');

    if (!isDownloadGrantConfigured()) {
      logger.error('[cnc-download] CNC_DOWNLOAD_TOKEN_SECRET is not set; cannot mint a grant');
      throw new GraphQLError('Downloads are unavailable right now. Try again in a minute.', {
        extensions: { code: CNC_PACK_NOT_DOWNLOADABLE_CODE },
      });
    }

    const order = await getOrderByLicenceId(validLicenceId);
    if (!order || order.userId !== ctx.userId) throw orderNotFoundError();

    if (!isDownloadable(order)) {
      throw new GraphQLError('This pack is not ready to download.', {
        extensions: { code: CNC_PACK_NOT_DOWNLOADABLE_CODE, status: order.status },
      });
    }

    const { token, expiresAt } = createDownloadGrant({ orderId: order.id, userId: order.userId! }, new Date());

    return {
      url: `${backendPublicUrl()}/api/cnc/packs/${encodeURIComponent(order.licenceId)}/download?token=${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString(),
    };
  },

  /**
   * Rebuild a pack. Admin only.
   *
   * Same licence id and same output key, so the regenerated zip REPLACES the
   * old one rather than issuing a second licensed copy of the same wall. The
   * generation counter is what tells the fingerprint trail the two builds
   * apart.
   *
   * The attempt budget resets: a `failed` order has already spent its three
   * attempts, and requeueing without a reset would give the rebuild exactly one
   * try. Reading `generation` outside the UPDATE is safe because the transition
   * is conditional on `ready`/`failed` — two concurrent regenerates cannot both
   * win, since the first moves the row to `queued`.
   */
  regenerateCncPack: async (_: unknown, { licenceId }: { licenceId: string }, ctx: ConnectionContext) => {
    await requireAdmin(ctx);

    const validLicenceId = validateInput(CncLicenceIdSchema, licenceId, 'licenceId');

    const order = await getOrderByLicenceId(validLicenceId);
    if (!order) throw orderNotFoundError();

    const now = new Date();
    const requeued = await transitionOrder(order.id, 'regenerate', {
      generation: order.generation + 1,
      queuedAt: now,
      attempts: 0,
      claimToken: null,
      workerId: null,
      claimedAt: null,
      heartbeatAt: null,
      lastError: null,
    });

    if (!requeued) {
      throw new GraphQLError(`An order in "${order.status}" cannot be regenerated.`, {
        extensions: { code: CNC_PACK_NOT_DOWNLOADABLE_CODE, status: order.status },
      });
    }

    logger.info('[cnc-regenerate] requeued a pack', {
      orderId: requeued.id,
      licenceId: requeued.licenceId,
      generation: requeued.generation,
      by: ctx.userId,
    });

    return toGraphQLOrder(requeued);
  },
};

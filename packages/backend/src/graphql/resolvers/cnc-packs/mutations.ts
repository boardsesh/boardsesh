import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { validateArtwork } from '../../../services/cnc/worker-client';
import {
  attachCheckoutSession,
  createPendingOrder,
  getAccountEmail,
  transitionOrder,
} from '../../../services/cnc/orders';
import { createCheckoutSessionForOrder, isStripeConfigured } from '../../../services/cnc/stripe';
import { webPublicUrl } from '../../../email/email-service';
import { logger } from '../../../utils/logger';
import { CreateCncCheckoutSessionInputSchema } from '../../../validation/schemas';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { invalidConfigError, resolveCncConfig } from './config';
import { toGraphQLWorkerError } from './queries';

/**
 * Write side of CNC build packs: artwork validation and checkout. Downloads and
 * regeneration land in a later PR.
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
      const { layoutRequest, artwork } = resolveCncConfig(config);
      verdict = await validateArtwork(layoutRequest, artwork);
    } catch (error) {
      throw toGraphQLWorkerError(error);
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
    const { entry, options, setIds, layoutRequest, artwork } = resolved;

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
      artwork: validated.config.artwork ?? null,
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
        logger.error('[cnc-checkout] failed to cancel the reserved order', { orderId: order.id, cancelError });
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
};

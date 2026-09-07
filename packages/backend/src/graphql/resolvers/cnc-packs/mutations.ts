import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { validateArtwork } from '../../../services/cnc/worker-client';
import {
  attachCheckoutSession,
  countOrdersCreatedSince,
  createPreviewOrder,
  findPreviewOrderByConfigHash,
  getAccountEmail,
  getOrderById,
  getOrderByLicenceId,
  transitionOrder,
} from '../../../services/cnc/orders';
import { attachAssetsToOrder, releaseArtAssetsForOrder } from '../../../services/cnc/art-assets';
import { findCatalogEntry } from '../../../services/cnc/catalog';
import { computeCncConfigHash } from '../../../services/cnc/config-hash';
import { createCheckoutSessionForOrder, isStripeConfigured } from '../../../services/cnc/stripe';
import { isCheckoutBypassEnabled } from '../../../services/cnc/checkout-bypass';
import { sendCncOrderStuckAdminEmail } from '../../../email/cnc-emails';
import { isDownloadable, type CncDeliverable } from '../../../services/cnc/order-state';
import { createDownloadGrant, isDownloadGrantConfigured } from '../../../services/cnc/download-grant';
import { backendPublicUrl, webPublicUrl } from '../../../utils/public-urls';
import { logger } from '../../../utils/logger';
import { CncLicenceIdSchema, FinaliseCncOrderInputSchema } from '../../../validation/schemas';
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
 * Ceiling on finalise calls per minute.
 *
 * Deliberately tiny. Every call asks Stripe for a session, so a loop here burns
 * Stripe's rate limit. Five is more attempts than anyone makes honestly — a
 * buyer who bounces off Checkout and comes back is one or two.
 */
const RATE_LIMIT_FINALISE = 5;
const RATE_LIMIT_FINALISE_OP = 'finaliseCncOrder';

/**
 * Previews per buyer per hour, and the window it is counted over.
 *
 * A preview is free and a generation is not: each one is real generator time on
 * a service sized for purchases. Four an hour is more iterations than a person
 * makes on one wall in a sitting, and re-asking for a configuration already
 * previewed does not spend one at all — that returns the existing order.
 *
 * Counted in the DATABASE rather than through `applyRateLimit`, whose window is
 * one minute. Four a minute is not the limit anyone meant, and an in-process
 * limiter that resets on every deploy is not a limit on something that costs
 * generator seconds. `applyRateLimit` still runs on top of it as the cheap
 * burst guard that never reaches Postgres.
 *
 * `CNC_PREVIEW_HOURLY_LIMIT` raises the ceiling on a dev stack, where four
 * previews is one afternoon of working on the configurator. Unset in
 * production, and a value that is not a positive number falls back to four
 * rather than to no limit at all.
 */
const PREVIEW_LIMIT_OVERRIDE = Number(process.env.CNC_PREVIEW_HOURLY_LIMIT);
const PREVIEWS_PER_HOUR =
  Number.isFinite(PREVIEW_LIMIT_OVERRIDE) && PREVIEW_LIMIT_OVERRIDE > 0 ? PREVIEW_LIMIT_OVERRIDE : 4;
const PREVIEW_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_CREATE_PREVIEW_OP = 'createCncPreview';

/** Stripe is off, misconfigured, or would not open a session. Nothing the buyer can fix. */
export const CNC_CHECKOUT_UNAVAILABLE_CODE = 'CNC_CHECKOUT_UNAVAILABLE';

/** The order exists and is the caller's, but it is not a `preview_ready` order waiting to be bought. */
export const CNC_ORDER_NOT_FINALISABLE_CODE = 'CNC_ORDER_NOT_FINALISABLE';

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
   * Generate a free, watermarked preview of a configuration.
   *
   * This is the top of the funnel and the only way an order row is ever
   * created: nothing is charged, nothing is licensed, and the buyer iterates
   * here as long as they like. Finalising one of these previews is the only way
   * a pack is ever bought, which is what makes "you cannot buy something you
   * have not seen" a property of the state machine rather than of the UI.
   *
   * Two things stop this being a free generator farm: `configHash` dedupe (the
   * same configuration returns the order it already made) and a four-an-hour
   * ceiling counted in the database.
   */
  createCncPreview: async (_: unknown, { config }: { config: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;
    // The per-minute burst guard. The real ceiling is hourly and lives below;
    // this one is here because it costs nothing and stops a runaway client
    // before it reaches Postgres at all.
    await applyRateLimit(ctx, PREVIEWS_PER_HOUR, RATE_LIMIT_CREATE_PREVIEW_OP);

    // Catalogue gate first: board on sale, set ids real, options within their
    // allowed values. Throws CNC_INVALID_CONFIG before anything is written or
    // any generator time is spent.
    let resolved: ReturnType<typeof resolveCncConfig>;
    try {
      resolved = resolveCncConfig(config);
    } catch (error) {
      throw error instanceof GraphQLError ? error : toGraphQLWorkerError(error);
    }
    const { entry, options, setIds, layoutRequest, artwork, artworkInput } = resolved;

    // Every asset the configuration names has to be theirs. Checked here, at
    // the ONLY point an order row is written, because this is where the copy of
    // the asset's key and mime is taken — everything downstream reads that copy.
    const storedArtwork = await resolveArtworkAssets(userId, artworkInput);

    // Hashed over the NORMALISED configuration, so two clients that reach the
    // same wall by different routes dedupe against each other.
    const configHash = computeCncConfigHash({
      boardName: entry.boardName,
      layoutId: entry.layoutId,
      sizeId: entry.sizeId,
      setIds: setIds.join(','),
      options,
      artwork: storedArtwork.length > 0 ? storedArtwork : null,
    });

    // Before the hourly count, deliberately: re-asking for a preview you
    // already have is how a client polls a queued one, and it must not cost a
    // slot in the budget.
    const existing = await findPreviewOrderByConfigHash(userId, configHash);
    if (existing) {
      logger.info('[cnc-preview] returning the existing preview for this configuration', {
        orderId: existing.id,
        licenceId: existing.licenceId,
        status: existing.status,
      });
      return toGraphQLOrder(existing);
    }

    const recentOrders = await countOrdersCreatedSince(userId, new Date(Date.now() - PREVIEW_WINDOW_MS));
    if (recentOrders >= PREVIEWS_PER_HOUR) {
      throw new GraphQLError(
        `That is ${String(PREVIEWS_PER_HOUR)} previews this hour. Take a look at the ones you have — the next one is on the hour.`,
        {
          extensions: {
            code: 'RATE_LIMITED',
            operation: RATE_LIMIT_CREATE_PREVIEW_OP,
            retryAfterSeconds: Math.ceil(PREVIEW_WINDOW_MS / 1000),
          },
        },
      );
    }

    // The generator's own verdict, and it has to pass. The editor's live
    // collision maths is an approximation that exists to feel instant;
    // previewing artwork that cannot be routed produces a job guaranteed to
    // fail. Skipped entirely when there is no artwork — most orders — so the
    // common path costs no round trip.
    if (artwork.length > 0) {
      let verdict: unknown;
      try {
        verdict = await validateArtwork(layoutRequest, artwork);
      } catch (error) {
        throw toGraphQLWorkerError(error);
      }
      // Fails closed on an unrecognised verdict too: anything that is not an
      // explicit `ok: true` is a configuration we refuse to queue.
      const isRoutable = (typeof verdict === 'object' && verdict !== null ? verdict : {}) as { ok?: unknown };
      if (isRoutable.ok !== true) {
        throw invalidConfigError('That artwork does not fit on the panel. Move it and try again.');
      }
    }

    const order = await createPreviewOrder({
      userId,
      // The catalogue's canonical tuple, not whatever alias the client asked
      // with, so the row records the wall that will actually be generated —
      // and so the hash above is over the same thing.
      boardName: entry.boardName,
      layoutId: entry.layoutId,
      sizeId: entry.sizeId,
      setIds: setIds.join(','),
      options,
      // The enriched copy, not the raw input: it carries each asset's key and
      // mime, so the order can still be generated after the upload rows are
      // gone with their owner's account.
      artwork: storedArtwork.length > 0 ? storedArtwork : null,
      configHash,
    });

    logger.info('[cnc-preview] queued a free preview', {
      orderId: order.id,
      licenceId: order.licenceId,
      boardName: order.boardName,
    });

    return toGraphQLOrder(order);
  },

  /**
   * Buy a previewed order: attach the licence, then open Stripe Checkout.
   *
   * The configuration is NOT re-submitted. It is already on the row, approved
   * by the buyer in the preview they are looking at, and taking it again here
   * would be a way to pay for one wall and receive another.
   *
   * `preview_ready -> pending_payment` happens here; `pending_payment ->
   * queued` still happens in exactly one place, the paid webhook. That is what
   * keeps an unpaid order out of the full-pack queue even though its own
   * preview went through the same worker minutes earlier.
   */
  finaliseCncOrder: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<{ orderId: string; licenceId: string; checkoutUrl: string }> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_FINALISE, RATE_LIMIT_FINALISE_OP);

    const validated = validateInput(FinaliseCncOrderInputSchema, input, 'input');

    // Read once and reused below, so the "should this request skip Stripe"
    // question is answered the same way at both ends of the resolver even if
    // the env moves underneath it mid-request.
    const bypassCheckout = isCheckoutBypassEnabled();

    // Checked before the order is touched, not after: moving a preview to
    // `pending_payment` for a checkout that can never open would strand it. The
    // dev bypass is the one case where a missing key is not a refusal — and it
    // is itself gated on that key being absent, so the two can never both be
    // true.
    if (!bypassCheckout && !isStripeConfigured()) {
      logger.error('[cnc-checkout] STRIPE_SECRET_KEY is not set; refusing to take an order');
      throw checkoutUnavailableError();
    }

    const order = await getOrderById(Number(validated.orderId));
    // Not found and not yours are one answer, exactly as `Query.cncOrder`
    // returns null for both.
    if (!order || order.userId !== ctx.userId) throw orderNotFoundError();

    if (order.status !== 'preview_ready') {
      throw new GraphQLError(
        order.status === 'pending_payment'
          ? 'This order is already waiting for payment. Open it to finish checking out.'
          : 'Generate a preview of this wall before buying it.',
        { extensions: { code: CNC_ORDER_NOT_FINALISABLE_CODE, status: order.status } },
      );
    }

    // Priced off the ORDER's own tuple, not off a client-supplied one. A wall
    // retired from the catalogue between preview and finalise cannot be priced,
    // and that is the honest answer rather than charging last week's number.
    const entry = findCatalogEntry({ boardName: order.boardName, layoutId: order.layoutId, sizeId: order.sizeId });
    if (!entry) {
      throw invalidConfigError('Boardsesh no longer sells a build pack for that wall.');
    }
    const tierPrice = entry.tiers.find((candidate) => candidate.tier === validated.tier);
    if (!tierPrice) {
      throw invalidConfigError(`The ${validated.tier} tier is not sold for ${entry.label}.`);
    }

    const finalised = await transitionOrder(order.id, 'finalise', {
      tier: validated.tier,
      licenseeName: validated.licenseeName,
      licenseeEmail: validated.licenseeEmail,
      customerSiteName: validated.customerSiteName,
      // The tick happened on this request. Stripe collects its own acceptance
      // at Checkout as well; this is the one made against the licence text the
      // buyer was actually shown.
      licenceAcceptedAt: new Date(),
      currency: tierPrice.currency,
      amountCents: tierPrice.priceCents,
      // The preview spent attempts on this row; the pack must not inherit them.
      // One order carries two generations now, and a wall whose preview needed a
      // retry would otherwise reach the paid queue with two tries left instead
      // of three. The lease fields go with them: a stale preview claim token
      // must not be able to report on the pack.
      attempts: 0,
      lastError: null,
      claimToken: null,
      workerId: null,
      claimedAt: null,
      heartbeatAt: null,
    });
    if (!finalised) {
      // Somebody else moved the row between the read and the UPDATE — a second
      // tab finalising, most likely.
      throw new GraphQLError('This order is no longer waiting to be bought. Reload the page.', {
        extensions: { code: CNC_ORDER_NOT_FINALISABLE_CODE, status: order.status },
      });
    }

    // Stamp the uploads this sale claims. Best-effort on purpose, unlike the
    // pre-preview flow this replaced: one upload can legitimately appear in
    // several orders now (every preview iteration is a row of its own, and a
    // buyer may build two walls with the same logo), so `order_id` is a cleanup
    // marker rather than an exclusive claim. Ownership was proven when the
    // preview row was written and the asset's key was copied onto it, so a
    // short attach costs traceability, never authorisation.
    const storedArtwork = Array.isArray(finalised.artwork) ? (finalised.artwork as { assetId?: string | null }[]) : [];
    const assetIds = artworkAssetIds(storedArtwork);
    if (assetIds.length > 0) {
      try {
        const attachedCount = await attachAssetsToOrder(finalised.id, ctx.userId!, assetIds);
        if (attachedCount !== assetIds.length) {
          logger.info('[cnc-checkout] some artwork was already stamped onto an earlier order', {
            orderId: finalised.id,
            expected: assetIds.length,
            attached: attachedCount,
          });
        }
      } catch (error) {
        logger.warn('[cnc-checkout] could not stamp art assets onto the order', { orderId: finalised.id, error });
      }
    }

    const orderUrl = `${webPublicUrl()}/build-plans/orders/${encodeURIComponent(finalised.licenceId)}`;

    // Development only: no Stripe, no webhook, no payment. The order is queued
    // here because on this stack nothing else ever will — which is precisely
    // why `isCheckoutBypassEnabled()` refuses to be true anywhere a card can be
    // charged. Everything downstream (worker claim, generation, download grant)
    // is the real path, unchanged.
    //
    // The buyer-facing side effects of a purchase are deliberately NOT fired:
    // the "order received" email and the `Build Plans Pack Purchased` analytics
    // event both live in the paid webhook, and a fake sale must not reach a
    // real inbox or a real funnel.
    if (bypassCheckout) {
      const paidAt = new Date();
      const queued = await transitionOrder(finalised.id, 'checkoutCompleted', {
        paidAt,
        queuedAt: paidAt,
        // The catalogue price, since there is no Stripe charge to read the real
        // number off. Same currency the order was reserved at.
        amountCents: tierPrice.priceCents,
        currency: tierPrice.currency,
        // Recognisable on sight in the order row and in support: no Stripe
        // session id ever looks like this.
        stripeCheckoutSessionId: `bypass-${finalised.licenceId}`,
        stripePaymentIntentId: null,
      });
      if (!queued) {
        // The row was moved to `pending_payment` microseconds ago and nothing
        // else on this stack moves it, so zero rows means the state machine and
        // this code disagree. Refuse rather than hand back a URL for an order
        // that was never queued.
        logger.error('[cnc-checkout] bypass could not queue the order it just finalised', {
          orderId: finalised.id,
          licenceId: finalised.licenceId,
        });
        throw checkoutUnavailableError();
      }
      logger.warn('[cnc-checkout] STRIPE BYPASSED: order queued without a payment (development only)', {
        orderId: finalised.id,
        licenceId: finalised.licenceId,
        tier: tierPrice.tier,
      });
      // Straight to the order page the Stripe success_url would have landed on,
      // so the web app's post-checkout handling is exercised too.
      return {
        orderId: String(finalised.id),
        licenceId: finalised.licenceId,
        checkoutUrl: `${orderUrl}?checkout=success`,
      };
    }

    // Stripe's receipt and `customer_email` go to the signed-in account, not
    // the buyer-typed `licenseeEmail` — that field is the licence record (it
    // can name a teammate or a client) and has never been verified as
    // deliverable. A missing account email (the row exists but was never
    // filled in) falls back to it rather than failing the checkout outright.
    const accountEmail = await getAccountEmail(ctx.userId!);
    if (!accountEmail) {
      logger.warn('[cnc-checkout] account has no email on file; using the licensee email for Stripe', {
        userId: ctx.userId,
        orderId: finalised.id,
      });
    }

    let session: { sessionId: string; url: string };
    try {
      session = await createCheckoutSessionForOrder({
        order: { id: finalised.id, licenceId: finalised.licenceId },
        tier: tierPrice,
        successUrl: `${orderUrl}?checkout=success`,
        cancelUrl: `${orderUrl}?checkout=cancelled`,
        customerEmail: accountEmail ?? validated.licenseeEmail,
      });
    } catch (error) {
      logger.error('[cnc-checkout] Stripe would not open a session; returning the order to its preview', {
        orderId: finalised.id,
        licenceId: finalised.licenceId,
        error: error instanceof Error ? error.message : error,
      });
      // Back to `preview_ready`, not to `cancelled`. Without a session there is
      // no `checkout.session.expired` webhook to retire the row, and the
      // preview it came from is still perfectly good — making a buyer
      // regenerate one because of our outage would cost them a slot in the
      // hourly budget as well as the wait.
      try {
        const returned = await transitionOrder(finalised.id, 'finaliseFailed');
        if (!returned) throw new Error('the order was no longer in pending_payment');
      } catch (revertError) {
        // Both halves failed, so the row is stranded in `pending_payment`: no
        // session means no `checkout.session.expired` webhook will ever cancel
        // it, and the cleanup that exists for exactly that case just threw.
        // Nothing was charged, but somebody has to retire this order by hand —
        // so this is the one path here that pages a human rather than only
        // logging.
        logger.error('[cnc-checkout] order is stuck in pending_payment: checkout and its cleanup both failed', {
          orderId: finalised.id,
          licenceId: finalised.licenceId,
          error: error instanceof Error ? error.message : error,
          revertError,
        });
        // Best-effort, like every other send: `sendCncOrderStuckAdminEmail`
        // logs and swallows its own failures, and the buyer's error must not
        // depend on SMTP.
        await sendCncOrderStuckAdminEmail({
          licenceId: finalised.licenceId,
          orderId: finalised.id,
          licenseeEmail: validated.licenseeEmail,
          checkoutError: error instanceof Error ? error.message : String(error),
          cancelError: revertError instanceof Error ? revertError.message : String(revertError),
        });
      }
      // Hand the artwork back. The stamp went on before Stripe was asked for a
      // session, so without this the buyer's upload stays bound to an order
      // that was never paid for.
      await releaseArtAssetsForOrder(finalised.id);
      throw checkoutUnavailableError();
    }

    // Best-effort: the session id is for support and the Stripe dashboard. The
    // webhook finds the order by `metadata.orderId`, so a lost write here costs
    // traceability, never a payment.
    const attached = await attachCheckoutSession(finalised.id, session.sessionId);
    if (!attached) {
      logger.warn('[cnc-checkout] could not attach the checkout session id', {
        orderId: finalised.id,
        sessionId: session.sessionId,
      });
    }

    return { orderId: String(finalised.id), licenceId: finalised.licenceId, checkoutUrl: session.url };
  },

  /**
   * Mint a five-minute download link for the caller's own pack, or for its
   * free preview.
   *
   * The grant exists because a browser navigation cannot carry an
   * Authorization header, and putting a session token in a URL — where it lands
   * in history, in a referrer and in every proxy log — is not an option. So the
   * grant is the weakest thing that works: one order, one user, five minutes,
   * no revocation, and the download route re-checks ownership and refund status
   * when it is redeemed anyway. The token says who asked; it never says what
   * they may have.
   *
   * `kind` is what the token is asked FOR, and it is re-checked at redemption:
   * a `PREVIEW` grant on a `preview_ready` order is not a way to reach the DXFs,
   * because the route asks the same question again about the same order.
   *
   * `isDownloadable` is checked here as well as at redemption, so the order
   * page can show an accurate error rather than handing the buyer a link that
   * 409s.
   */
  createCncDownloadGrant: async (
    _: unknown,
    { licenceId, kind }: { licenceId: string; kind?: string | null },
    ctx: ConnectionContext,
  ): Promise<{ url: string; expiresAt: string }> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_DOWNLOAD_GRANT, RATE_LIMIT_DOWNLOAD_GRANT_OP);

    const validLicenceId = validateInput(CncLicenceIdSchema, licenceId, 'licenceId');
    // The SDL defaults it to FULL, so a null here is only ever an explicit one.
    const deliverable: CncDeliverable = kind === 'PREVIEW' ? 'preview' : 'full';

    if (!isDownloadGrantConfigured()) {
      logger.error('[cnc-download] CNC_DOWNLOAD_TOKEN_SECRET is not set; cannot mint a grant');
      throw new GraphQLError('Downloads are unavailable right now. Try again in a minute.', {
        extensions: { code: CNC_PACK_NOT_DOWNLOADABLE_CODE },
      });
    }

    const order = await getOrderByLicenceId(validLicenceId);
    if (!order || order.userId !== ctx.userId) throw orderNotFoundError();

    if (!isDownloadable(order, deliverable)) {
      throw new GraphQLError(
        deliverable === 'preview' ? 'This preview is not ready yet.' : 'This pack is not ready to download.',
        { extensions: { code: CNC_PACK_NOT_DOWNLOADABLE_CODE, status: order.status } },
      );
    }

    const { token, expiresAt } = createDownloadGrant({ orderId: order.id, userId: order.userId! }, new Date());

    return {
      url:
        `${backendPublicUrl()}/api/cnc/packs/${encodeURIComponent(order.licenceId)}/download` +
        `?kind=${deliverable}&token=${encodeURIComponent(token)}`,
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

import {
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

/**
 * CNC build packs: one purchased manufacturing licence per row, and the row is
 * also the job queue the pack generator polls.
 *
 * Two jobs in one table on purpose. The generator is a separate service that
 * pulls work over HTTP; giving it a queue of its own would mean a second store
 * that can disagree with the order about whether a pack was paid for, refunded,
 * or already generated. A lease (claim_token + heartbeat_at + attempts) on the
 * order row keeps "who owns this pack right now" in the same place as "who is
 * allowed to download it", and `SELECT ... FOR UPDATE SKIP LOCKED` over
 * `(status, queued_at)` is all the queueing the volume here needs.
 */

/**
 * Lifecycle of one order.
 *
 * A row is born as a FREE PREVIEW (`preview_queued`), not as a sale: the buyer
 * iterates on watermarked, rasterised sheets for nothing and only pays when
 * they finalise. `pending_payment` is written at finalise, before Stripe
 * Checkout opens; everything after it is driven by a webhook or by the
 * generator. `refunded` is terminal for downloads (the pack stays generated,
 * access stops) and is deliberately distinct from `cancelled`, which only ever
 * means the checkout session expired before payment.
 *
 * A preview is an immutable snapshot of one configuration, which is why
 * re-previewing with a changed configuration writes a NEW row rather than
 * moving this one backwards.
 */
export const cncOrderStatusEnum = pgEnum('cnc_order_status', [
  'pending_payment',
  'queued',
  'generating',
  'ready',
  'failed',
  'cancelled',
  'refunded',
  // Appended rather than slotted in front of `pending_payment`, even though a
  // preview now comes first in time. Postgres enum order is only a sort order,
  // nothing here sorts by status, and appending is the one form of
  // `ALTER TYPE ... ADD VALUE` that needs no anchor and no type rewrite.
  'preview_queued',
  'preview_generating',
  'preview_ready',
  'preview_failed',
]);

/**
 * What the buyer is allowed to build. `personal` is one wall for their own
 * non-commercial use; `commercial_single` is one identified customer
 * installation, which is why those orders carry `customer_site_name`.
 */
export const cncLicenceTierEnum = pgEnum('cnc_licence_tier', ['personal', 'commercial_single']);

/** Buyer-chosen manufacturing options, validated against the catalog before the row is written. */
export type CncOrderOptions = Record<string, string | number | boolean>;

/** Artwork placements carried through to the generator. Shape is owned by the catalog/validation layer. */
export type CncOrderArtworkItem = Record<string, unknown>;

/** Covert + visible fingerprint channels the generator recorded. Never leaves the backend. */
export type CncFingerprintManifest = Record<string, unknown>;

export const cncOrders = pgTable(
  'cnc_orders',
  {
    // `mode: 'number'` rather than integration_exports' `'bigint'`: this id is
    // handed to the generator over JSON and back out through GraphQL, and a JS
    // BigInt does not survive either. Order volume is in the thousands, so
    // Number.MAX_SAFE_INTEGER is not a real ceiling.
    id: bigserial('id', { mode: 'number' }).primaryKey().notNull(),

    // The licence is the thing that was sold. It is printed on every DXF, in
    // the PDFs and in the zip, so it is the identifier every support request
    // and every leak investigation starts from — not the row id.
    licenceId: text('licence_id').notNull(),

    // `set null`, not the usual cascade: the manufacturing licence outlives the
    // Boardsesh account. Deleting an account must not erase the record that a
    // wall was licensed, or the fingerprint trail that maps a leaked file back
    // to the order. Deliberate deviation from the cascade every other user-owned
    // table uses; the buyer's identity survives in licensee_name/licensee_email.
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

    // Nullable until finalise: a preview is not a sale, so there is nothing to
    // license yet. Every row that reached `pending_payment` or beyond has one.
    tier: cncLicenceTierEnum('tier'),
    // No default, deliberately: an insert that forgets to set the status must
    // fail loudly rather than land in the queue as if it had been paid for.
    status: cncOrderStatusEnum('status').notNull(),

    // The board tuple, mirroring the URL segments (`/[board_name]/[layout_id]/[size_id]/[set_ids]`).
    boardName: text('board_name').notNull(),
    layoutId: integer('layout_id').notNull(),
    sizeId: integer('size_id').notNull(),
    // Comma-joined like the URL segment ("26,27") rather than an array, so the
    // value that reaches the generator is byte-identical to the one in the path.
    setIds: text('set_ids').notNull(),
    options: jsonb('options').$type<CncOrderOptions>().notNull(),
    artwork: jsonb('artwork').$type<CncOrderArtworkItem[]>(),
    // Which catalog produced `options`. A regenerate months later must rebuild
    // against the same option set, not whatever the catalog says today.
    catalogVersion: text('catalog_version').notNull(),

    // sha256 over the canonical board + options + artwork JSON. Two things
    // depend on it: asking for a preview of a configuration already previewed
    // returns the existing order instead of burning a second generation, and
    // the row records exactly which configuration the preview images show.
    // Nullable only for rows written before previews existed; every new row
    // has one (`computeCncConfigHash`).
    configHash: text('config_hash'),

    // Licence identity, captured at checkout and printed into the pack.
    licenseeName: text('licensee_name'),
    licenseeEmail: text('licensee_email'),
    customerSiteName: text('customer_site_name'),
    licenceAcceptedAt: timestamp('licence_accepted_at'),

    currency: text('currency'),
    amountCents: integer('amount_cents'),
    stripeCheckoutSessionId: text('stripe_checkout_session_id'),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    paidAt: timestamp('paid_at'),
    refundedAt: timestamp('refunded_at'),

    // Job lease. `claim_token` is handed to exactly one worker per claim; a
    // complete/fail report carrying a stale token is ignored, which is what
    // stops a worker that lost its lease from finishing over its replacement.
    queuedAt: timestamp('queued_at'),
    claimedAt: timestamp('claimed_at'),
    heartbeatAt: timestamp('heartbeat_at'),
    workerId: text('worker_id'),
    claimToken: text('claim_token'),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    // Bumped by an admin regenerate. Same licence id and same object key, so a
    // regenerated pack replaces the old one instead of issuing a second licence.
    generation: integer('generation').default(1).notNull(),

    generatedAt: timestamp('generated_at'),
    zipKey: text('zip_key'),
    zipSizeBytes: bigint('zip_size_bytes', { mode: 'number' }),
    zipSha256: text('zip_sha256'),
    // Which covert channels were written with which values. Exposing this would
    // hand a leaker the map to strip them, so it never reaches GraphQL or the
    // download route — see `toPublicOrder`.
    fingerprintManifest: jsonb('fingerprint_manifest').$type<CncFingerprintManifest>(),

    // The free preview: a watermarked, rasterised zip plus the individual
    // watermarked PNGs behind `CncOrder.previewImages`. Kept in their own
    // columns rather than reusing `zip_key`/`generated_at`, because an order
    // that has been finalised and generated holds BOTH — the buyer can still
    // look at the preview they approved after they have the real pack.
    previewZipKey: text('preview_zip_key'),
    previewZipSizeBytes: bigint('preview_zip_size_bytes', { mode: 'number' }),
    previewGeneratedAt: timestamp('preview_generated_at'),
    // Object keys of the watermarked PNGs, in sheet order. Every one is
    // verified to sit under the job's `previewPrefix` before it is stored, so
    // the image route can serve a stored key without it becoming a way to read
    // anything else in the private bucket.
    previewKeys: jsonb('preview_keys').$type<string[]>(),
    // How many previews this row has produced. A re-preview of a CHANGED
    // configuration is a new row, so this only ever counts retries of the same
    // one.
    previewsGenerated: integer('previews_generated').default(0).notNull(),

    downloadCount: integer('download_count').default(0).notNull(),
    lastDownloadedAt: timestamp('last_downloaded_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    licenceIdx: uniqueIndex('cnc_orders_licence_id_unique').on(table.licenceId),
    // Unique so a Stripe webhook redelivery cannot create a second order for
    // the same checkout session.
    checkoutSessionIdx: uniqueIndex('cnc_orders_stripe_checkout_session_unique').on(table.stripeCheckoutSessionId),
    // `charge.refunded` arrives with the payment intent, not the session.
    paymentIntentIdx: index('cnc_orders_stripe_payment_intent_idx').on(table.stripePaymentIntentId),
    userCreatedIdx: index('cnc_orders_user_created_idx').on(table.userId, table.createdAt.desc()),
    // Serves the preview dedupe: "has this buyer already previewed exactly this
    // configuration?" runs on every `createCncPreview`.
    userConfigHashIdx: index('cnc_orders_user_config_hash_idx').on(table.userId, table.configHash),
    // Serves the claim query's candidate scan (queued rows and stale leases).
    statusQueuedIdx: index('cnc_orders_status_queued_idx').on(table.status, table.queuedAt),
  }),
);

/**
 * Every Stripe event we have already acted on, keyed by Stripe's own event id.
 *
 * Stripe retries deliveries and can deliver the same event more than once even
 * without a retry, so the webhook inserts here with ON CONFLICT DO NOTHING
 * first: zero rows inserted means a duplicate and the handler returns 200
 * without touching the order. That makes the idempotency gate a database
 * uniqueness constraint rather than application logic that races with itself.
 */
export const cncStripeEvents = pgTable('cnc_stripe_events', {
  // Stripe's event id (`evt_...`), not a serial — the whole point is that the
  // primary key is the value Stripe repeats on a redelivery.
  id: text('id').primaryKey().notNull(),
  type: text('type').notNull(),
  // Nullable: an event we chose to ignore, or one that arrived before we could
  // resolve its order, still has to be recorded so a redelivery is a no-op.
  orderId: bigint('order_id', { mode: 'number' }).references(() => cncOrders.id, { onDelete: 'set null' }),
  receivedAt: timestamp('received_at').defaultNow().notNull(),
  // Stamped once the handler finished. A row with a null processed_at is an
  // event that was claimed and then died mid-handler — worth alerting on, and
  // the reason this is not just a boolean.
  processedAt: timestamp('processed_at'),
});

export type CncOrder = typeof cncOrders.$inferSelect;
export type NewCncOrder = typeof cncOrders.$inferInsert;
export type CncStripeEvent = typeof cncStripeEvents.$inferSelect;
export type NewCncStripeEvent = typeof cncStripeEvents.$inferInsert;

/**
 * One uploaded piece of artwork: a buyer's SVG, waiting to be routed onto a
 * panel.
 *
 * A row here is a receipt for bytes in the private bucket, not the bytes
 * themselves. It exists so three questions have one answer each: whose upload
 * is this (`user_id`), where does it live (`key`), and did anybody buy a pack
 * with it in (`order_id`). Without the row, the only record of an upload would
 * be an object key sitting in an order's `artwork` JSON — which would mean an
 * asset id in a checkout request could name any object in the bucket, and that
 * bucket also holds user data exports.
 *
 * The table is deliberately not the durable record of an ORDER's artwork. The
 * order's own `artwork` JSON carries the key and mime as well, because
 * `user_id` cascades: deleting an account erases these rows while the licence
 * (and its right to a regenerate) survives.
 */
export const cncArtAssets = pgTable(
  'cnc_art_assets',
  {
    // A uuid the uploader hands back in `CncArtworkInput.assetId`, not a serial:
    // the id is client-visible and enumerable ids would let one buyer walk
    // another's uploads by counting, even though every read is ownership-checked.
    id: text('id').primaryKey().notNull(),

    // Cascade, unlike `cnc_orders.user_id`. An upload is the buyer's own file
    // rather than a record of what they were sold: nothing about a licence, a
    // fingerprint trail or a refund needs it to outlive the account, so deleting
    // an account deletes it. The order keeps its own copy of the key and mime.
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // `cnc-art/<user_id>/<uuid>.<ext>` in the PRIVATE bucket. Unique because a
    // key is one object: two rows pointing at the same bytes would let deleting
    // one asset silently break the other's order.
    key: text('key').notNull(),
    // The content type the download route answers with. Sniffed at upload from
    // the bytes, never taken from the client's multipart header.
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),

    // Pixel dimensions, for a raster upload. Null for an SVG, which has no
    // intrinsic pixel size — the placement's `widthMm` is what sets its scale.
    widthPx: integer('width_px'),
    heightPx: integer('height_px'),

    // Of the STORED bytes (an SVG is sanitised and re-serialised before it is
    // written), so this hash identifies what the generator will actually read.
    sha256: text('sha256').notNull(),

    // The order this asset was bought into, stamped at checkout. Null means the
    // upload is still a draft — which is what a cleanup sweep looks for, since
    // an asset attached to an order can never be deleted while the licence
    // entitles its owner to a rebuild. `set null` rather than cascade for the
    // same reason: losing an order must not silently delete the file it named.
    orderId: bigint('order_id', { mode: 'number' }).references(() => cncOrders.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    keyIdx: uniqueIndex('cnc_art_assets_key_unique').on(table.key),
    // Serves the per-user upload quota and the buyer's own asset list.
    userCreatedIdx: index('cnc_art_assets_user_created_idx').on(table.userId, table.createdAt.desc()),
    // Serves the worker's asset lookup, which is always "this order's asset".
    orderIdx: index('cnc_art_assets_order_idx').on(table.orderId),
  }),
);

export type CncArtAsset = typeof cncArtAssets.$inferSelect;
export type NewCncArtAsset = typeof cncArtAssets.$inferInsert;

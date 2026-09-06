/**
 * CNC build packs: the client-facing shapes for the catalogue, a purchased
 * order, and the inputs that configure one.
 *
 * Mirrors `schema/cnc-packs.ts`. Nothing here describes the pack generator's
 * own request or response shapes — those are snake_case Python contracts that
 * never cross into a client, and the layout preview arrives as opaque JSON for
 * exactly that reason.
 */

/** What the buyer is allowed to build: one own wall, or one named customer installation. */
export type CncLicenceTier = 'personal' | 'commercial_single';

/** Lifecycle of one order. `refunded` is terminal for downloads; `cancelled` only ever means the checkout lapsed. */
export type CncOrderStatus =
  | 'pending_payment'
  | 'queued'
  | 'generating'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'refunded';

/** How a piece of artwork is cut: scored, cleared to depth, or right through the panel. */
export type CncArtworkMode = 'engrave' | 'pocket' | 'cut_through';

/**
 * What a piece of artwork is: a routed label, an uploaded drawing, or an
 * uploaded raster the generator traces first.
 *
 * The vocabulary, not the menu — `CncArtworkRules.allowedKinds` says which of
 * these checkout accepts today.
 */
export type CncArtworkKind = 'text' | 'svg' | 'png';

export type CncTierPrice = {
  tier: CncLicenceTier;
  amountCents: number;
  currency: string;
};

/**
 * One manufacturing choice with its complete allowed set.
 *
 * Values arrive as strings with a `valueType` tag because the catalogue mixes
 * strings, numbers and booleans inside one option's list. Coerce with
 * `valueType` before comparing; send back whichever string was chosen.
 */
export type CncManufacturingOption = {
  key: string;
  values: string[];
  defaultValue: string;
  valueType: string;
  /** True when this option only matters on a wall that is building a kicker. */
  kickerOnly: boolean;
};

/** One sellable board tuple. LED-kit size aliases resolve to `sizeId` server-side and are not published. */
export type CncCatalogEntry = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  label: string;
  kickerOptional: boolean;
  manufacturingOptions: CncManufacturingOption[];
  tiers: CncTierPrice[];
};

/**
 * The limits every piece of artwork is held to.
 *
 * Advisory to a client and binding on the server: the same numbers gate
 * checkout, so a configurator that enforces them locally is showing the buyer
 * the rejection before it happens rather than guessing at one.
 */
export type CncArtworkRules = {
  maxItems: number;
  minWidthMm: number;
  maxWidthMm: number;
  maxTextChars: number;
  /** The kinds checkout accepts today. A client hides anything not listed here. */
  allowedKinds: CncArtworkKind[];
};

export type CncCatalog = {
  version: string;
  entries: CncCatalogEntry[];
  /** Typeface keys a text label may be routed in, the first being the default. */
  artworkFonts: string[];
  artworkRules: CncArtworkRules;
};

/** Where one artwork item sits, in wall millimetres. `xMm`/`yMm` are its centre, not a corner. */
export type CncPlacementInput = {
  panelIndex: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  rotationDeg: number;
};

/** One artwork item. Exactly one of `assetId` (an uploaded SVG) or `text` (a routed label). */
export type CncArtworkInput = {
  assetId?: string | null;
  text?: string | null;
  /**
   * Which bundled typeface to outline `text` with, from `CncCatalog.artworkFonts`.
   * Null takes the generator's default; a face it does not bundle is rejected
   * rather than substituted. Meaningless for an `assetId` item.
   */
  font?: string | null;
  mode: CncArtworkMode;
  placement: CncPlacementInput;
};

/**
 * A board tuple plus its manufacturing choices. The same input drives the
 * layout preview, artwork validation and checkout, so a preview can never
 * disagree with what is bought.
 */
export type CncBoardConfigInput = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  /** Keyed by `CncManufacturingOption.key`. Missing keys take their default. */
  options: Record<string, string | number | boolean>;
  artwork?: CncArtworkInput[] | null;
};

/** One order as its buyer may see it. The fingerprint manifest and raw generator errors never appear. */
export type CncOrder = {
  id: string;
  licenceId: string;
  tier: CncLicenceTier;
  status: CncOrderStatus;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  options: Record<string, string | number | boolean>;
  artwork: unknown;
  licenseeName: string | null;
  customerSiteName: string | null;
  amountCents: number | null;
  currency: string | null;
  createdAt: string;
  paidAt: string | null;
  generatedAt: string | null;
  zipSizeBytes: number | null;
  downloadCount: number;
  lastDownloadedAt: string | null;
  /** A fixed public message when the order failed, null otherwise. */
  errorMessage: string | null;
};

/**
 * One order as an administrator sees it: the buyer's view plus the three fields
 * that view withholds.
 *
 * Nested rather than flattened for the same reason the SDL nests it — one
 * mapper builds the buyer's shape, and a second copy of its field list is how a
 * redaction stops applying on one of the two paths.
 */
export type CncAdminOrder = {
  order: CncOrder;
  /** Buyer-typed, not the account email. Where the licence and download link went. */
  licenseeEmail: string | null;
  /** Attempts spent against the three-attempt budget. */
  attempts: number;
  /** The generator's real error. Never shown to the buyer. */
  lastError: string | null;
};

/** One keyset-paginated page of the admin order list, newest first. */
export type CncOrderConnection = {
  orders: CncAdminOrder[];
  hasMore: boolean;
  /** Feed back as `cursor` for the next page; null at the end of the list. */
  cursor: string | null;
};

/** The generator's verdict on a configuration's artwork. `collisions` lists one entry per offending item. */
export type CncArtworkValidation = {
  ok: boolean;
  collisions: unknown;
};

/**
 * Everything checkout needs beyond the configuration: who the licence names,
 * how to reach them, and their acceptance of it.
 *
 * `acceptLicence` is typed as the literal `true` rather than a boolean. The
 * licence is the product, so a client that has not collected the acceptance has
 * nothing to send — and that is a compile error here rather than a rejection at
 * the server.
 */
export type CreateCncCheckoutSessionInput = {
  config: CncBoardConfigInput;
  tier: CncLicenceTier;
  licenseeName: string;
  licenseeEmail: string;
  /** Required for `commercial_single`, rejected for `personal`. */
  customerSiteName?: string | null;
  acceptLicence: true;
};

/**
 * An opened Stripe Checkout Session and the order it will pay for.
 *
 * The order already exists in `pending_payment` — creating a session is not a
 * payment, and nothing is queued for generation until the Stripe webhook
 * confirms the charge. The order page works from this moment; send the buyer to
 * `checkoutUrl` and they land back on it either way.
 */
export type CncCheckoutSession = {
  orderId: string;
  licenceId: string;
  checkoutUrl: string;
};

/**
 * A short-lived link to one pack.
 *
 * Deliberately not a credential to store: it lasts five minutes, names one
 * order and one user, and the download route re-checks ownership and refund
 * status when it is redeemed. Ask for a new one on every click rather than
 * caching this across a session.
 */
export type CncDownloadGrant = {
  url: string;
  /** ISO 8601. */
  expiresAt: string;
};

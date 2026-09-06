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

export type CncCatalog = {
  version: string;
  entries: CncCatalogEntry[];
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

/** The generator's verdict on a configuration's artwork. `collisions` lists one entry per offending item. */
export type CncArtworkValidation = {
  ok: boolean;
  collisions: unknown;
};

/**
 * The shape of the board-app comparison pages, shared by the page registry
 * (`app-guides.ts`, server-only) and the copy importer
 * (`scripts/app-guides/import-copy.ts`, a plain Node script).
 *
 * Text lives in the `appGuides` catalog, keyed by the stable ids below.
 * Everything that is not prose lives in `app-guide-registry.generated.ts`:
 * verdicts, source ids, source URLs and dates, screenshots and counts.
 */

/**
 * One page per app, not per board. The Aurora boards (Tension, Decoy, Touchstone,
 * Grasshopper, So iLL) run white-label builds of one app, so they share
 * `/apps/aurora`, with a section per brand at `/apps/aurora#<brand>`.
 */
export const APP_GUIDE_SLUGS = ['kilter', 'aurora', 'moonboard', 'woods'] as const;

export type AppGuideSlug = (typeof APP_GUIDE_SLUGS)[number];

/** The brands on the Aurora page, in display order. Their old `/apps/<brand>` URLs redirect to `/apps/aurora#<brand>`. */
export const AURORA_BRAND_SLUGS = ['tension', 'decoy', 'touchstone', 'grasshopper', 'so-ill'] as const;
export type AuroraBrandSlug = (typeof AURORA_BRAND_SLUGS)[number];

/** The hub's board tiles: one per board brand, whichever page covers it. */
export const HUB_BOARD_SLUGS = [
  'kilter',
  'tension',
  'moonboard',
  'decoy',
  'touchstone',
  'grasshopper',
  'so-ill',
  'woods',
] as const;
export type HubBoardSlug = (typeof HUB_BOARD_SLUGS)[number];

/** The guide that covers a hub board tile: its own page, or its section of the Aurora page. */
export function hubBoardHref(slug: HubBoardSlug): `/apps/${string}` {
  return (AURORA_BRAND_SLUGS as readonly string[]).includes(slug) ? `/apps/aurora#${slug}` : `/apps/${slug}`;
}
export type ComparisonPageId = AppGuideSlug | 'spray-wall-apps';
export type AppGuidePageId = 'hub' | ComparisonPageId;

export const APP_GUIDE_PAGE_IDS = [
  'hub',
  ...APP_GUIDE_SLUGS,
  'spray-wall-apps',
] as const satisfies readonly AppGuidePageId[];

export type VerificationDate = `${number}-${number}-${number}`;

/**
 * Who does a row better. `only` is a Boardsesh win the other apps do not
 * document at all; `same` is a tie; `competitor` names its winners;
 * `unlisted` says only that the other app does not document the feature, which
 * is not claimed as a win.
 */
export type GuideVerdict = 'boardsesh' | 'only' | 'same' | 'competitor' | 'unlisted';

/**
 * Display names of the apps a page compares against. Brand names, so they stay
 * out of the translation catalog. Board pages compare against one official app
 * (`official`); the spray wall page against several.
 */
export const COMPETITOR_NAMES = {
  kilter: { official: 'Kilter Board app' },
  aurora: { official: 'Aurora board apps' },
  moonboard: { official: 'MoonBoard app' },
  woods: { official: 'Woods Board app' },
  'spray-wall-apps': { stokt: 'Stōkt', crux: 'Crux', retroFlash: 'Retro Flash' },
} as const satisfies Record<ComparisonPageId, Record<string, string>>;

/** Real captures in the repo a page may show. No diagram ids here: diagrams are drawn, not captured. */
export const GUIDE_SHOTS = [
  'kilter',
  'tension',
  'moonboard',
  'queue',
  'wall-status',
  'profile',
  'spray-wall',
  'workouts',
  'logbook',
  'live-sessions',
  'spray-photo',
] as const;
export type GuideShot = (typeof GUIDE_SHOTS)[number];

/**
 * What a session step shows: a capture, the page's own board drawing, or nothing.
 * A board's climb, or the Kilter-filled queue, only ever appears on that board's
 * page (`STEP_SHOTS`); every page may use the board-neutral screens.
 */
export type StepArt = GuideShot | 'board' | null;

export const NEUTRAL_STEP_SHOTS = [
  'profile',
  'workouts',
  'logbook',
  'live-sessions',
] as const satisfies readonly GuideShot[];

export const STEP_SHOTS = {
  kilter: ['kilter', 'queue', 'wall-status'],
  aurora: ['tension'],
  moonboard: ['moonboard'],
  woods: [],
  'spray-wall-apps': ['spray-wall', 'spray-photo'],
} as const satisfies Record<ComparisonPageId, readonly GuideShot[]>;

export type GuideSource = { id: string; url: `https://${string}`; checkedAt: VerificationDate };

/** A block of copy that may cite sources. `pending` marks a `[PENDING-…]` placeholder (dev previews only). */
export type GuideItem = { id: string; sourceIds: readonly string[]; pending?: boolean };

export type GuideRow = GuideItem & {
  verdict: GuideVerdict;
  /** Competitor ids that do this row better. Set only when `verdict` is `competitor`. */
  winners: readonly string[];
  /** Competitors that match Boardsesh on a `boardsesh` row ("Boardsesh and Crux do it best"). */
  sharedWith?: readonly string[];
  /** Competitor cells that still hold a `[PENDING-…]` placeholder. */
  pendingCells: readonly string[];
};

type GuidePageBase = {
  updatedAt: VerificationDate;
  /** Sources behind the hero's lead (its numbers and ratings). */
  heroSourceIds: readonly string[];
  /** Whether the catalog carries `hero.byline`; older drafts did not. */
  hasByline: boolean;
  faq: readonly GuideItem[];
  sources: readonly GuideSource[];
  /**
   * Catalog paths (relative to the page) whose text makes a gated claim, e.g.
   * `comparison.rows.android`. See `GATED_CLAIMS` in `app-guides.ts`.
   */
  claims: readonly { path: string; claim: GatedClaimId }[];
};

export type ComparisonPageRegistry = GuidePageBase & {
  id: ComparisonPageId;
  pickIf: readonly string[];
  keepIf: readonly string[];
  tiles: readonly GuideItem[];
  competitors: readonly string[];
  rows: readonly GuideRow[];
  otherApps: readonly GuideItem[];
  steps: readonly { id: string; screenshot: StepArt }[];
  paths: readonly { id: string; steps: readonly string[] }[];
  /** Aurora page only: one card per brand, `id` is its `AuroraBrandSlug`. */
  brands: readonly GuideItem[];
};

export type HubPageRegistry = GuidePageBase & {
  id: 'hub';
  boards: readonly HubBoardSlug[];
  everyBoard: readonly GuideItem[];
  /** Whether the catalog carries `everyBoard.lead` (optional in the copy). */
  everyBoardLead: boolean;
  /**
   * The quiet "Want your board here?" card under the board tiles, for hold and LED
   * makers: its text lives in the catalog (`boards.makers`), its link here. Null
   * when the copy has no `boards.makers`.
   */
  makers: { href: `/${string}` } | null;
};

export type AppGuideRegistry = { hub: HubPageRegistry } & { [Id in ComparisonPageId]: ComparisonPageRegistry };

/**
 * A verbatim public store review. User-generated text: never translated, never
 * trimmed beyond the owner's marked ellipsis, and kept out of the catalog.
 */
export type GuideQuote = {
  id: string;
  text: string;
  /** App Store nickname, or first name and last initial (Play shows real names). */
  author: string;
  store: 'appStore' | 'googlePlay';
  /** The App Store storefront's country, in English; Play reviews carry none. */
  country: string | null;
  date: VerificationDate;
  pages: readonly AppGuidePageId[];
};

/** Claims that may only render where their evidence is registered. */
export type GatedClaimId = 'googleCertified';

/** The pages where a gated claim may render (if its sources are registered there too). */
export const GATED_CLAIM_PAGES: Record<GatedClaimId, readonly AppGuidePageId[]> = {
  googleCertified: ['moonboard'],
};

/**
 * The catalog paths the renderer can hide claim by claim. A claim anywhere else
 * on a page outside `GATED_CLAIM_PAGES` would render ungated, so the importer
 * refuses it.
 */
export const GATEABLE_PATH =
  /^(comparison\.rows|only\.tiles|faq\.items|verdict\.pickIf|verdict\.keepIf|everyBoard\.tiles)\.[^.]+$/;

export const GATED_CLAIM_PATTERNS: Record<GatedClaimId, RegExp> = {
  // The competitor half of the Android contrast ("needs a Google-certified phone").
  // Boardsesh's own half ("doesn't check for Google certification") is not gated.
  googleCertified: /google[- ]certified/i,
};

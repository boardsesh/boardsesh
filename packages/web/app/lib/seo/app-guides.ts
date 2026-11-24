import 'server-only';

import type { BoardName } from '@boardsesh/shared-schema';
import {
  APP_GUIDE_SLUGS,
  AURORA_BRAND_SLUGS,
  COMPETITOR_NAMES,
  GATED_CLAIM_PAGES,
  type AppGuidePageId,
  type AppGuideSlug,
  type ComparisonPageId,
  type ComparisonPageRegistry,
  type GatedClaimId,
  type GuideQuote,
  type GuideShot,
  type HubBoardSlug,
  type HubPageRegistry,
  hubBoardHref,
} from './app-guide-model';
import { APP_GUIDE_QUOTES, APP_GUIDE_REGISTRY } from './app-guide-registry.generated';

export { APP_GUIDE_SLUGS, AURORA_BRAND_SLUGS, hubBoardHref, type AppGuideSlug, type GuideShot, type HubBoardSlug };

/**
 * The board-app comparison pages: `/apps`, `/apps/<board>` and
 * `/compare/spray-wall-apps`.
 *
 * Three layers:
 * - `appGuides.json` holds every word, keyed by stable ids;
 * - `app-guide-registry.generated.ts` holds what the writers' copy files say
 *   about structure (verdicts, sources and their dates, screenshots, counts),
 *   written by `scripts/app-guides/import-copy.ts`;
 * - this file adds what is not copy: routes, board types, art, help links and
 *   the gate on claims that need registered evidence.
 */

type GuidePath = '/apps' | `/apps/${AppGuideSlug}` | '/compare/spray-wall-apps';
export type GuidePlacement = 'compare-hub' | `compare-${AppGuideSlug}` | 'compare-spray';
type CatalogBoard = Exclude<BoardName, 'spray'>;

export type RelatedLinkId =
  | 'bluetooth'
  | 'migration'
  | 'logbook'
  | 'sessions'
  | 'findingClimbs'
  | 'spray'
  | 'sprayComparison'
  | 'boards';
export type GuideLink = { id: RelatedLinkId; href: `/${string}` };

/** What fills the front hero frame: a real capture, the board as Boardsesh draws it, or the spray wall photo. */
export type HeroArt = { kind: 'shot'; shot: GuideShot } | { kind: 'board' };

export type ComparisonGuide = ComparisonPageRegistry & {
  kind: 'comparison';
  path: GuidePath;
  /**
   * The board for board-specific art (the hero card, the CTA band), or null
   * on the spray wall page. The Aurora page covers five boards and uses Tension's.
   */
  boardType: CatalogBoard | null;
  /** Every board type the page covers. */
  boardTypes: readonly CatalogBoard[];
  competitorNames: Readonly<Record<string, string>>;
  hero: { front: HeroArt; back: GuideShot };
  related: readonly GuideLink[];
  placement: GuidePlacement;
  /** The logbook section's button: an import route, or the logbook help where history can't come across. */
  logbookCta: 'import' | 'help';
  runsOn: RunsOn;
  primaryAction: PrimaryAction;
};

export type HubGuide = HubPageRegistry & {
  kind: 'hub';
  path: '/apps';
  related: readonly GuideLink[];
  placement: 'compare-hub';
  runsOn: RunsOn;
  primaryAction: PrimaryAction;
};

/**
 * What the hero's "Where Boardsesh runs" strip may say about lighting, per page.
 * `ios`: Bluetooth from the phone, or (spray walls) WLED over Wi-Fi.
 * `browser`: lights this board; lights the families the browser app supports
 * (the hub); or browse, queue and log only (no lighting claim).
 */
export type RunsOn = { ios: 'bluetooth' | 'wled'; browser: 'lights' | 'lightsFamilies' | 'browseOnly' };

/**
 * The page's one filled action: where the browser app opens and what the button
 * says it does. `board` deep-links to that board's climb list (the app's
 * `/<board>/<layout>/<size>/<sets>/<angle>/list` route); `spray-setup` opens the
 * spray wall setup; `root` the app's own board picker.
 */
export type PrimaryAction =
  /** www's public board gallery, at one family's section when `board` is set: no sign-in needed to browse. */
  | { kind: 'boards'; board?: CatalogBoard }
  /** The browser app's new spray wall flow: setting up a wall needs an account anyway. */
  | { kind: 'spray-setup' };

export type AppGuidePage = ComparisonGuide | HubGuide;
/** A board app page; `id` is one of APP_GUIDE_SLUGS. */
export type AppGuide = ComparisonGuide & { id: AppGuideSlug; boardType: CatalogBoard };

/**
 * Every App Store storefront's public rating for Boardsesh, added up: the sum of
 * `userRatingCount` and the count-weighted mean of `averageUserRating` from
 * Apple's public lookup (`itunes.apple.com/lookup?id=6761350784&country=<cc>`),
 * one call per storefront. Refresh with `vp run app-guides:rating`; anyone can
 * repeat it. App Store Connect can run a rating ahead of the lookup's cache (it
 * showed 73 on 2026-11-24). The link goes to the US listing.
 */
export const BOARDSESH_APP_STORE_RATING = {
  platform: 'Apple App Store',
  storefront: 'all',
  rating: 4.722,
  count: 72,
  storefronts: 17,
  source: 'https://apps.apple.com/us/app/boardsesh/id6761350784',
  method: 'Sum of the public iTunes lookup over every storefront, count-weighted mean (vp run app-guides:rating)',
  verifiedAt: '2026-11-24',
} as const;

/**
 * The public Google Play rating as the US listing shows it (4.6 from 38 on
 * 2026-11-24). The Play Console's default figure (4.816) is not what a reader
 * can check, so the page shows the public one.
 */
export const BOARDSESH_PLAY_RATING = {
  platform: 'Google Play',
  rating: 4.6,
  count: 38,
  source: 'https://play.google.com/store/apps/details?id=com.boardsesh.app&hl=en_US&gl=US',
  verifiedAt: '2026-11-24',
} as const;

/** Verbatim store reviews chosen for a page, in quotes.json order. */
export function quotesFor(pageId: AppGuidePageId): readonly GuideQuote[] {
  return APP_GUIDE_QUOTES.filter((quote) => quote.pages.includes(pageId));
}

/**
 * Claims that render only where their evidence is registered. The importer tags
 * every catalog string that makes one (`claims` in the registry); a page shows
 * it only if the page is listed here AND cites every source id the claim needs.
 *
 * `googleCertified`: "MoonBoard's Android app needs a Google-certified phone".
 * Sourced for MoonBoard only (a GrapheneOS forum thread quoting Moon support).
 * Never claimed for Kilter or the Aurora apps, and not on the hub.
 */
export const GATED_CLAIMS: Record<GatedClaimId, { pages: readonly AppGuidePageId[]; sourceIds: readonly string[] }> = {
  googleCertified: { pages: GATED_CLAIM_PAGES.googleCertified, sourceIds: ['grapheneos'] },
};

export function isClaimVisible(page: Pick<AppGuidePage, 'id' | 'claims' | 'sources'>, path: string): boolean {
  const known = new Set(page.sources.map((source) => source.id));
  return page.claims
    .filter((entry) => entry.path === path)
    .every(({ claim }) => {
      const gate = GATED_CLAIMS[claim];
      return gate.pages.includes(page.id) && gate.sourceIds.every((id) => known.has(id));
    });
}

const help = {
  bluetooth: { id: 'bluetooth', href: '/help/board-and-bluetooth' },
  migration: { id: 'migration', href: '/bring-your-logbook' },
  logbook: { id: 'logbook', href: '/help/logbook' },
  sessions: { id: 'sessions', href: '/help/sessions' },
  findingClimbs: { id: 'findingClimbs', href: '/help/finding-climbs' },
  spray: { id: 'spray', href: '/help/spray-walls' },
  sprayComparison: { id: 'sprayComparison', href: '/compare/spray-wall-apps' },
  boards: { id: 'boards', href: '/boards' },
} as const satisfies Record<RelatedLinkId, GuideLink>;

const BOARD_TYPES: Record<AppGuideSlug, readonly CatalogBoard[]> = {
  kilter: ['kilter'],
  aurora: ['tension', 'decoy', 'touchstone', 'grasshopper', 'soill'],
  moonboard: ['moonboard'],
  woods: ['woods'],
};

/**
 * Hero art. Only Kilter, Tension (for the Aurora page) and MoonBoard have their own
 * captures; Woods shows its real drawing rather than a Kilter screen under its name.
 */
const HERO: Record<ComparisonPageId, ComparisonGuide['hero']> = {
  kilter: { front: { kind: 'shot', shot: 'kilter' }, back: 'queue' },
  aurora: { front: { kind: 'shot', shot: 'tension' }, back: 'queue' },
  moonboard: { front: { kind: 'shot', shot: 'moonboard' }, back: 'queue' },
  woods: { front: { kind: 'board' }, back: 'profile' },
  'spray-wall-apps': { front: { kind: 'shot', shot: 'spray-wall' }, back: 'profile' },
};

const RELATED: Record<ComparisonPageId, readonly GuideLink[]> = {
  kilter: [help.bluetooth, help.migration, help.sessions],
  aurora: [help.boards, help.migration, help.bluetooth, help.sessions],
  moonboard: [help.bluetooth, help.findingClimbs, help.logbook],
  woods: [help.boards, help.bluetooth, help.logbook],
  'spray-wall-apps': [help.spray, help.sessions, help.logbook],
};

/**
 * "Bring your logbook" only where an import exists. Woods history can't be
 * imported (the page says so), and a spray wall has no other app's logbook to
 * bring, so both point at the logbook help instead.
 */
const LOGBOOK_CTA: Record<ComparisonPageId, ComparisonGuide['logbookCta']> = {
  kilter: 'import',
  aurora: 'import',
  moonboard: 'import',
  woods: 'help',
  'spray-wall-apps': 'help',
};

/**
 * The runs-on strip per page. Woods: browser lighting is untested there (its own
 * row says so). Spray: LEDs run through WLED over Wi-Fi, so no Bluetooth promise
 * and no browser lighting. Hub: browser lighting named for the boards that have it.
 */
const RUNS_ON: Record<AppGuidePageId, RunsOn> = {
  hub: { ios: 'bluetooth', browser: 'lightsFamilies' },
  kilter: { ios: 'bluetooth', browser: 'lights' },
  aurora: { ios: 'bluetooth', browser: 'lights' },
  moonboard: { ios: 'bluetooth', browser: 'lights' },
  woods: { ios: 'bluetooth', browser: 'browseOnly' },
  'spray-wall-apps': { ios: 'wled', browser: 'browseOnly' },
};

/**
 * Where each page's filled button goes (the label is `common.cta.<page>`). A board page opens
 * that family's section of www's board gallery, where each layout links to its public climb
 * list: the climber picks their own wall, and a signed-out visitor can browse without an
 * account. Never one preselected layout, size or angle. The Aurora page lands on Tension; the
 * other Aurora brands sit beside it in the gallery.
 */
const PRIMARY_ACTION: Record<AppGuidePageId, PrimaryAction> = {
  hub: { kind: 'boards' },
  kilter: { kind: 'boards', board: 'kilter' },
  aurora: { kind: 'boards', board: 'tension' },
  moonboard: { kind: 'boards', board: 'moonboard' },
  woods: { kind: 'boards', board: 'woods' },
  'spray-wall-apps': { kind: 'spray-setup' },
};

/** Art for a feature tile, by tile id. A tile without a capture gets a diagram, never a borrowed screen. */
export type TileArt =
  /** The profile capture cropped to its "Across your boards" card: the proof that one logbook holds every board. */
  | { kind: 'profile-card' }
  /** The real browser app on a Kilter wall (landscape). Kilter pages only: elsewhere it would show the wrong board. */
  | { kind: 'browser-shot' }
  | { kind: 'shot'; shot: GuideShot }
  | { kind: 'diagram'; diagram: 'browser' | 'android' | 'tablet' | 'devices' | 'board' };

const TILE_ART: Record<string, TileArt> = {
  browser: { kind: 'diagram', diagram: 'browser' },
  android: { kind: 'diagram', diagram: 'android' },
  tablet: { kind: 'diagram', diagram: 'tablet' },
  devices: { kind: 'diagram', diagram: 'devices' },
  'one-logbook': { kind: 'profile-card' },
  logbook: { kind: 'profile-card' },
  history: { kind: 'shot', shot: 'logbook' },
  queue: { kind: 'shot', shot: 'queue' },
  crew: { kind: 'shot', shot: 'queue' },
  'crew-queue': { kind: 'shot', shot: 'queue' },
  workouts: { kind: 'shot', shot: 'workouts' },
};

/** Browser tiles show the real Kilter browser capture where the page is about a Kilter Board. */
const BROWSER_SHOT_PAGES: readonly AppGuidePageId[] = ['kilter'];

export function tileArt(tileId: string, pageId?: AppGuidePageId): TileArt {
  if (tileId === 'browser' && pageId && BROWSER_SHOT_PAGES.includes(pageId)) return { kind: 'browser-shot' };
  return TILE_ART[tileId] ?? { kind: 'diagram', diagram: 'board' };
}

function comparisonGuide(id: ComparisonPageId): ComparisonGuide {
  const isSpray = id === 'spray-wall-apps';
  return {
    ...APP_GUIDE_REGISTRY[id],
    id,
    kind: 'comparison',
    path: isSpray ? '/compare/spray-wall-apps' : `/apps/${id}`,
    boardType: isSpray ? null : BOARD_TYPES[id][0],
    boardTypes: isSpray ? [] : BOARD_TYPES[id],
    competitorNames: COMPETITOR_NAMES[id],
    hero: HERO[id],
    related: RELATED[id],
    placement: isSpray ? 'compare-spray' : `compare-${id}`,
    logbookCta: LOGBOOK_CTA[id],
    runsOn: RUNS_ON[id],
    primaryAction: PRIMARY_ACTION[id],
  };
}

export const APP_GUIDES: readonly AppGuide[] = APP_GUIDE_SLUGS.map((slug) => comparisonGuide(slug) as AppGuide);

export function getAppGuide(slug: string): AppGuide | undefined {
  return APP_GUIDES.find((guide) => guide.id === slug);
}

export const APP_GUIDE_HUB: HubGuide = {
  ...APP_GUIDE_REGISTRY.hub,
  kind: 'hub',
  path: '/apps',
  related: [help.boards, help.bluetooth, help.sessions],
  placement: 'compare-hub',
  runsOn: RUNS_ON.hub,
  primaryAction: PRIMARY_ACTION.hub,
};

export const APP_GUIDE_COMPARISON: ComparisonGuide = comparisonGuide('spray-wall-apps');

export const ALL_APP_GUIDE_PAGES: readonly AppGuidePage[] = [APP_GUIDE_HUB, ...APP_GUIDES, APP_GUIDE_COMPARISON];

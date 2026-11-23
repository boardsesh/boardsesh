import 'server-only';

import type { BoardName } from '@boardsesh/shared-schema';

export const APP_GUIDE_SLUGS = [
  'kilter',
  'tension',
  'moonboard',
  'decoy',
  'touchstone',
  'grasshopper',
  'so-ill',
  'woods',
] as const;

export type AppGuideSlug = (typeof APP_GUIDE_SLUGS)[number];
type GuidePath = '/apps' | `/apps/${AppGuideSlug}` | '/compare/spray-wall-apps';
type VerificationDate = `${number}-${number}-${number}`;
type GuideScreenshot = 'kilter' | 'tension' | 'moonboard' | 'spray-wall' | 'queue';
type GuideCompetitor = 'official' | 'stokt' | 'retroFlash';

type GuideSection = { id: string };
type GuideComparisonRow = GuideSection & { sourceIds: readonly string[] };
type GuideSource = GuideSection & { url: `https://${string}`; checkedAt: VerificationDate };
type GuideLink = GuideSection & { href: `/${string}` };

type GuidePageContent = {
  path: GuidePath;
  updatedAt: VerificationDate;
  workflow: readonly GuideSection[];
  comparisonRows: readonly GuideComparisonRow[];
  competitors: readonly GuideCompetitor[];
  sources: readonly GuideSource[];
  related: readonly GuideLink[];
};

export type AppGuide<Slug extends AppGuideSlug = AppGuideSlug> = GuidePageContent & {
  id: Slug;
  path: `/apps/${Slug}`;
  boardType: Slug extends 'so-ill' ? 'soill' : Extract<BoardName, Slug>;
  screenshot: GuideScreenshot | null;
};

export type AppGuidePage =
  | AppGuide
  | (GuidePageContent & { id: 'hub' | 'spray-wall-apps'; screenshot: GuideScreenshot });

const CHECKED_AT = '2026-11-23';

const help = {
  bluetooth: { id: 'bluetooth', href: '/help/board-and-bluetooth' },
  migration: { id: 'migration', href: '/bring-your-logbook' },
  logbook: { id: 'logbook', href: '/help/logbook' },
  sessions: { id: 'sessions', href: '/help/sessions' },
  findingClimbs: { id: 'findingClimbs', href: '/help/finding-climbs' },
  spray: { id: 'spray', href: '/help/spray-walls' },
  sprayComparison: { id: 'sprayComparison', href: '/compare/spray-wall-apps' },
  boards: { id: 'boards', href: '/boards' },
} as const satisfies Record<string, GuideLink>;

function boardGallery(boardType: BoardName): GuideLink {
  return { id: 'boards', href: `/boards#${boardType}` };
}

function source(id: string, url: GuideSource['url']): GuideSource {
  return { id, url, checkedAt: CHECKED_AT };
}

const auroraDirectory = source('aurora', 'https://auroraclimbing.com/');
const boardseshSessions = source('boardseshSessions', 'https://www.boardsesh.com/help/sessions');
const boardseshLogbook = source('boardseshLogbook', 'https://www.boardsesh.com/help/logbook');
const boardseshMigration = source('boardseshMigration', 'https://www.boardsesh.com/bring-your-logbook');

function boardGallerySource(boardType: BoardName): GuideSource {
  return source('boardseshGallery', `https://www.boardsesh.com/boards#${boardType}`);
}

export const BOARDSESH_APP_STORE_RATING = {
  platform: 'Apple App Store',
  storefront: 'US',
  rating: 4.625,
  count: 32,
  source: 'https://apps.apple.com/us/app/boardsesh/id6761350784',
  lookupUrl: 'https://itunes.apple.com/lookup?id=6761350784&country=us',
  verifiedAt: CHECKED_AT,
} as const;

const boardseshStore = source('boardseshStore', BOARDSESH_APP_STORE_RATING.source);

const guides = {
  kilter: {
    id: 'kilter',
    path: '/apps/kilter',
    boardType: 'kilter',
    screenshot: 'kilter',
    updatedAt: CHECKED_AT,
    workflow: [{ id: 'layout' }, { id: 'queue' }, { id: 'import' }, { id: 'auroraImport' }],
    comparisonRows: [
      { id: 'discovery', sourceIds: ['boardseshStore', 'boardseshGallery', 'support'] },
      { id: 'session', sourceIds: ['boardseshSessions', 'official', 'support'] },
      { id: 'history', sourceIds: ['boardseshMigration', 'support'] },
      { id: 'auroraImportTiming', sourceIds: ['boardseshAuroraImport', 'claim', 'claimWaitReports'] },
    ],
    competitors: ['official'],
    sources: [
      source('official', 'https://kilterboard.io/'),
      source('support', 'https://kilterboard.io/support'),
      source('claim', 'https://kilterboard.io/claim'),
      source(
        'claimWaitReports',
        'https://www.reddit.com/r/kilterboard/comments/1sxf45g/i_built_a_tool_to_import_my_old_aurora_logbook/',
      ),
      source(
        'boardseshAuroraImport',
        'https://github.com/boardsesh/boardsesh/blob/f3f23de86983599d8f58493758c05e2b32b689ec/packages/mobile/src/components/integrations/BoardAccountsSection.tsx#L476-L513',
      ),
      boardGallerySource('kilter'),
      boardseshStore,
      boardseshSessions,
      boardseshMigration,
    ],
    related: [help.bluetooth, help.migration, help.sessions],
  },
  tension: {
    id: 'tension',
    path: '/apps/tension',
    boardType: 'tension',
    screenshot: 'tension',
    updatedAt: CHECKED_AT,
    workflow: [{ id: 'layout' }, { id: 'training' }, { id: 'import' }],
    comparisonRows: [
      { id: 'layout', sourceIds: ['boardseshGallery', 'aurora', 'layouts'] },
      { id: 'training', sourceIds: ['boardseshStore', 'circuits', 'timer'] },
      { id: 'history', sourceIds: ['boardseshMigration', 'official'] },
    ],
    competitors: ['official'],
    sources: [
      source('official', 'https://apps.apple.com/us/app/tension-board-2/id1488028660'),
      source('layouts', 'https://tensionclimbing.com/pages/faqs'),
      source(
        'circuits',
        'https://tensionclimbing.com/blogs/tension-board/app-resource-series-episode-5-creating-a-circuit',
      ),
      source('timer', 'https://tensionclimbing.com/blogs/tension-board/app-resource-series-episode-6-using-a-timer'),
      auroraDirectory,
      boardGallerySource('tension'),
      boardseshStore,
      boardseshMigration,
    ],
    related: [help.findingClimbs, help.migration, help.bluetooth, help.sprayComparison],
  },
  moonboard: {
    id: 'moonboard',
    path: '/apps/moonboard',
    boardType: 'moonboard',
    screenshot: 'moonboard',
    updatedAt: CHECKED_AT,
    workflow: [{ id: 'setup' }, { id: 'controller' }, { id: 'import' }],
    comparisonRows: [
      { id: 'benchmarks', sourceIds: ['boardseshGallery', 'boardseshClimbs', 'benchmarks'] },
      { id: 'lighting', sourceIds: ['led', 'audit'] },
      { id: 'history', sourceIds: ['boardseshGallery', 'official'] },
    ],
    competitors: ['official'],
    sources: [
      source('official', 'https://apps.apple.com/us/app/moon-board/id6446842142'),
      source('benchmarks', 'https://eu.moonclimbing.com/using-moonboard-app'),
      source('led', 'https://moonclimbing.com/moonboard/led/moonboard-led-system-v5.html'),
      source(
        'audit',
        'https://github.com/boardsesh/boardsesh/blob/95f9c5d1f42064e9d8073c861f4f3a7209d4bae4/docs/boards/moonboard-bluetooth-audit-2026-11-20.md',
      ),
      boardGallerySource('moonboard'),
      source(
        'boardseshClimbs',
        'https://github.com/boardsesh/boardsesh/blob/95f9c5d1f42064e9d8073c861f4f3a7209d4bae4/packages/mobile/src/components/ClimbFilterSheetContent.tsx#L328-L344',
      ),
    ],
    related: [help.bluetooth, help.findingClimbs, help.logbook],
  },
  decoy: {
    id: 'decoy',
    path: '/apps/decoy',
    boardType: 'decoy',
    screenshot: null,
    updatedAt: CHECKED_AT,
    workflow: [{ id: 'size' }, { id: 'turns' }, { id: 'history' }],
    comparisonRows: [
      { id: 'search', sourceIds: ['boardseshGallery', 'official'] },
      { id: 'session', sourceIds: ['boardseshStore', 'boardseshSessions', 'official'] },
    ],
    competitors: ['official'],
    sources: [
      source('official', 'https://apps.apple.com/us/app/decoy-board/id1539249879'),
      auroraDirectory,
      boardGallerySource('decoy'),
      boardseshStore,
      boardseshSessions,
    ],
    related: [boardGallery('decoy'), help.sessions, help.bluetooth],
  },
  touchstone: {
    id: 'touchstone',
    path: '/apps/touchstone',
    boardType: 'touchstone',
    screenshot: null,
    updatedAt: CHECKED_AT,
    workflow: [{ id: 'wall' }, { id: 'project' }, { id: 'history' }],
    comparisonRows: [
      { id: 'session', sourceIds: ['boardseshGallery', 'boardseshSessions', 'official'] },
      { id: 'history', sourceIds: ['boardseshLogbook', 'boardseshStore', 'official'] },
    ],
    competitors: ['official'],
    sources: [
      source('official', 'https://apps.apple.com/us/app/touchstone-board/id1494642775'),
      auroraDirectory,
      boardGallerySource('touchstone'),
      boardseshSessions,
      boardseshLogbook,
      boardseshStore,
    ],
    related: [boardGallery('touchstone'), help.logbook, help.findingClimbs],
  },
  grasshopper: {
    id: 'grasshopper',
    path: '/apps/grasshopper',
    boardType: 'grasshopper',
    screenshot: null,
    updatedAt: CHECKED_AT,
    workflow: [{ id: 'kit' }, { id: 'angle' }, { id: 'history' }],
    comparisonRows: [
      { id: 'search', sourceIds: ['boardseshGallery', 'kits', 'official'] },
      { id: 'session', sourceIds: ['boardseshStore', 'boardseshSessions', 'official'] },
    ],
    competitors: ['official'],
    sources: [
      source('official', 'https://apps.apple.com/us/app/grasshopper-board/id1507596418'),
      source('kits', 'https://shop.grasshopperclimbing.com/collections/adjustable-climbing-walls'),
      auroraDirectory,
      boardGallerySource('grasshopper'),
      boardseshStore,
      boardseshSessions,
    ],
    related: [boardGallery('grasshopper'), help.bluetooth, help.findingClimbs],
  },
  'so-ill': {
    id: 'so-ill',
    path: '/apps/so-ill',
    boardType: 'soill',
    screenshot: null,
    updatedAt: CHECKED_AT,
    workflow: [{ id: 'layout' }, { id: 'crew' }, { id: 'history' }],
    comparisonRows: [
      { id: 'search', sourceIds: ['boardseshGallery', 'connect', 'official'] },
      { id: 'session', sourceIds: ['boardseshStore', 'boardseshSessions', 'official'] },
    ],
    competitors: ['official'],
    sources: [
      source('official', 'https://apps.apple.com/us/app/so-ill-board/id1358056082'),
      source('connect', 'https://soillholds.com/products/connect-board'),
      auroraDirectory,
      boardGallerySource('soill'),
      boardseshStore,
      boardseshSessions,
    ],
    related: [boardGallery('soill'), help.sessions, help.logbook],
  },
  woods: {
    id: 'woods',
    path: '/apps/woods',
    boardType: 'woods',
    screenshot: null,
    updatedAt: CHECKED_AT,
    workflow: [{ id: 'size' }, { id: 'rules' }, { id: 'session' }],
    comparisonRows: [
      { id: 'rules', sourceIds: ['boardseshWoods', 'sizes', 'official'] },
      { id: 'history', sourceIds: ['boardseshStore', 'boardseshGallery', 'official'] },
      { id: 'publishing', sourceIds: ['boardseshWoods', 'official'] },
    ],
    competitors: ['official'],
    sources: [
      source('official', 'https://apps.apple.com/us/app/woods-board/id1619846872'),
      source('sizes', 'https://escapeclimbing.com/products/woods-board'),
      source(
        'boardseshWoods',
        'https://github.com/boardsesh/boardsesh/blob/95f9c5d1f42064e9d8073c861f4f3a7209d4bae4/docs/boards/woods-climb-rules.md',
      ),
      boardGallerySource('woods'),
      boardseshStore,
    ],
    related: [boardGallery('woods'), help.bluetooth, help.logbook],
  },
} as const satisfies { [Slug in AppGuideSlug]: AppGuide<Slug> };

export const APP_GUIDES: readonly AppGuide[] = APP_GUIDE_SLUGS.map((slug) => guides[slug]);

export function getAppGuide(slug: string): AppGuide | undefined {
  return APP_GUIDES.find((guide) => guide.id === slug);
}

export const APP_GUIDE_HUB = {
  id: 'hub',
  path: '/apps',
  screenshot: 'queue',
  updatedAt: CHECKED_AT,
  workflow: [],
  comparisonRows: [],
  competitors: [],
  sources: [],
  related: [help.boards, help.bluetooth, help.sessions],
} as const satisfies AppGuidePage;

export const APP_GUIDE_COMPARISON = {
  id: 'spray-wall-apps',
  path: '/compare/spray-wall-apps',
  screenshot: 'spray-wall',
  updatedAt: CHECKED_AT,
  workflow: [{ id: 'photo' }, { id: 'sharing' }, { id: 'reset' }],
  comparisonRows: [
    { id: 'setup', sourceIds: ['boardseshSpray', 'boardseshSetup', 'stokt', 'stoktPricing', 'retroFlashGoogle'] },
    { id: 'features', sourceIds: ['boardseshPlaylists', 'boardseshSessions', 'stoktPro', 'retroFlashGoogle'] },
    { id: 'lighting', sourceIds: ['boardseshStore', 'stoktPro', 'retroFlashApple', 'retroFlashGoogle'] },
    { id: 'price', sourceIds: ['boardseshSpray', 'stoktPricing', 'stoktPro', 'retroFlashApple'] },
  ],
  competitors: ['stokt', 'retroFlash'],
  sources: [
    source('stokt', 'https://www.getstokt.com/'),
    source('stoktPricing', 'https://www.getstokt.com/pricing'),
    source('stoktPro', 'https://www.getstokt.com/stokt-pro'),
    source('retroFlashApple', 'https://apps.apple.com/us/app/retro-flash-climbing/id1519582483'),
    source(
      'retroFlashGoogle',
      'https://play.google.com/store/apps/details?hl=en_US&id=com.arcadebouldering.system_wall',
    ),
    source('boardseshSpray', 'https://www.boardsesh.com/spraywalls'),
    source('boardseshSetup', 'https://www.boardsesh.com/help/spray-walls'),
    source('boardseshPlaylists', 'https://www.boardsesh.com/help/finding-climbs#playlists'),
    boardseshSessions,
    boardseshStore,
  ],
  related: [help.spray, help.sessions, help.logbook],
} as const satisfies AppGuidePage;

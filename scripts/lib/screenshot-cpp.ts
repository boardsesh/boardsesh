/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  CAPTION_IDS,
  validateScreenshotBoardLabels,
  type ScreenshotRecipe,
  type ScreenshotLayout,
} from './screenshot-presentation';
import {
  screenshotCppBoardMatches,
  type ScreenshotCppBoardIdentity,
} from '../../packages/mobile/src/lib/screenshot-cpp-board-identity';

export const CPP_TARGETS = ['kilter', 'tension', 'moonboard', 'spray'] as const;
export type CppTarget = (typeof CPP_TARGETS)[number];
export type CppSelection = CppTarget | 'all';
export const CPP_MANIFEST_PATH = fileURLToPath(
  new URL('../../app-stores/apple/custom-product-pages.json', import.meta.url),
);
export interface CppBoard {
  id: string;
  family: string;
  selector: string;
  boardType: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: number[];
  angle?: number;
  photo?: string;
}
export interface CppPage {
  referenceName: string;
  fixtureReference?: string;
  primaryBoard: CppBoard;
  heroBoards: CppBoard[];
  otherBoards: CppBoard[];
  recipes: { phone: ScreenshotRecipe[]; ipad: ScreenshotRecipe[] };
}
export interface CppSceneCoverage {
  boardId: string;
  readyText: string;
  /** Actual rendered LogbookRow ascent UUID, selected from the genuine feed. */
  ascentId?: string;
  /** Actual rendered climb identifier, preserving Aurora's compact UUID form. */
  climbId?: string;
  readyTextByLocale?: Record<'en-US' | 'es' | 'fr' | 'de', string>;
  sessionId?: string;
  /** Genuine GradeRail bounds and the API count for this exact selection. */
  gradeFilter?: {
    minLabel: string;
    maxLabel?: string;
    minGradeId: number;
    maxGradeId: number;
    expectedCount: number;
    proof?: CppGradeCountProof;
  };
}
export interface CppGradeCountProof {
  file: string;
  documentHash: string;
  variablesHash: string;
  recordedAt: string;
  responseSha256: string;
  totalCount: number;
}
export interface CppHeroClimb {
  boardId: string;
  climbId: string;
  readyText: string;
  /** Crowd grade rendered in the capture's V-grade format; empty for ungraded projects. */
  gradeLabel: string;
  statsAngle?: number;
  benchmarkDifficulty?: number;
}
export function isCppAscentId(candidate: unknown): candidate is string {
  return (
    typeof candidate === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)
  );
}
export function isCppClimbId(candidate: unknown): candidate is string {
  return isCppAscentId(candidate) || (typeof candidate === 'string' && /^[0-9a-f]{32}$/i.test(candidate));
}
export interface CppCaptureCoverage {
  target: CppTarget;
  /** Explicit real climb selections; absent on older fixture candidates. */
  heroClimbs?: Record<string, CppHeroClimb>;
  /** Genuine different climb on the primary board for the solo accessory preview. */
  accessoryClimb?: CppHeroClimb;
  boardIds?: Record<string, string>;
  /** Actual visible names from the verified UUID/config-matched owned roster. */
  boardNames?: Record<string, string>;
  boardReadyText: Record<string, string>;
  boardReadyTextByLocale?: Record<string, Record<'en-US' | 'es' | 'fr' | 'de', string>>;
  boardHeroModes?: Record<string, 'climb' | 'wall-editor'>;
  boardClimbCounts?: Record<string, number>;
  boardPhotoSha256?: Record<string, string>;
  boardPhotoAssets?: Record<string, { file: string; sha256: string }>;
  scenes: Record<string, CppSceneCoverage>;
}
export interface CppRecordedBoard {
  uuid: string;
  name: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string | null;
  angle: number;
}
export interface CppNavigationCommand {
  selector: string;
  identity: ScreenshotCppBoardIdentity;
  route: string;
}

function cppBoardIdentity(board: CppBoard, coverage: CppCaptureCoverage): ScreenshotCppBoardIdentity {
  return {
    uuid: coverage.boardIds?.[board.id],
    boardType: board.boardType,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    angle: board.angle,
  };
}
export function isCppTarget(candidate: unknown): candidate is CppTarget {
  return CPP_TARGETS.some((target) => target === candidate);
}
function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}
export function readCppPage(target: CppTarget, manifestPath = CPP_MANIFEST_PATH): CppPage {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!isRecord(manifest) || manifest.version !== 1 || !isRecord(manifest.targets))
    throw new Error('Invalid CPP manifest');
  if (!isRecord(manifest.sourcePhotos)) throw new Error('CPP manifest requires original photo provenance');
  const hashes = new Set<string>();
  for (const photo of Object.values(manifest.sourcePhotos)) {
    if (
      !isRecord(photo) ||
      typeof photo.path !== 'string' ||
      typeof photo.sha256 !== 'string' ||
      typeof photo.bytes !== 'number'
    )
      throw new Error('Invalid CPP photo provenance');
    const bytes = readFileSync(resolve(fileURLToPath(new URL('../../', import.meta.url)), photo.path));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== photo.sha256 || bytes.length !== photo.bytes || hashes.has(hash))
      throw new Error(`CPP photo integrity failed: ${photo.path}`);
    hashes.add(hash);
  }
  const page = manifest.targets[target];
  if (!isRecord(page) || !Array.isArray(page.heroBoards) || !Array.isArray(page.otherBoards) || !isRecord(page.recipes))
    throw new Error(`Incomplete CPP ${target}`);
  const boards = [...page.heroBoards, ...page.otherBoards];
  if (page.heroBoards.length !== 3 || page.otherBoards.length !== 3)
    throw new Error(`${target} needs two distinct board trios`);
  for (const board of boards) {
    if (
      !isRecord(board) ||
      !['id', 'selector', 'family', 'boardType'].every((key) => typeof board[key] === 'string') ||
      (board.family === 'spray'
        ? typeof board.photo !== 'string'
        : !Array.isArray(board.setIds) ||
          board.setIds.some((setId) => typeof setId !== 'number') ||
          !['layoutId', 'sizeId', 'angle'].every(
            (key) => typeof board[key] === 'number' && Number.isFinite(board[key]),
          ))
    )
      throw new Error(`Invalid CPP board identity for ${target}`);
  }
  if (new Set(boards.map((board) => (board as CppBoard).id)).size !== 6)
    throw new Error(`${target} requires six distinct boards`);
  if (
    page.heroBoards.some((board: CppBoard) => board.family !== target) ||
    page.otherBoards.some((board: CppBoard) => board.family === target)
  )
    throw new Error(`${target} trios include the wrong board family`);
  if (
    !isRecord(page.primaryBoard) ||
    page.primaryBoard.family !== target ||
    !page.heroBoards.some((board: CppBoard) => board.id === (page.primaryBoard as Record<string, unknown>).id)
  )
    throw new Error(`${target} primary board must be in its hero trio`);
  for (const device of ['phone', 'ipad']) {
    const captureNames = new Set(
      cppCaptureNames(page as unknown as CppPage, device === 'ipad' ? 'ipad-cpp' : 'phone-cpp'),
    );
    const recipes = page.recipes[device];
    if (!Array.isArray(recipes) || recipes.length !== 9) throw new Error(`${target}/${device} requires nine recipes`);
    if (new Set(recipes.map((recipe) => (recipe as ScreenshotRecipe).output)).size !== 9)
      throw new Error(`${target}/${device} needs distinct outputs`);
    for (const recipe of recipes) {
      if (
        !isRecord(recipe) ||
        typeof recipe.output !== 'string' ||
        !/^[\w-]+\.png$/.test(recipe.output) ||
        !CAPTION_IDS.some((caption) => caption === recipe.caption) ||
        !['screen', 'store-hero', 'store-boards', 'store-wall', 'store-queue', 'store-island', 'store-spray'].includes(
          String(recipe.layout),
        ) ||
        !Array.isArray(recipe.sources) ||
        recipe.sources.length === 0 ||
        recipe.sources.some((source) => typeof source !== 'string' || !captureNames.has(source))
      )
        throw new Error(`Invalid CPP recipe for ${target}/${device}`);
      const boardLabels = validateScreenshotBoardLabels(
        recipe.boardLabels,
        recipe.layout as ScreenshotLayout,
        recipe.sources.length,
      );
      if (boardLabels) {
        const expectedLabels = recipe.sources.map((source: string) => {
          const sourceVariant = /^(hero|other)-([123])\.png$/.exec(source);
          if (!sourceVariant) return undefined;
          const variants = (sourceVariant[1] === 'hero' ? page.heroBoards : page.otherBoards) as CppBoard[];
          return variants[Number(sourceVariant[2]) - 1].selector;
        });
        if (boardLabels.some((label, index) => label !== expectedLabels[index]))
          throw new Error(`CPP board labels do not match variant source order for ${target}/${device}`);
      }
    }
  }
  return page as unknown as CppPage;
}
export function cppCaptureNames(page: CppPage, device: string): string[] {
  const spray = page.primaryBoard.family === 'spray';
  // Capture all genuine native scenes even when a presentation recipe omits
  // one. Changing a layout must never reduce the recorded source contract.
  return [
    'hero-1.png',
    'hero-2.png',
    'hero-3.png',
    'other-1.png',
    'other-2.png',
    'other-3.png',
    '02-search.png',
    '03-logbook.png',
    spray ? '04-setting.png' : '04-led.png',
    '05-queue.png',
    '06-workout.png',
    spray ? '07-playlist.png' : '07-status.png',
    spray ? '08-holds.png' : device.startsWith('ipad-') ? '08-kiosk.png' : '08-island.png',
  ].sort();
}
export function resolveCppRecipes(
  page: CppPage,
  device: string,
  capturedNames: readonly string[],
): readonly ScreenshotRecipe[] {
  const expected = cppCaptureNames(page, device);
  if (expected.join('\n') !== [...capturedNames].sort().join('\n'))
    throw new Error(`Incomplete CPP capture: expected ${expected.join(', ')}; found ${capturedNames.join(', ')}`);
  return page.recipes[device.startsWith('ipad-') ? 'ipad' : 'phone'];
}
export function assertCppCaptureReady(
  target: CppTarget,
  page: CppPage,
  coverage: CppCaptureCoverage | undefined,
  recordedBoards: readonly CppRecordedBoard[],
  fixturesDir?: string,
  verifyPhotoAssets = true,
): void {
  if (!coverage || coverage.target !== target) throw new Error(`Missing verified CPP fixture coverage for ${target}`);
  const accessory = coverage.accessoryClimb;
  if (
    accessory &&
    (accessory.boardId !== coverage.boardIds?.[page.primaryBoard.id] ||
      !isCppClimbId(accessory.climbId) ||
      accessory.climbId === coverage.scenes.status.climbId ||
      typeof accessory.readyText !== 'string' ||
      !accessory.readyText.trim() ||
      typeof accessory.gradeLabel !== 'string' ||
      (accessory.statsAngle !== undefined && !Number.isFinite(accessory.statsAngle)) ||
      (accessory.benchmarkDifficulty !== undefined &&
        (!Number.isFinite(accessory.benchmarkDifficulty) ||
          accessory.benchmarkDifficulty <= 0 ||
          accessory.statsAngle !== recordedBoards.find((board) => board.uuid === accessory.boardId)?.angle)))
  )
    throw new Error(`CPP ${target} requires a genuine distinct primary accessory climb`);
  const boards = [...page.heroBoards, ...page.otherBoards];
  if (
    coverage.boardIds &&
    (boards.some((board) => !coverage.boardIds?.[board.id]) ||
      new Set(boards.map((board) => coverage.boardIds?.[board.id])).size !== boards.length)
  )
    throw new Error(`CPP ${target} requires six distinct explicit board UUIDs`);
  if (
    !coverage.boardNames ||
    Object.keys(coverage.boardNames).length !== boards.length ||
    boards.some((board) => typeof coverage.boardNames?.[board.id] !== 'string' || !coverage.boardNames[board.id].trim())
  )
    throw new Error(`CPP ${target} requires six genuine recorded board names`);
  for (const [boardId, mode] of Object.entries(coverage.boardHeroModes ?? {})) {
    const board = boards.find((variant) => variant.id === boardId);
    if (
      !board ||
      !['climb', 'wall-editor'].includes(mode) ||
      (mode === 'wall-editor' && (board.family !== 'spray' || coverage.boardClimbCounts?.[boardId] !== 0))
    )
      throw new Error(`CPP ${target} requires an explicit empty spray wall for ${boardId}`);
  }
  for (const board of boards) {
    const translatedGate = coverage.boardReadyTextByLocale?.[board.id];
    if (
      translatedGate &&
      ['en-US', 'es', 'fr', 'de'].some((locale) => !translatedGate[locale as keyof typeof translatedGate]?.trim())
    )
      throw new Error(`CPP ${target} lacks localized board readiness for ${board.id}`);
    const matches = recordedBoards.filter((recorded) =>
      screenshotCppBoardMatches(recorded, board.selector, cppBoardIdentity(board, coverage)),
    );
    const hero = coverage.heroClimbs?.[board.id];
    if (
      coverage.heroClimbs &&
      coverage.boardHeroModes?.[board.id] !== 'wall-editor' &&
      (!hero ||
        hero.boardId !== coverage.boardIds?.[board.id] ||
        !isCppClimbId(hero.climbId) ||
        typeof hero.readyText !== 'string' ||
        !hero.readyText.trim() ||
        typeof hero.gradeLabel !== 'string' ||
        (hero.statsAngle !== undefined && !Number.isFinite(hero.statsAngle)) ||
        (hero.benchmarkDifficulty !== undefined &&
          (!Number.isFinite(hero.benchmarkDifficulty) ||
            hero.benchmarkDifficulty <= 0 ||
            hero.statsAngle !== matches[0]?.angle)))
    )
      throw new Error(`CPP ${target} lacks a genuine selected hero climb for ${board.id}`);
    if (board.family === 'spray') {
      const sourceHash = createHash('sha256')
        .update(readFileSync(resolve(fileURLToPath(new URL('../../', import.meta.url)), board.photo!)))
        .digest('hex');
      const asset = coverage.boardPhotoAssets?.[board.id];
      if (
        verifyPhotoAssets &&
        (!fixturesDir || !asset || !/^static\/[\w.-]+$/.test(asset.file) || !/^[a-f0-9]{64}$/.test(asset.sha256))
      )
        throw new Error(`CPP ${target} lacks recorded photo asset for ${board.id}`);
      if (verifyPhotoAssets && asset && fixturesDir) {
        const assetHash = createHash('sha256')
          .update(readFileSync(resolve(fixturesDir, asset.file)))
          .digest('hex');
        if (assetHash !== asset.sha256)
          throw new Error(`CPP ${target} recorded photo asset checksum differs for ${board.id}`);
      }
      if (coverage.boardPhotoSha256?.[board.id] !== sourceHash)
        throw new Error(`CPP ${target} lacks verified source photo for ${board.id}`);
    }
    if (
      !matches.length ||
      new Set(matches.map((matched) => matched.uuid)).size !== 1 ||
      !coverage.boardReadyText[board.id]?.trim()
    )
      throw new Error(
        `CPP ${target} lacks verified board capture ${board.id} (${board.selector}); ` +
          `expected ${JSON.stringify(cppBoardIdentity(board, coverage))}; ` +
          `recorded roster=${recordedBoards.length}, same-name candidates=${JSON.stringify(
            recordedBoards
              .filter((recorded) => recorded.name === board.selector)
              .map(({ uuid, name, boardType, layoutId, sizeId, setIds, angle }) => ({
                uuid,
                name,
                boardType,
                layoutId,
                sizeId,
                setIds,
                angle,
              })),
          )}`,
      );
    if (matches.some((matched) => matched.name !== coverage.boardNames?.[board.id]))
      throw new Error(`CPP ${target} recorded board name differs for ${board.id} (${matches[0].uuid})`);
  }
  const photoBoards = boards.filter((board) => board.family === 'spray');
  if (
    verifyPhotoAssets &&
    (new Set(photoBoards.map((board) => coverage.boardPhotoAssets?.[board.id]?.sha256)).size !== photoBoards.length ||
      new Set(photoBoards.map((board) => coverage.boardPhotoAssets?.[board.id]?.file)).size !== photoBoards.length)
  )
    throw new Error(`CPP ${target} requires distinct recorded wall photos`);
  const primary = recordedBoards.find((board) =>
    screenshotCppBoardMatches(board, page.primaryBoard.selector, cppBoardIdentity(page.primaryBoard, coverage)),
  );
  const gradeFilter = coverage.scenes.search?.gradeFilter;
  if (
    gradeFilter &&
    (!gradeFilter.minLabel?.trim() ||
      (gradeFilter.maxLabel !== undefined && !gradeFilter.maxLabel.trim()) ||
      !Number.isInteger(gradeFilter.minGradeId) ||
      !Number.isInteger(gradeFilter.maxGradeId) ||
      gradeFilter.minGradeId > gradeFilter.maxGradeId ||
      !Number.isSafeInteger(gradeFilter.expectedCount) ||
      gradeFilter.expectedCount < 1)
  )
    throw new Error(`CPP ${target} lacks genuine grade-filter bounds/count`);
  for (const scene of ['search', 'logbook', 'led', 'queue', 'workout', 'status', 'island']) {
    const entry = coverage.scenes[scene];
    if (scene === 'logbook' && !isCppAscentId(entry?.ascentId))
      throw new Error(`CPP ${target} lacks a genuine logbook ascent UUID`);
    if (scene === 'status' && target !== 'spray' && !isCppClimbId(entry?.climbId))
      throw new Error(`CPP ${target} lacks a genuine status climb identifier`);
    if (
      entry?.readyTextByLocale &&
      ['en-US', 'es', 'fr', 'de'].some(
        (locale) => !entry.readyTextByLocale?.[locale as keyof typeof entry.readyTextByLocale]?.trim(),
      )
    )
      throw new Error(`CPP ${target} lacks localized ${scene} readiness text`);
    if (!entry?.readyText?.trim() || entry.boardId !== primary?.uuid || (scene === 'queue' && !entry.sessionId))
      throw new Error(`CPP ${target} lacks target-specific ${scene} fixture coverage`);
  }
}

/** Device-independent in-app navigation also works on iPad, where scheme links are swallowed. */
export function cppNavigationCommands(
  page: CppPage,
  coverage: CppCaptureCoverage,
  recordedBoards: readonly CppRecordedBoard[],
  ipad: boolean,
): Record<string, CppNavigationCommand> {
  const boards = [...page.heroBoards, ...page.otherBoards];
  const commands: Record<string, CppNavigationCommand> = {};
  const identityFor = (board: CppBoard): ScreenshotCppBoardIdentity => ({
    ...cppBoardIdentity(board, coverage),
    uuid:
      coverage.boardIds?.[board.id] ??
      recordedBoards.find((recorded) =>
        screenshotCppBoardMatches(recorded, board.selector, cppBoardIdentity(board, coverage)),
      )?.uuid ??
      (board.id === page.primaryBoard.id ? coverage.scenes.search.boardId : undefined),
  });
  for (const [index, board] of boards.entries()) {
    commands[`${index < 3 ? 'hero' : 'other'}-${(index % 3) + 1}`] = {
      selector: board.selector,
      identity: identityFor(board),
      route:
        coverage.boardHeroModes?.[board.id] === 'wall-editor'
          ? `/climbs/create?screenshotCppScene=${index < 3 ? 'hero' : 'other'}-${(index % 3) + 1}`
          : `/climbs?screenshotOpenFirst=1&screenshotBoardIndex=${index}&screenshotCppScene=${index < 3 ? 'hero' : 'other'}-${(index % 3) + 1}${coverage.heroClimbs?.[board.id] ? `&screenshotClimbId=${encodeURIComponent(coverage.heroClimbs[board.id].climbId)}` : ''}`,
    };
  }
  const primary = page.primaryBoard;
  const index = boards.findIndex((board) => board.id === primary.id);
  if (index < 0) throw new Error('CPP primary board must occur in the hero trio');
  const boardId = identityFor(primary).uuid;
  const routes: Record<string, string> = {
    ...(coverage.accessoryClimb
      ? {
          'accessory-prepare': `/climbs?screenshotOpenFirst=1&screenshotBoardIndex=${index}&screenshotClimbId=${encodeURIComponent(coverage.accessoryClimb.climbId)}`,
        }
      : {}),
    search: `/climbs?screenshotBoardIndex=${index}&screenshotOpenFilters=1`,
    ...(coverage.scenes.search.gradeFilter
      ? {
          'search-grade': `/climbs?screenshotBoardIndex=${index}&screenshotOpenFilters=1&screenshotMinGrade=${coverage.scenes.search.gradeFilter.minGradeId}&screenshotMaxGrade=${coverage.scenes.search.gradeFilter.maxGradeId}`,
        }
      : {}),
    logbook: `/profile?screenshotTab=logbook&screenshotBoardType=${primary.boardType}`,
    led:
      coverage.target === 'spray'
        ? '/climbs/create'
        : `/climbs?screenshotOpenWallPreview=1&screenshotBoardIndex=${index}`,
    'queue-join': `/join/${encodeURIComponent(coverage.scenes.queue.sessionId ?? '')}`,
    queue: `/climbs?screenshotOpenFirst=1&screenshotBoardIndex=${index}`,
    workout: '/record',
    status:
      coverage.target === 'spray'
        ? '/discover/smart/PROJECTS'
        : `/climbs?screenshotBoardIndex=${index}${ipad && coverage.heroClimbs ? `&screenshotClimbId=${encodeURIComponent(coverage.scenes.status.climbId ?? '')}` : ''}`,
    island:
      coverage.target === 'spray'
        ? `/boards/spray/holds?wallUuid=${encodeURIComponent(boardId ?? '')}`
        : ipad
          ? '/wall'
          : `/climbs?screenshotOpenFirst=1&screenshotBoardIndex=${index}`,
  };
  for (const [scene, route] of Object.entries(routes))
    commands[scene] = {
      selector: primary.selector,
      identity: identityFor(primary),
      route: `${route}${route.includes('?') ? '&' : '?'}screenshotCppScene=${scene}`,
    };
  return commands;
}

/** Fixture labels are literal native text; manufacturer/climb punctuation is never a regex. */
export function cppReadinessSelector(label: string): string {
  return label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

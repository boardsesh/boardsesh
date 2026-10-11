/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { CAPTION_IDS, type ScreenshotRecipe } from './screenshot-presentation';

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
  readyTextByLocale?: Record<'en-US' | 'es' | 'fr' | 'de', string>;
  sessionId?: string;
}
export interface CppCaptureCoverage {
  target: CppTarget;
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
    !page.heroBoards.some((board: CppBoard) => board.id === (page.primaryBoard as Record<string, unknown>).id)
  )
    throw new Error(`${target} primary board must be in its hero trio`);
  for (const device of ['phone', 'ipad']) {
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
        !['screen', 'store-boards', 'store-wall', 'store-queue', 'store-island', 'store-spray'].includes(
          String(recipe.layout),
        ) ||
        !Array.isArray(recipe.sources) ||
        recipe.sources.length === 0 ||
        recipe.sources.some((source) => typeof source !== 'string' || !/^[\w-]+\.png$/.test(source))
      )
        throw new Error(`Invalid CPP recipe for ${target}/${device}`);
    }
  }
  return page as unknown as CppPage;
}
export function cppCaptureNames(page: CppPage, device: string): string[] {
  return [
    ...new Set(page.recipes[device.startsWith('ipad-') ? 'ipad' : 'phone'].flatMap((recipe) => recipe.sources)),
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
  const boards = [...page.heroBoards, ...page.otherBoards];
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
    const matches = recordedBoards.filter(
      (recorded) =>
        recorded.name === board.selector &&
        recorded.boardType === board.boardType &&
        (board.family === 'spray' ||
          (recorded.layoutId === board.layoutId &&
            recorded.sizeId === board.sizeId &&
            (recorded.setIds ?? '')
              .split(',')
              .filter(Boolean)
              .map(Number)
              .sort((first, second) => first - second)
              .join(',') === [...(board.setIds ?? [])].sort((first, second) => first - second).join(',') &&
            recorded.angle === board.angle)),
    );
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
      throw new Error(`CPP ${target} lacks verified board capture ${board.id} (${board.selector})`);
  }
  const photoBoards = boards.filter((board) => board.family === 'spray');
  if (
    verifyPhotoAssets &&
    (new Set(photoBoards.map((board) => coverage.boardPhotoAssets?.[board.id]?.sha256)).size !== photoBoards.length ||
      new Set(photoBoards.map((board) => coverage.boardPhotoAssets?.[board.id]?.file)).size !== photoBoards.length)
  )
    throw new Error(`CPP ${target} requires distinct recorded wall photos`);
  const primary = recordedBoards.find((board) => board.name === page.primaryBoard.selector);
  for (const scene of ['search', 'logbook', 'led', 'queue', 'workout', 'status', 'island']) {
    const entry = coverage.scenes[scene];
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
): Record<string, { selector: string; route: string }> {
  const boards = [...page.heroBoards, ...page.otherBoards];
  const commands: Record<string, { selector: string; route: string }> = {};
  for (const [index, board] of boards.entries()) {
    commands[`${index < 3 ? 'hero' : 'other'}-${(index % 3) + 1}`] = {
      selector: board.selector,
      route:
        coverage.boardHeroModes?.[board.id] === 'wall-editor'
          ? `/climbs/create?screenshotCppScene=${index < 3 ? 'hero' : 'other'}-${(index % 3) + 1}`
          : `/climbs?screenshotOpenFirst=1&screenshotBoardIndex=${index}&screenshotCppScene=${index < 3 ? 'hero' : 'other'}-${(index % 3) + 1}`,
    };
  }
  const primary = page.primaryBoard;
  const index = boards.findIndex((board) => board.id === primary.id);
  if (index < 0) throw new Error('CPP primary board must occur in the hero trio');
  const boardId = recordedBoards.find((board) => board.name === primary.selector)?.uuid;
  const routes: Record<string, string> = {
    search: `/climbs?screenshotBoardIndex=${index}&screenshotOpenFilters=1`,
    logbook: `/profile?screenshotTab=logbook&screenshotBoardType=${primary.boardType}`,
    led:
      coverage.target === 'spray'
        ? '/climbs/create'
        : `/climbs?screenshotOpenWallPreview=1&screenshotBoardIndex=${index}`,
    'queue-join': `/join/${encodeURIComponent(coverage.scenes.queue.sessionId ?? '')}`,
    queue: `/climbs?screenshotOpenFirst=1&screenshotBoardIndex=${index}`,
    workout: '/record',
    status: coverage.target === 'spray' ? '/discover/smart/PROJECTS' : `/climbs?screenshotBoardIndex=${index}`,
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
      route: `${route}${route.includes('?') ? '&' : '?'}screenshotCppScene=${scene}`,
    };
  return commands;
}

/** Fixture labels are literal native text; manufacturer/climb punctuation is never a regex. */
export function cppReadinessSelector(label: string): string {
  return label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

import { resolve } from 'node:path';
import { SHOWCASE_FPS, SHOWCASE_STAGE_DIR, type ShowcaseTakeId } from './contract';
import type { FootageRange, StageTake } from './render';
import type { ShowcaseScenePlan } from './timeline';
import type { LiveActivityFixture } from '../screenshot-live-activity';

export const STORE_SEARCH_LOCALES = ['en-US', 'es', 'fr', 'de'] as const;
export type StoreSearchLocale = (typeof STORE_SEARCH_LOCALES)[number];
export const STORE_SEARCH_VARIANTS = ['default', 'kilter', 'tension', 'moonboard', 'spray'] as const;
export type StoreSearchVariant = (typeof STORE_SEARCH_VARIANTS)[number];
export const STORE_SEARCH_CROSSFADE_FRAMES = 15;
export const storeSearchCopyPath = (locale: StoreSearchLocale): string =>
  resolve(SHOWCASE_STAGE_DIR, `search-copy.${locale}.json`);

export type StoreSearchCopy = Readonly<Record<string, string>>;

/** Caption-only creative copy. Two lines; no logo, price, platform, URL or donation copy. */
export function storeSearchCopyProblems(copy: StoreSearchCopy): string[] {
  const problems: string[] = [];
  for (const [key, caption] of Object.entries(copy)) {
    const lines = caption.replaceAll('*', '').split('\n');
    if (lines.length > 2) problems.push(`${key}: more than two lines`);
    if (lines.some((line) => line.length > 20)) problems.push(`${key}: line exceeds 20 characters`);
    if (/boardsesh|android|ios|https?:|www\.|donat|gratis|free|€/i.test(caption))
      problems.push(`${key}: prohibited store creative copy`);
    const brands = caption.match(/Kilter|Tension|MoonBoard/g) ?? [];
    if (new Set(brands).size > 1) problems.push(`${key}: multiple manufacturer names`);
  }
  return problems;
}

const PILE: readonly ShowcaseTakeId[] = ['boards-kilter', 'boards-spray', 'boards-moonboard'];
const beat = (
  id: ShowcaseScenePlan['id'],
  caption: string,
  frames: number,
  takes?: readonly ShowcaseTakeId[],
  optional = false,
): ShowcaseScenePlan => ({
  id,
  caption,
  frames,
  plain: true,
  optional,
  ...(takes ? { takes } : {}),
});

/** Explicit take lists prevent a named CPP from inheriting the legacy Kilter pile or session. */
export function storeSearchPlan(variant: StoreSearchVariant): readonly ShowcaseScenePlan[] {
  if (variant === 'default')
    return [
      beat('boards', 'boards', 140, PILE),
      beat('spray', 'spray', 140),
      beat('crew', 'crew', 140),
      beat('lock-screen', 'island', 180),
    ];
  if (variant === 'kilter')
    return [
      beat('boards', 'kilter', 68, ['boards-kilter']),
      beat('log', 'kilterLog', 67),
      beat('boards', 'boards', 68, PILE),
      beat('crew', 'friends', 67),
      beat('lock-screen', 'island', 180),
    ];
  if (variant === 'tension')
    return [
      beat('boards', 'tension', 81, ['boards-tension']),
      beat('log', 'tensionLog', 108),
      beat('crew', 'tensionFriends', 81),
      beat('lock-screen', 'island', 180),
    ];
  if (variant === 'moonboard')
    return [
      beat('boards', 'moonboard', 90, ['boards-moonboard']),
      beat('log', 'moonboardLog', 90, ['log']),
      beat('wall', 'moonboardGrade', 120, ['moonboard-filter']),
      beat('boards', 'climbHolds', 150, ['boards-moonboard']),
    ];
  return [
    beat('spray', 'spraySet', 90),
    beat('spray', 'photo', 90),
    beat('log', 'sends', 90),
    beat('boards', 'gymBoards', 90, ['boards-spray', 'boards-kilter', 'boards-moonboard']),
    beat('spray', 'sprayNext', 90),
  ];
}

/** Required footage per cut, plus optional beat footage; no fallback to another variant or locale. */
export const storeSearchTakeIds = (variant: StoreSearchVariant): ShowcaseTakeId[] => [
  ...new Set(
    storeSearchPlan(variant).flatMap(
      (scene) => scene.takes ?? (scene.id === 'outro' ? [] : [scene.id as ShowcaseTakeId]),
    ),
  ),
];

/** Verify fresh native provenance before exposing any frame to a localized cut. */
export function storeSearchRecordingProblems(
  metadata: Readonly<{
    takeId?: string;
    locale?: string;
    kind?: string;
    platform?: string;
    recordedAt?: string;
    validated?: boolean;
    presentation?: string;
    captureSurface?: string;
    nativeFixtureSourcePngSha256?: string;
    boardKind?: string;
    sharedNativeSource?: Readonly<{ sha256: string; sourceLocale: string; boardFamily: string }>;
  }>,
  takeId: ShowcaseTakeId,
  locale: StoreSearchLocale,
  variant: StoreSearchVariant,
): string[] {
  const problems: string[] = [];
  if (metadata.validated !== true) problems.push('recording has not passed native validation');
  if (metadata.takeId !== takeId) problems.push(`recording take ${metadata.takeId ?? 'missing'}, expected ${takeId}`);
  const sharedNativeSource = takeId === 'lock-screen' ? metadata.sharedNativeSource : undefined;
  const sharedFamily = variant === 'default' ? 'kilter' : variant;
  const approvedSharedIdentity =
    sharedNativeSource !== undefined &&
    /^[a-f0-9]{64}$/.test(sharedNativeSource.sha256) &&
    sharedNativeSource.boardFamily === sharedFamily &&
    sharedNativeSource.sourceLocale === metadata.locale &&
    STORE_SEARCH_LOCALES.includes(sharedNativeSource.sourceLocale as StoreSearchLocale);
  if (metadata.sharedNativeSource && !approvedSharedIdentity) problems.push('Invalid shared native source identity');
  if (metadata.locale !== locale && !approvedSharedIdentity)
    problems.push(`recording locale ${metadata.locale ?? 'missing'}, expected ${locale}`);
  const sourceKind = variant === 'default' && takeId === 'lock-screen' ? 'kilter' : variant;
  if (metadata.kind !== sourceKind)
    problems.push(`recording variant ${metadata.kind ?? 'missing'}, expected ${sourceKind}`);
  if (metadata.platform !== 'ios') problems.push('Apple creative requires a native iOS recording');
  if (
    metadata.presentation !== undefined &&
    (!['native-lock-screen', 'native-notification-center'].includes(metadata.presentation) || takeId !== 'lock-screen')
  )
    problems.push(`unsupported native presentation ${metadata.presentation}`);
  if (
    takeId === 'log' &&
    variant === 'moonboard' &&
    metadata.boardKind !== undefined &&
    metadata.boardKind !== 'moonboard'
  )
    problems.push('MoonBoard history must not claim another native board family');
  const crewFamily =
    takeId === 'crew'
      ? variant === 'default' || variant === 'kilter'
        ? 'kilter'
        : variant === 'tension'
          ? 'tension'
          : undefined
      : undefined;
  const boardFamily = takeId.startsWith('boards-')
    ? takeId.slice('boards-'.length)
    : takeId.startsWith('moonboard-')
      ? 'moonboard'
      : takeId === 'spray'
        ? 'spray'
        : crewFamily;
  if (boardFamily && metadata.boardKind !== boardFamily)
    problems.push(`native board ${metadata.boardKind ?? 'missing'}, expected ${boardFamily}`);

  if (takeId === 'lock-screen') {
    const surface =
      metadata.presentation === 'native-lock-screen'
        ? 'lock-screen'
        : metadata.presentation === 'native-notification-center'
          ? 'notification-center'
          : undefined;
    if (!surface) problems.push('Ending requires a complete native system screen');
    if (!surface || metadata.captureSurface !== surface)
      problems.push('Native ending presentation and capture surface mismatch');
    if (!['default', 'kilter', 'tension'].includes(variant)) problems.push('Unsupported native ending board family');
    const family = variant === 'default' ? 'kilter' : variant;
    if (metadata.boardKind !== family) problems.push(`Live Activity must show the actual ${family} board`);
    if (!/^[a-f0-9]{64}$/.test(metadata.nativeFixtureSourcePngSha256 ?? ''))
      problems.push('Missing reviewed full-screen fixture source hash');
  }
  if (!metadata.recordedAt || !Number.isFinite(Date.parse(metadata.recordedAt)))
    problems.push('missing recording timestamp');
  return problems;
}

/** Reviewed still and native video must refer to the same full phone capture context. */
export function storeSearchNativeLockScreenProblems(
  metadata: Readonly<{
    nativeFixtureSourcePngSha256?: string;
    boardKind?: string;
    locale?: string;
    presentation?: string;
    captureSurface?: string;
  }>,
  screen: Readonly<{ width: number; height: number }>,
  fixture: Pick<
    LiveActivityFixture,
    | 'captureFraming'
    | 'captureSurface'
    | 'lockScreenContext'
    | 'notificationCenterContext'
    | 'boardFamily'
    | 'appLocale'
    | 'sourcePngSha256'
    | 'device'
    | 'nativePixels'
    | 'screenPoints'
    | 'cropRect'
  >,
): string[] {
  const problems: string[] = [];
  if (
    fixture.captureFraming !== 'full-screen' ||
    (fixture.captureSurface === 'lock-screen'
      ? !fixture.lockScreenContext ||
        fixture.lockScreenContext.deviceLocked !== true ||
        fixture.notificationCenterContext !== undefined
      : !fixture.notificationCenterContext ||
        fixture.notificationCenterContext.entryFromAuthenticatedApp !== true ||
        fixture.notificationCenterContext.authenticationState !== 'not-established' ||
        fixture.lockScreenContext !== undefined)
  )
    problems.push('Native ending requires a reviewed complete native system screen fixture');
  const expectedPresentation =
    fixture.captureSurface === 'lock-screen' ? 'native-lock-screen' : 'native-notification-center';
  if (metadata.presentation !== expectedPresentation || metadata.captureSurface !== fixture.captureSurface)
    problems.push('Native ending presentation and fixture surface mismatch');
  if (fixture.boardFamily !== metadata.boardKind || fixture.appLocale !== metadata.locale)
    problems.push('Native ending fixture family or app locale mismatch');
  if (metadata.nativeFixtureSourcePngSha256 !== fixture.sourcePngSha256)
    problems.push('Native ending fixture source hash mismatch');
  if (
    fixture.device !== 'iPhone13Pro' ||
    fixture.nativePixels.width !== 1170 ||
    fixture.nativePixels.height !== 2532 ||
    fixture.screenPoints.width !== 390 ||
    fixture.screenPoints.height !== 844 ||
    screen.width !== 1170 ||
    screen.height !== 2532 ||
    fixture.cropRect.x !== 0 ||
    fixture.cropRect.y !== 0 ||
    fixture.cropRect.width !== screen.width ||
    fixture.cropRect.height !== screen.height
  )
    problems.push('Native ending requires unchanged iPhone 13 Pro 1170x2532 footage');
  return problems;
}

/** Required feature beats cannot disappear into a shorter, misleading cut. */
export function storeSearchRequiredFootageProblems(
  variant: StoreSearchVariant,
  available: ReadonlySet<ShowcaseTakeId>,
): string[] {
  return storeSearchPlan(variant).flatMap((scene) => {
    if (scene.optional) return [];
    const required = scene.takes ?? [scene.id as ShowcaseTakeId];
    if (scene.id === 'boards' && required.length > 1 && required.some((takeId) => available.has(takeId))) return [];
    return required
      .filter((takeId) => !available.has(takeId))
      .map((takeId) => `Missing required native take: ${takeId}`);
  });
}

/** Scene-specific source ranges keep repeated native takes from sharing the last edit. */
export function storeSearchTakeSegments(
  variant: StoreSearchVariant,
  caption: string,
  takeId: ShowcaseTakeId,
  sceneFrames: number,
  take: Pick<StageTake, 'frameCount' | 'presentation' | 'editorialStartSeconds'>,
  marks: Readonly<Record<string, number>>,
): readonly FootageRange[] {
  const { frameCount } = take;
  const marked = (name: string): number => {
    const seconds = marks[name];
    if (!Number.isFinite(seconds) || seconds < 0 || seconds * SHOWCASE_FPS >= frameCount)
      throw new Error(`${takeId}: missing or unavailable ${name}; re-record ${variant}`);
    return seconds;
  };
  if (!Number.isInteger(frameCount) || frameCount < 2) throw new Error(`${takeId}: missing native frames`);
  if (variant === 'spray' && takeId === 'spray') {
    const firstNext = marked('next-1');
    const secondNext = marked('next-2');
    if (firstNext <= 1.4 || secondNext - firstNext <= 2 || (secondNext + 0.8) * SHOWCASE_FPS >= frameCount)
      throw new Error('spray: native opening, second Next and settled result must all be available');
    if (caption === 'spraySet' || caption === 'photo') return [[SHOWCASE_FPS, SHOWCASE_FPS + 1, sceneFrames]];
    if (caption === 'sprayNext') return [[Math.round((secondNext - 2) * SHOWCASE_FPS), frameCount]];
  }
  if ((variant === 'moonboard' || variant === 'tension') && takeId === `boards-${variant}`) {
    if (frameCount <= SHOWCASE_FPS) throw new Error(`${variant}: native hold map is unavailable`);
    return [[SHOWCASE_FPS, SHOWCASE_FPS + 1, sceneFrames]];
  }
  if (takeId === 'lock-screen') {
    if (!['native-lock-screen', 'native-notification-center'].includes(take.presentation ?? ''))
      throw new Error('lock-screen: complete native phone required');
    const ready = marked('activity-ready');
    const next = marked('next-tapped');
    const from = Math.floor((take.editorialStartSeconds ?? Math.max(ready, next - 1)) * SHOWCASE_FPS);
    // These marks are measured in the original raw pixels, never estimated from the tap or post-stream AX.
    const changed = marked('next-changed');
    const settled = marked('next-settled');
    const readableUntil = from + sceneFrames - STORE_SEARCH_CROSSFADE_FRAMES;
    if (
      !Number.isInteger(from) ||
      from < 0 ||
      ready > next ||
      from / SHOWCASE_FPS < ready ||
      from / SHOWCASE_FPS > next - 0.4 ||
      changed < next ||
      settled < changed ||
      Math.ceil(settled * SHOWCASE_FPS) + SHOWCASE_FPS > readableUntil ||
      from + sceneFrames > frameCount
    )
      throw new Error('lock-screen: native before, actual Next and settled result must fit the selected beat');
    return [[from, from + sceneFrames]];
  }
  let mark: string | undefined;
  if (takeId === 'log')
    mark =
      variant === 'kilter'
        ? 'filter-kilter'
        : variant === 'tension'
          ? 'filter-tension'
          : variant === 'moonboard'
            ? 'filter-moonboard'
            : 'scrolled';
  if (takeId === 'crew') mark = 'row-landed';
  if (takeId === 'spray') mark = 'next-1';
  if (takeId === 'moonboard-filter') mark = 'grade-filter-shown';
  const seconds = mark ? marked(mark) : undefined;
  const from = seconds !== undefined ? Math.max(0, Math.round((seconds - 0.4) * SHOWCASE_FPS)) : SHOWCASE_FPS;
  if (!Number.isInteger(from) || from < 0 || from >= frameCount)
    throw new Error(`${takeId}: unavailable native selection`);
  return [[from, frameCount]];
}

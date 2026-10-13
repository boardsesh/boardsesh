import { resolve } from 'node:path';
import { SHOWCASE_STAGE_DIR, type ShowcaseTakeId } from './contract';
import type { ShowcaseScenePlan } from './timeline';

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
  ...(takes ? { takes } : {}),
  ...(optional ? { optional } : {}),
});

/** Explicit take lists prevent a named CPP from inheriting the legacy Kilter pile or session. */
export function storeSearchPlan(variant: StoreSearchVariant): readonly ShowcaseScenePlan[] {
  if (variant === 'default')
    return [
      beat('boards', 'boards', 120, PILE),
      beat('spray', 'spray', 120),
      beat('crew', 'crew', 120),
      beat('lock-screen', 'island', 120, undefined, true),
      beat('outro', 'outro', 120, []),
    ];
  if (variant === 'kilter')
    return [
      beat('boards', 'kilter', 90, ['boards-kilter']),
      beat('log', 'kilterLog', 90),
      beat('crew', 'friends', 90),
      beat('boards', 'boards', 90, PILE),
      beat('outro', 'outro', 90, []),
    ];
  if (variant === 'tension')
    return [
      beat('boards', 'tension', 90, ['boards-tension']),
      beat('log', 'tensionLog', 90),
      beat('lock-screen', 'island', 90, undefined, true),
      beat('crew', 'tensionFriends', 90, undefined, true),
      beat('outro', 'outro', 90, []),
    ];
  if (variant === 'moonboard')
    return [
      beat('boards', 'moonboard', 90, ['boards-moonboard']),
      beat('log', 'moonboardLog', 90, ['moonboard-import'], true),
      beat('wall', 'grade', 90, ['moonboard-filter'], true),
      beat('crew', 'friends', 90, undefined, true),
      beat('outro', 'outro', 90, []),
    ];
  return [
    beat('spray', 'spraySet', 90),
    beat('spray', 'photo', 90),
    beat('log', 'sends', 90),
    beat('boards', 'gymBoards', 90, ['boards-spray', 'boards-kilter', 'boards-moonboard']),
    beat('outro', 'outro', 90, []),
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
  }>,
  takeId: ShowcaseTakeId,
  locale: StoreSearchLocale,
  variant: StoreSearchVariant,
): string[] {
  const problems: string[] = [];
  if (metadata.validated !== true) problems.push('recording has not passed native validation');
  if (metadata.takeId !== takeId) problems.push(`recording take ${metadata.takeId ?? 'missing'}, expected ${takeId}`);
  if (metadata.locale !== locale) problems.push(`recording locale ${metadata.locale ?? 'missing'}, expected ${locale}`);
  if (metadata.kind !== variant) problems.push(`recording variant ${metadata.kind ?? 'missing'}, expected ${variant}`);
  if (metadata.platform !== 'ios') problems.push('Apple creative requires a native iOS recording');
  if (!metadata.recordedAt || !Number.isFinite(Date.parse(metadata.recordedAt)))
    problems.push('missing recording timestamp');
  return problems;
}

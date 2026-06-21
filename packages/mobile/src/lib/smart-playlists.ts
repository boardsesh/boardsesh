// Mobile port of web's `packages/web/app/lib/smart-playlists.ts`. Same presets,
// slugs, icons, and i18n keys; colours are inlined as the hex values from the
// web theme tokens (mobile has no MUI `themeTokens`). Used by the Discover
// library screen to render the "Your Picks" smart-playlist grid and by the
// smart-playlist detail screen to resolve a type's presentation.

import type { SmartPlaylistType } from '@boardsesh/graphql/operations/playlists';

export type SmartPlaylistSlug =
  | 'five-stars'
  | 'most-repeated'
  | 'projects'
  | 'liked-climbs'
  | 'crowd-favorites'
  | 'hidden-gems'
  | 'at-your-level'
  | 'fresh';

export type SmartPlaylistPresentation = {
  type: SmartPlaylistType;
  slug: SmartPlaylistSlug;
  /** Emoji rendered centered on the preview square. */
  icon: string;
  /** Tile background tint (hex, mirrors the web theme token). */
  color: string;
  /** i18n key under the `playlists` namespace for the card / page title. */
  titleI18nKey: string;
  /** i18n key for a one-line description shown on the detail page header. */
  descriptionI18nKey: string;
};

export const SMART_PLAYLISTS: SmartPlaylistPresentation[] = [
  {
    type: 'RECOMMENDED_CROWD_FAVORITES',
    slug: 'crowd-favorites',
    icon: '🔥',
    color: '#d65a4f',
    titleI18nKey: 'library.smart.crowdFavorites.title',
    descriptionI18nKey: 'library.smart.crowdFavorites.description',
  },
  {
    type: 'RECOMMENDED_HIDDEN_GEMS',
    slug: 'hidden-gems',
    icon: '💎',
    color: '#9C27B0',
    titleI18nKey: 'library.smart.hiddenGems.title',
    descriptionI18nKey: 'library.smart.hiddenGems.description',
  },
  {
    type: 'RECOMMENDED_AT_LEVEL',
    slug: 'at-your-level',
    icon: '📈',
    color: '#5fb27a',
    titleI18nKey: 'library.smart.atYourLevel.title',
    descriptionI18nKey: 'library.smart.atYourLevel.description',
  },
  {
    type: 'RECOMMENDED_FRESH',
    slug: 'fresh',
    icon: '🌱',
    color: '#FBBF24',
    titleI18nKey: 'library.smart.fresh.title',
    descriptionI18nKey: 'library.smart.fresh.description',
  },
  {
    type: 'FIVE_STARS',
    slug: 'five-stars',
    icon: '⭐',
    color: '#FBBF24', // themeTokens.colors.amber
    titleI18nKey: 'library.smart.fiveStars.title',
    descriptionI18nKey: 'library.smart.fiveStars.description',
  },
  {
    type: 'MOST_REPEATED',
    slug: 'most-repeated',
    icon: '🔁',
    color: '#9C27B0', // themeTokens.colors.purple
    titleI18nKey: 'library.smart.mostRepeated.title',
    descriptionI18nKey: 'library.smart.mostRepeated.description',
  },
  {
    type: 'PROJECTS',
    slug: 'projects',
    icon: '🎯',
    color: '#2563EB', // blue — distinct from the amber/purple/pink presets
    titleI18nKey: 'library.smart.projects.title',
    descriptionI18nKey: 'library.smart.projects.description',
  },
  {
    type: 'LIKED_CLIMBS',
    slug: 'liked-climbs',
    icon: '❤️',
    color: '#EC4899', // themeTokens.colors.pink
    titleI18nKey: 'library.smart.likedClimbs.title',
    descriptionI18nKey: 'library.smart.likedClimbs.description',
  },
];

export const DEFAULT_PINNED_SMART_PLAYLIST_TYPES: SmartPlaylistType[] = ['LIKED_CLIMBS', 'FIVE_STARS'];

const BY_TYPE = new Map<SmartPlaylistType, SmartPlaylistPresentation>(
  SMART_PLAYLISTS.map((preset) => [preset.type, preset]),
);

/** Resolve a smart-playlist type to its presentation, or null when unknown. */
export function smartPlaylistByType(type: string): SmartPlaylistPresentation | null {
  return BY_TYPE.get(type as SmartPlaylistType) ?? null;
}

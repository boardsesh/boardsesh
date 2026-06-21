import type { SmartPlaylistType } from '@boardsesh/graphql/operations/playlists';
import { themeTokens } from '@/app/theme/theme-config';

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
  icon: string;
  color: string;
  /** i18n key under the `playlists` namespace for the card / page title. */
  titleI18nKey: string;
  /** i18n key for a one-line description shown on the detail page header. */
  descriptionI18nKey: string;
};

export const SMART_PLAYLISTS: SmartPlaylistPresentation[] = [
  // Recommendations lead the grid — discovering great new climbs for your board
  // is the point of this surface. They're computed from the catalog for the
  // user's biggest board, not from the user's own logbook.
  {
    type: 'RECOMMENDED_CROWD_FAVORITES',
    slug: 'crowd-favorites',
    icon: '🔥',
    color: themeTokens.colors.accentRose,
    titleI18nKey: 'library.smart.crowdFavorites.title',
    descriptionI18nKey: 'library.smart.crowdFavorites.description',
  },
  {
    type: 'RECOMMENDED_HIDDEN_GEMS',
    slug: 'hidden-gems',
    icon: '💎',
    color: themeTokens.colors.purple,
    titleI18nKey: 'library.smart.hiddenGems.title',
    descriptionI18nKey: 'library.smart.hiddenGems.description',
  },
  {
    type: 'RECOMMENDED_AT_LEVEL',
    slug: 'at-your-level',
    icon: '📈',
    color: themeTokens.colors.accentGreen,
    titleI18nKey: 'library.smart.atYourLevel.title',
    descriptionI18nKey: 'library.smart.atYourLevel.description',
  },
  {
    type: 'RECOMMENDED_FRESH',
    slug: 'fresh',
    icon: '🌱',
    color: themeTokens.colors.amber,
    titleI18nKey: 'library.smart.fresh.title',
    descriptionI18nKey: 'library.smart.fresh.description',
  },
  {
    type: 'FIVE_STARS',
    slug: 'five-stars',
    icon: '⭐',
    color: themeTokens.colors.amber,
    titleI18nKey: 'library.smart.fiveStars.title',
    descriptionI18nKey: 'library.smart.fiveStars.description',
  },
  {
    type: 'MOST_REPEATED',
    slug: 'most-repeated',
    icon: '🔁',
    color: themeTokens.colors.purple,
    titleI18nKey: 'library.smart.mostRepeated.title',
    descriptionI18nKey: 'library.smart.mostRepeated.description',
  },
  {
    type: 'PROJECTS',
    slug: 'projects',
    icon: '🎯',
    color: themeTokens.colors.accentRose,
    titleI18nKey: 'library.smart.projects.title',
    descriptionI18nKey: 'library.smart.projects.description',
  },
  {
    type: 'LIKED_CLIMBS',
    slug: 'liked-climbs',
    icon: '❤️',
    color: themeTokens.colors.pink,
    titleI18nKey: 'library.smart.likedClimbs.title',
    descriptionI18nKey: 'library.smart.likedClimbs.description',
  },
];

const BY_SLUG = new Map<string, SmartPlaylistPresentation>(SMART_PLAYLISTS.map((p) => [p.slug, p]));
const BY_TYPE = new Map<SmartPlaylistType, SmartPlaylistPresentation>(SMART_PLAYLISTS.map((p) => [p.type, p]));

export function smartPlaylistBySlug(slug: string): SmartPlaylistPresentation | undefined {
  return BY_SLUG.get(slug);
}

export function smartPlaylistByType(type: SmartPlaylistType): SmartPlaylistPresentation {
  const found = BY_TYPE.get(type);
  if (!found) throw new Error(`Unknown smart playlist type: ${String(type)}`);
  return found;
}

export function smartPlaylistHref(slug: SmartPlaylistSlug, userId: string): string {
  return `/discover/${slug}/${encodeURIComponent(userId)}`;
}

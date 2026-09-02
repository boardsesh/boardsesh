import type { AscentFeedItem } from '@boardsesh/graphql/operations';

/** Which section of the picker a row came from — carried into the attach analytics. */
export type ShareBetaAscentSource = 'suggested' | 'other';

export type ShareBetaListItem =
  | {
      kind: 'section';
      key: 'section:suggested' | 'section:other';
      source: ShareBetaAscentSource;
    }
  | {
      kind: 'ascent';
      key: string;
      source: ShareBetaAscentSource;
      ascent: AscentFeedItem;
    };

type BuildShareBetaListItemsInput = {
  ascents: AscentFeedItem[];
  suggestions: AscentFeedItem[];
  isSearching: boolean;
};

function uniqueAscentsByUuid(ascents: AscentFeedItem[]): AscentFeedItem[] {
  const seenUuids = new Set<string>();
  const uniqueAscents: AscentFeedItem[] = [];
  for (const ascent of ascents) {
    if (seenUuids.has(ascent.uuid)) continue;
    seenUuids.add(ascent.uuid);
    uniqueAscents.push(ascent);
  }
  return uniqueAscents;
}

/**
 * Flatten the caption matches and the paginated ascents feed into one
 * heterogeneous list, so every row — suggestion included — lives inside
 * FlashList and gets virtualized. The suggestions used to render inside
 * `ListHeaderComponent`, which is mounted for the whole life of the screen and
 * never recycled; that was harmless with text-only rows and wasteful now that
 * each row decodes board art.
 *
 * A caption match owns its climb: every other tick of the same climb drops out
 * of the "other" section, which is the de-duplication the screen did inline
 * before.
 */
export function buildShareBetaListItems({
  ascents,
  suggestions,
  isSearching,
}: BuildShareBetaListItemsInput): ShareBetaListItem[] {
  const uniqueAscents = uniqueAscentsByUuid(ascents);
  const uniqueSuggestions = isSearching ? [] : uniqueAscentsByUuid(suggestions);

  if (uniqueSuggestions.length === 0) {
    return uniqueAscents.map((ascent) => ({
      kind: 'ascent',
      key: `other:${ascent.uuid}`,
      source: 'other',
      ascent,
    }));
  }

  const suggestedClimbUuids = new Set(uniqueSuggestions.map((ascent) => ascent.climbUuid));
  const otherAscents = uniqueAscents.filter((ascent) => !suggestedClimbUuids.has(ascent.climbUuid));
  const listItems: ShareBetaListItem[] = [
    { kind: 'section', key: 'section:suggested', source: 'suggested' },
    ...uniqueSuggestions.map((ascent): ShareBetaListItem => ({
      kind: 'ascent',
      key: `suggested:${ascent.uuid}`,
      source: 'suggested',
      ascent,
    })),
  ];

  if (otherAscents.length > 0) {
    listItems.push(
      { kind: 'section', key: 'section:other', source: 'other' },
      ...otherAscents.map((ascent): ShareBetaListItem => ({
        kind: 'ascent',
        key: `other:${ascent.uuid}`,
        source: 'other',
        ascent,
      })),
    );
  }

  return listItems;
}

/** Hoisted so FlashList never sees a fresh closure on re-render. */
export function shareBetaListKey(item: ShareBetaListItem): string {
  return item.key;
}

/** Separate recycler pools for section headers and ascent rows. */
export function shareBetaListItemType(item: ShareBetaListItem): ShareBetaListItem['kind'] {
  return item.kind;
}

import type { AscentFeedItem } from '@boardsesh/graphql/operations';

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
 * Flatten caption matches and the paginated feed into one heterogeneous list so
 * FlashList can virtualize every ascent. A caption match owns its climb in the
 * list: every recent tick for that climb is removed from the "other" section,
 * matching the picker's previous de-duplication contract.
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
    ...uniqueSuggestions.map(
      (ascent): ShareBetaListItem => ({
        kind: 'ascent',
        key: `suggested:${ascent.uuid}`,
        source: 'suggested',
        ascent,
      }),
    ),
  ];

  if (otherAscents.length > 0) {
    listItems.push(
      { kind: 'section', key: 'section:other', source: 'other' },
      ...otherAscents.map(
        (ascent): ShareBetaListItem => ({
          kind: 'ascent',
          key: `other:${ascent.uuid}`,
          source: 'other',
          ascent,
        }),
      ),
    );
  }

  return listItems;
}

export function shareBetaListKey(item: ShareBetaListItem): string {
  return item.key;
}

export function shareBetaListItemType(item: ShareBetaListItem): ShareBetaListItem['kind'] {
  return item.kind;
}

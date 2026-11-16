import { useCallback, useRef } from 'react';

/**
 * A FlashList `keyExtractor` whose keys change when a new search's rows replace
 * the previous search's, and stay put through pagination, refetches and the
 * placeholder phase.
 *
 * FlashList 2 keeps the list's place across data changes by default
 * (`maintainVisibleContentPosition`). After a commit it looks up the key of the
 * row that was first on screen; when that key turns up at another index it moves
 * its render window by the difference, assumes the native scroll followed, and
 * ignores scroll events for 100 ms. A new search is a new list, but a climb in
 * the old results is often in the new ones too: the previous first row found at
 * index 7 of an 8B search shifted the window 7 rows (2,751 px) down while the
 * scroll stayed at the top, so nothing was mounted on screen until a drag sent a
 * fresh scroll event. With a per-result-set key the old row is never found and
 * FlashList has nothing to carry over.
 *
 * `searchKey` names the search in force; `isPlaceholderData` says the rows on
 * screen still belong to the one before it. Keys only advance once the rows do.
 */
export function useResultSetKeyExtractor<Item>(
  searchKey: string,
  isPlaceholderData: boolean,
  itemKey: (item: Item) => string,
): (item: Item) => string {
  const resultSetRef = useRef({ searchKey, generation: 0 });
  if (!isPlaceholderData && resultSetRef.current.searchKey !== searchKey) {
    resultSetRef.current = { searchKey, generation: resultSetRef.current.generation + 1 };
  }
  const { generation } = resultSetRef.current;
  return useCallback((item: Item) => `${generation}:${itemKey(item)}`, [generation, itemKey]);
}

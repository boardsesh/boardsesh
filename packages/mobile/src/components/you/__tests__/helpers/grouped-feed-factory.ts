/**
 * Adapts a mocked flat `useUserAscentsFeed` result into the grouped
 * `useUserGroupedAscentsFeed` page shape (one single-entry group per item),
 * so the legacy LogbookTab suites keep driving the tab through their flat
 * fixtures now that the default sort renders the grouped feed. Grouping
 * BEHAVIOUR (best-entry pick, tries summing, chooser routing) is covered by
 * logbook-tab-grouped.test.tsx — this factory only satisfies the hook contract.
 */
export const toGroupedFeed = (flat: Record<string, unknown>) => {
  const data = flat.data as
    | { pages: Array<{ userAscentsFeed: { items: Array<{ uuid: string; climbUuid: string }> } }> }
    | undefined;
  return {
    ...flat,
    data: data
      ? {
          pages: data.pages.map((page) => ({
            userGroupedAscentsFeed: {
              groups: page.userAscentsFeed.items.map((item) => ({
                key: `g-${item.uuid}`,
                climbUuid: item.climbUuid,
                date: '2026-06-15',
                items: [item],
              })),
              totalCount: page.userAscentsFeed.items.length,
              hasMore: false,
            },
          })),
        }
      : data,
  };
};

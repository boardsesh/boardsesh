/** Empty visibility-filtered pages need one explicit continuation, never a drain loop. */
export function requiresCrewPageTap(page: { items: readonly unknown[]; hasMore: boolean } | undefined): boolean {
  return page?.items.length === 0 && page.hasMore;
}

/** Locks belong to a feed scope; an old request cannot block a newly selected board. */
export function createFeedPageGate() {
  const loadingSources = new Set<string>();
  return {
    claim(source: string): boolean {
      if (loadingSources.has(source)) return false;
      loadingSources.add(source);
      return true;
    },
    release(source: string) {
      loadingSources.delete(source);
    },
  };
}

/** The query module registers once when its document-local client is first created. */
let clearQueries: (() => Promise<void>) | undefined;

export function registerMarketingQueryCleanup(cleanup: () => Promise<void>): void {
  clearQueries = cleanup;
}

/** Do not import or initialize a query client just to clear an unused island. */
export function clearInitializedMarketingQueries(): Promise<void> {
  return clearQueries?.() ?? Promise.resolve();
}

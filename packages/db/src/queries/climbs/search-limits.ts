// Kept free of imports so light callers (request validation) can read it
// without loading the db schema. See queries/constants.ts.

/**
 * Upper bound on the page index. 500 pages × the 100-row pageSize cap is a 50k-row
 * worst-case OFFSET on the index-ordered path — bounded and cheap; legitimate UI
 * paging never approaches it. The API layer rejects pages past this; the shared
 * query clamps as a backstop for SSR/direct callers that bypass that validation,
 * so a crafted `page=10_000_000` can't force an OFFSET-200M serial scan per request.
 */
export const MAX_SEARCH_PAGE = 500;

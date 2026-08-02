// Typed readers for server errors that both clients have to branch on, rather
// than string-matching English prose. graphql-request throws ClientError-shaped
// errors carrying `response.errors[]`; some call sites re-throw with
// `graphqlErrors`, so both shapes are accepted.

type GraphqlErrorLike = {
  message?: string;
  extensions?: {
    code?: unknown;
    [key: string]: unknown;
  } | null;
};

function getGraphqlErrors(error: unknown): GraphqlErrorLike[] {
  if (!error || typeof error !== 'object') return [];
  const response = (error as { response?: { errors?: GraphqlErrorLike[] } }).response;
  if (Array.isArray(response?.errors)) return response.errors;
  const graphqlErrors = (error as { graphqlErrors?: GraphqlErrorLike[] }).graphqlErrors;
  return Array.isArray(graphqlErrors) ? graphqlErrors : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The board `createBoard` refused to duplicate, as named by the server. */
export type DuplicateBoardError = {
  boardUuid: string;
  boardName: string;
  boardSlug: string | null;
  locationName: string | null;
};

/**
 * `createBoard`'s "you already own this board at this place" rejection, with the
 * existing board's identity attached.
 *
 * Not a failure to report — the user chooses between using that board and adding
 * a genuinely different one, and the create is retried with
 * `allowDuplicateConfig`. The board's identity comes off the error rather than
 * out of a client's `myBoards` cache, which is paginated and can't be searched
 * reliably (#4166).
 */
export function readDuplicateBoardError(error: unknown): DuplicateBoardError | null {
  for (const graphqlError of getGraphqlErrors(error)) {
    if (graphqlError.extensions?.code !== 'BOARD_DUPLICATE_CONFIG') continue;
    const boardUuid = asString(graphqlError.extensions.existingBoardUuid);
    if (!boardUuid) continue;
    return {
      boardUuid,
      boardName: asString(graphqlError.extensions.existingBoardName) ?? '',
      boardSlug: asString(graphqlError.extensions.existingBoardSlug),
      locationName: asString(graphqlError.extensions.existingBoardLocationName),
    };
  }
  return null;
}

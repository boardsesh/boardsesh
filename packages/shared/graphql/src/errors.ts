// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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

/** The board the server refused to duplicate, as named by the server. */
export type DuplicateBoardError = {
  boardUuid: string;
  boardName: string;
  boardSlug: string | null;
  locationName: string | null;
  /** The existing board's own angle, so a link to it doesn't land on the type default. */
  angle: number | null;
};

/**
 * The "you already own this board at this place" rejection, whether or not the
 * server attached the colliding board's identity. Both `createBoard` and
 * `updateBoard` throw it — create when a new board would land on one you own,
 * update when a config change would make an existing board match a sibling.
 *
 * Use this to decide WHETHER to prompt, and `readDuplicateBoardError` to decide
 * what to name in the prompt: `updateBoard` strips the identity extensions when
 * the editor is not the board's owner (a gym admin, a community moderator), so
 * a duplicate that a non-owner hit carries the code and nothing else.
 */
export function isDuplicateBoardError(error: unknown): boolean {
  return getGraphqlErrors(error).some((graphqlError) => graphqlError.extensions?.code === 'BOARD_DUPLICATE_CONFIG');
}

/**
 * The identity of the board the server refused to duplicate, or null when the
 * server withheld it (see `isDuplicateBoardError` — a non-owner editor gets the
 * bare code) or the error is something else entirely.
 *
 * Not a failure to report — the user chooses between using that board and
 * keeping a genuinely different one, and the mutation is retried with
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
      angle:
        typeof graphqlError.extensions.existingBoardAngle === 'number'
          ? graphqlError.extensions.existingBoardAngle
          : null,
    };
  }
  return null;
}

/**
 * The server refusing to add another board because the account is at its
 * ceiling. Worth branching on rather than surfacing as a generic failure: the
 * fix is to delete a board the climber no longer uses, not to retry.
 */
export function isBoardLimitError(error: unknown): boolean {
  return getGraphqlErrors(error).some((graphqlError) => graphqlError.extensions?.code === 'BOARD_LIMIT_REACHED');
}

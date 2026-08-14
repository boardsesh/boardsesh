// Serial-reuse detection: a physical wall's serial number can only belong to one
// board on Boardsesh. When a user is about to register a serial another climber
// already owns, we steer them onto that existing board instead of creating a
// duplicate wall that splits everyone's sends and stats. These are the pure
// helpers shared by the create flow, the inline form warning, and the tests.

import type { UserBoard } from '@boardsesh/shared-schema';

// The foreign-board selection lives in @boardsesh/shared-schema so the native
// and Expo-web renderers use one implementation (with normalised set-id
// comparison). Re-export it here so this module stays the single import surface
// for the create flow, the inline form warning, and the tests.
export { selectForeignSerialBoards, boardConfigMatches } from '@boardsesh/shared-schema';
export type { SerialBoardConfig } from '@boardsesh/shared-schema';

export type SerialReuseDisclosure = { kind: 'public'; board: UserBoard } | { kind: 'private' };

/**
 * Reduce an authenticated serial lookup to exactly what the reuse UI may show.
 * Private matches deliberately carry no entity object, so a future caller
 * cannot accidentally render the board's name, location, or owner.
 */
export function serialReuseDisclosure(board: UserBoard): SerialReuseDisclosure {
  return board.isPublic ? { kind: 'public', board } : { kind: 'private' };
}

/** The `BOARD_SERIAL_EXISTS` payload the backend attaches to the create error. */
export type SerialExistsErrorInfo =
  | { kind: 'board'; boardUuid: string; slug: string | null; name: string | null }
  // The backend masks the conflicting board's identity when it is private
  // (serial-enumeration guard) — the create is still blocked, so the caller
  // must offer "create anyway" without naming the wall.
  | { kind: 'private' };

type GraphqlErrorLike = {
  extensions?: {
    code?: unknown;
    boardUuid?: unknown;
    slug?: unknown;
    name?: unknown;
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

/**
 * Read the `BOARD_SERIAL_EXISTS` extension the backend throws when a create hits
 * the serial guard (a race the pre-submit check missed). Returns the canonical
 * board's identifiers, or `null` when the error is anything else.
 */
export function extractSerialExistsError(error: unknown): SerialExistsErrorInfo | null {
  for (const graphqlError of getGraphqlErrors(error)) {
    const extensions = graphqlError.extensions;
    if (extensions?.code !== 'BOARD_SERIAL_EXISTS') continue;
    if (typeof extensions.boardUuid !== 'string') return { kind: 'private' };
    return {
      kind: 'board',
      boardUuid: extensions.boardUuid,
      slug: typeof extensions.slug === 'string' ? extensions.slug : null,
      name: typeof extensions.name === 'string' ? extensions.name : null,
    };
  }
  return null;
}

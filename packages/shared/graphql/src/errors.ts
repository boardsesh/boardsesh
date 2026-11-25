// Typed readers for server errors that both clients have to branch on, rather
// than string-matching English prose. graphql-request throws ClientError-shaped
// errors carrying `response.errors[]`; some call sites re-throw with
// `graphqlErrors`, so both shapes are accepted.

import type { SimilarGym } from '@boardsesh/shared-schema';

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

/** One wall named by a BOARD_EXISTING_WALLS refusal. */
export type ExistingWallErrorCandidate = {
  boardUuid: string;
  matchKind: 'EXACT' | 'SETS_DIFFER' | 'LAYOUT_OR_SIZE_DIFFERS' | null;
};

const WALL_MATCH_KINDS = new Set(['EXACT', 'SETS_DIFFER', 'LAYOUT_OR_SIZE_DIFFERS']);

/**
 * `createBoard` refusing because the gym (or a listing within 150 m) already
 * has this wall, under the `existingWallCheck` recheck (#8151). Returns the
 * walls it named, or null when the error is something else. The error carries
 * only uuids and match kinds; the client refetches `existingWallCandidates` to
 * show them, and retries with `CONFIRMED_SEPARATE` and the walls the climber
 * said are different. An empty list still means the refusal happened.
 */
export function readExistingWallsError(error: unknown): ExistingWallErrorCandidate[] | null {
  for (const graphqlError of getGraphqlErrors(error)) {
    if (graphqlError.extensions?.code !== 'BOARD_EXISTING_WALLS') continue;
    const rawCandidates = graphqlError.extensions.candidates;
    if (!Array.isArray(rawCandidates)) return [];
    return rawCandidates.flatMap((rawCandidate: unknown): ExistingWallErrorCandidate[] => {
      if (!rawCandidate || typeof rawCandidate !== 'object') return [];
      const { boardUuid, matchKind } = rawCandidate as { boardUuid?: unknown; matchKind?: unknown };
      const uuid = asString(boardUuid);
      if (!uuid) return [];
      return [
        {
          boardUuid: uuid,
          matchKind:
            typeof matchKind === 'string' && WALL_MATCH_KINDS.has(matchKind)
              ? (matchKind as ExistingWallErrorCandidate['matchKind'])
              : null,
        },
      ];
    });
  }
  return null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** One `SimilarGym` off an error's extensions, or null when it isn't one. */
function readSimilarGym(rawGym: unknown): SimilarGym | null {
  if (!rawGym || typeof rawGym !== 'object') return null;
  const candidate = rawGym as Record<string, unknown>;
  const uuid = asString(candidate.uuid);
  const name = asString(candidate.name);
  if (!uuid || !name) return null;
  return {
    uuid,
    name,
    slug: asString(candidate.slug),
    address: asNullableString(candidate.address),
    website: asNullableString(candidate.website),
    distanceMeters: typeof candidate.distanceMeters === 'number' ? candidate.distanceMeters : null,
    ownerType: candidate.ownerType === 'SYSTEM' ? 'SYSTEM' : 'USER',
    isClaimable: candidate.isClaimable === true,
    canClaimByDomain: candidate.canClaimByDomain === true,
    providerOrigins: Array.isArray(candidate.providerOrigins)
      ? candidate.providerOrigins.filter((origin): origin is string => typeof origin === 'string')
      : [],
  };
}

/**
 * `createGym` refusing because similar gyms are already listed
 * (`GYM_SIMILAR_EXISTS`). Returns the gyms it named, in the `SimilarGym` shape
 * findSimilarGyms returns, or null when the error is something else. The
 * client shows them and, when the climber says theirs is a different gym,
 * retries with `duplicateCheck: { mode: CONFIRMED_SEPARATE }` and every gym it
 * has shown so far. An empty list still means the refusal happened.
 */
export function readSimilarGymsError(error: unknown): SimilarGym[] | null {
  for (const graphqlError of getGraphqlErrors(error)) {
    if (graphqlError.extensions?.code !== 'GYM_SIMILAR_EXISTS') continue;
    const rawCandidates = graphqlError.extensions.candidates;
    if (!Array.isArray(rawCandidates)) return [];
    return rawCandidates.flatMap((rawCandidate: unknown) => {
      const similarGym = readSimilarGym(rawCandidate);
      return similarGym ? [similarGym] : [];
    });
  }
  return null;
}

/**
 * `createGym` refusing because the account already owns the most gyms one
 * account may (`GYM_LIMIT_REACHED`). Not a retry: the climber deletes a gym
 * they no longer run first.
 */
export function isGymLimitError(error: unknown): boolean {
  return getGraphqlErrors(error).some((graphqlError) => graphqlError.extensions?.code === 'GYM_LIMIT_REACHED');
}

/** The `createBoard` / `updateBoard` input field a catalogue refusal names. */
export type UnknownBoardConfigField = 'boardType' | 'layoutId' | 'sizeId' | 'setIds';

const UNKNOWN_BOARD_CONFIG_FIELDS = new Set<string>(['boardType', 'layoutId', 'sizeId', 'setIds']);

/**
 * The server's catalogue refusing a setup (`UNKNOWN_BOARD_CONFIG`), with the
 * field it refused when the server said (#8151): `field` names the first one
 * in cascade order (board type, layout, size, sets), and `invalidSetIds` the
 * set ids the layout and size don't have. An older server sends the code
 * alone, which reads as `field: null`. Null when the error is something else.
 */
export function readUnknownBoardConfigError(
  error: unknown,
): { field: UnknownBoardConfigField | null; invalidSetIds: number[] } | null {
  for (const graphqlError of getGraphqlErrors(error)) {
    if (graphqlError.extensions?.code !== 'UNKNOWN_BOARD_CONFIG') continue;
    const { field, invalidSetIds } = graphqlError.extensions;
    return {
      field:
        typeof field === 'string' && UNKNOWN_BOARD_CONFIG_FIELDS.has(field) ? (field as UnknownBoardConfigField) : null,
      invalidSetIds: Array.isArray(invalidSetIds)
        ? invalidSetIds.filter((setId): setId is number => typeof setId === 'number' && Number.isInteger(setId))
        : [],
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

/**
 * The spray training queue refusing a verdict because the wall version left
 * the training set after the page loaded: its owner switched training off or
 * deleted the wall, an admin hid it, or a newer version of the same photo took
 * its place. Not something to retry. The version has to come off the
 * reviewer's screen. Only the web admin queue meets it.
 */
export function isSprayTrainingNotEligibleError(error: unknown): boolean {
  return getGraphqlErrors(error).some(
    (graphqlError) => graphqlError.extensions?.code === 'SPRAY_TRAINING_NOT_ELIGIBLE',
  );
}

/**
 * The server answered, and it will never take this LED setup from this viewer:
 * the wall is gone, they cannot edit it, or it is archived. Retrying cannot help,
 * unlike a dropped connection, so the client stops holding the save as unsent.
 */
export function isSprayWallLedSaveRefused(error: unknown): boolean {
  return getGraphqlErrors(error).some((graphqlError) =>
    ['SPRAY_WALL_NOT_FOUND', 'SPRAY_WALL_LED_EDIT_DENIED', 'SPRAY_WALL_ARCHIVED'].includes(
      asString(graphqlError.extensions?.code) ?? '',
    ),
  );
}

export function hasGraphqlErrorCode(error: unknown, ...codes: string[]): boolean {
  return getGraphqlErrors(error).some((graphqlError) => codes.includes(asString(graphqlError.extensions?.code) ?? ''));
}

/**
 * A creator linking their board back to a gym whose staff took it off their
 * listing. Not a retry: the staff have to put it back, so the client says that
 * in the climber's language instead of the server's English.
 */
export function isBoardRemovedByGymError(error: unknown): boolean {
  return getGraphqlErrors(error).some((graphqlError) => graphqlError.extensions?.code === 'BOARD_REMOVED_BY_GYM');
}

/**
 * Staff removing a synced board (one listed from public board data) from their
 * gym. The server refuses because the board would stay on the map as a loose
 * pin; deleting it is the action that works, and the client says so.
 */
export function isSystemBoardDeleteInsteadError(error: unknown): boolean {
  return getGraphqlErrors(error).some(
    (graphqlError) => graphqlError.extensions?.code === 'SYSTEM_BOARD_DELETE_INSTEAD',
  );
}

/**
 * `resolveDirectoryReport` on a report that is already closed: someone else
 * closed it, or the action that settles it (a delete, a removal) closed it on
 * the server first. Either way the report is done, so callers treat it as success.
 */
export function isDirectoryReportClosedError(error: unknown): boolean {
  return getGraphqlErrors(error).some((graphqlError) => graphqlError.extensions?.code === 'REPORT_CLOSED');
}

/**
 * `undoBoardSetupChange` on a change that can't be undone any more because the
 * board's setup changed again since (an edit, another climber's change). Not a
 * retry: the client says the board changed since and reads the board again. A
 * change someone already undid is `isBoardSetupAlreadyUndoneError` instead.
 */
export function isBoardSetupChangedSinceError(error: unknown): boolean {
  return getGraphqlErrors(error).some((graphqlError) => graphqlError.extensions?.code === 'BOARD_SETUP_CHANGED_SINCE');
}

/**
 * `undoBoardSetupChange` on a change someone undid first (the creator, the
 * gym's staff or an admin, from another device or the admin list). The old
 * setup is already back, so callers treat it as done and read the board again.
 */
export function isBoardSetupAlreadyUndoneError(error: unknown): boolean {
  return getGraphqlErrors(error).some((graphqlError) => graphqlError.extensions?.code === 'BOARD_SETUP_ALREADY_UNDONE');
}

/**
 * `reportBoard` refusing a suggested setup because the board already has it
 * (BAD_USER_INPUT with `extensions.reason` `SETUP_UNCHANGED`). Usually a page or
 * sheet read before someone else fixed the board: the client reads the board
 * again and says it may already be fixed, rather than showing a generic error.
 */
export function isBoardSetupUnchangedError(error: unknown): boolean {
  return getGraphqlErrors(error).some(
    (graphqlError) =>
      graphqlError.extensions?.code === 'BAD_USER_INPUT' && graphqlError.extensions.reason === 'SETUP_UNCHANGED',
  );
}

/** The exact message `detachBoardFromGym` throws (with `BAD_USER_INPUT`) when the board isn't at the gym. */
const BOARD_NOT_AT_GYM_MESSAGE = 'This board is not listed at this gym.';

/**
 * `detachBoardFromGym` on a board that already left the gym (the creator moved
 * it, or someone else removed it). The server has no dedicated code for it, so
 * this matches `BAD_USER_INPUT` plus its message. The removal is already done,
 * so callers treat it as success.
 */
export function isBoardNotAtGymError(error: unknown): boolean {
  return getGraphqlErrors(error).some(
    (graphqlError) =>
      graphqlError.extensions?.code === 'BAD_USER_INPUT' && graphqlError.message === BOARD_NOT_AT_GYM_MESSAGE,
  );
}

// `createBoard`, with the server's duplicate rejection recovered into the board
// it names.
//
// Shared by every caller that resolves a board config into a real `UserBoard`:
// the canonical-URL deep links (`use-board-route-target`) and the party-session
// join screen (`app/join/[sessionId]`). Both walk the owned list first and both
// hit the same race afterwards, so the recovery lives here rather than in either.

import type { CreateBoardInput, UserBoard } from '@boardsesh/shared-schema';
import { readDuplicateBoardError } from './extract-error-message';
import { fetchBoardByUuid } from './hooks';

/**
 * Create the board `input` describes, adopting the existing board when the
 * server rejects the create as a duplicate.
 *
 * Walking the owned list first closes the common case but not the race: a board
 * with this config created on another device between that walk and this create
 * still comes back as BOARD_DUPLICATE_CONFIG. The rejection carries the existing
 * board's uuid precisely so a client needn't search a paginated list for it — so
 * a join or deep link that would otherwise dead-end adopts the board the user
 * already has. The angle comes off the create input, which is the URL's / the
 * session's.
 */
export async function createBoardOrAdoptDuplicate(
  input: CreateBoardInput,
  createBoard: (input: CreateBoardInput) => Promise<UserBoard>,
): Promise<UserBoard> {
  try {
    return await createBoard(input);
  } catch (createError) {
    const duplicate = readDuplicateBoardError(createError);
    if (!duplicate) throw createError;
    // A duplicate naming a board we then can't read is a dead end, not a
    // fallback — and the create rejection is the failure that describes what
    // happened, so the lookup's own rejection is swallowed rather than replacing
    // it. Hence `.catch(() => null)`: a rejected lookup and a null board are the
    // same outcome here.
    const existing = await fetchBoardByUuid(duplicate.boardUuid).catch(() => null);
    if (!existing) throw createError;
    // `CreateBoardInput.angle` is optional on the wire; `buildCreateBoardInput`
    // always fills it from the path, and the board's own angle is the fallback.
    const angle = input.angle ?? existing.angle;
    return existing.angle === angle ? existing : { ...existing, angle };
  }
}

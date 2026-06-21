// Resolves a session's `boardPath` string into a full `UserBoard` ready to be
// set as the active board when joining a party session.
//
// A `boardPath` (e.g. `kilter/8/17/27,28/40`) is just a config tuple — it has
// no uuid/slug, but `setActiveBoard` (and the BLE wrapper, BoardProvider, etc.)
// need a real UserBoard. Resolution mirrors the board builder's create flow
// (app/boards/create): reuse a board the user already owns that matches the
// config, otherwise persist a new one via CREATE_BOARD so the server hands back
// a full UserBoard (uuid/slug/isAngleAdjustable).
//
// The pure logic (parse + owned-reuse + the create-input it would build) is
// factored out so it can be unit-tested without React/GraphQL. The join screen
// wires the real `useMyBoards` data + `useCreateBoard` mutation into `deps`.

import type { CreateBoardInput, UserBoard } from '@boardsesh/shared-schema';
import { parseBoardPath, parseNamedBoardPath, formatBoardDisplayName } from '@boardsesh/board-config';
import { findOwnedBoardForConfig } from '../components/board-discovery/board-items';

/** A board config parsed out of a session boardPath, with a concrete angle. */
export type ResolvedBoardConfig = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  /** Comma-separated set ids, as stored on UserBoard. */
  setIds: string;
  angle: number;
};

export type ResolveBoardDeps = {
  /** The boards the signed-in user already owns (from `useMyBoards`). */
  ownedBoards: UserBoard[];
  /** Persists a new board server-side and returns the full UserBoard. */
  createBoard: (input: CreateBoardInput) => Promise<UserBoard>;
  /** Resolve a named board (`/b/{slug}`) to its full entity, or null when the
   *  slug no longer resolves. Backs the named-board branch of
   *  {@link resolveBoardForSession} (the `fetchBoardBySlug` GraphQL lookup). */
  fetchBoardBySlug: (slug: string) => Promise<UserBoard | null>;
};

/**
 * Parse a session boardPath into a config tuple. Returns `null` when the path
 * isn't a valid board path or has no angle — a party board is always at a
 * concrete angle, so a missing angle means we can't resolve a usable board.
 */
export function parseBoardConfigFromPath(boardPath: string): ResolvedBoardConfig | null {
  const parsed = parseBoardPath(boardPath);
  if (!parsed || parsed.angle == null) return null;
  return {
    boardType: parsed.boardName,
    layoutId: parsed.layoutId,
    sizeId: parsed.sizeId,
    setIds: parsed.setIds,
    angle: parsed.angle,
  };
}

/**
 * Find a board the user already owns matching `config` (ignoring angle). When
 * found, returns it with the path's angle applied — a session can be on any
 * angle, and we never want to leave the joiner on the board's last-used angle.
 */
export function findOwnedBoardForSession(ownedBoards: UserBoard[], config: ResolvedBoardConfig): UserBoard | undefined {
  const owned = findOwnedBoardForConfig(ownedBoards, {
    boardType: config.boardType,
    layoutId: config.layoutId,
    sizeId: config.sizeId,
    setIds: config.setIds,
  });
  if (!owned) return undefined;
  return owned.angle === config.angle ? owned : { ...owned, angle: config.angle };
}

/**
 * Build the CREATE_BOARD input for a session config when the user owns no
 * matching board. `isOwned: false` — joining someone else's session shouldn't
 * claim the board as your own gear; it's a board you're climbing on right now.
 */
export function buildCreateBoardInput(config: ResolvedBoardConfig): CreateBoardInput {
  return {
    boardType: config.boardType,
    layoutId: config.layoutId,
    sizeId: config.sizeId,
    setIds: config.setIds,
    angle: config.angle,
    isOwned: false,
    name: formatBoardDisplayName(config.boardType),
  };
}

/**
 * Resolve a session `boardPath` into a full `UserBoard`:
 * - Named-board shape (`/b/{slug}` — how named gym boards, incl. MoonBoard, are
 *   referenced): look the slug up via `deps.fetchBoardBySlug` and use that shared
 *   board entity directly, applying the path's angle (or the entity's own angle
 *   when the path carries none). We intentionally skip the owned-reuse/create
 *   path here — a named gym board is the shared board you're climbing on, not a
 *   personal copy to mint.
 * - Tuple shape (`{board}/{layout}/{size}/{sets}/{angle}`):
 *   1. Parse the path → config (throws on an unparseable / angle-less path).
 *   2. Reuse a matching owned board (angle overridden from the path), or
 *   3. Create a new board via `deps.createBoard`.
 */
export async function resolveBoardForSession(boardPath: string, deps: ResolveBoardDeps): Promise<UserBoard> {
  const named = parseNamedBoardPath(boardPath);
  if (named) {
    const board = await deps.fetchBoardBySlug(named.slug);
    if (!board) {
      throw new Error(`Cannot resolve a board from session boardPath: ${boardPath}`);
    }
    const angle = named.angle ?? board.angle;
    return board.angle === angle ? board : { ...board, angle };
  }

  const config = parseBoardConfigFromPath(boardPath);
  if (!config) {
    throw new Error(`Cannot resolve a board from session boardPath: ${boardPath}`);
  }

  const owned = findOwnedBoardForSession(deps.ownedBoards, config);
  if (owned) return owned;

  return deps.createBoard(buildCreateBoardInput(config));
}

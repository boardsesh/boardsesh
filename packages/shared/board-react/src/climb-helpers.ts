import { GraphQLOperationError, isClimbDuplicateExtension } from '@boardsesh/graphql-client';
import type { BoardName, SaveClimbInput } from '@boardsesh/shared-schema';

// Mirrors the subset of web's `SaveClimbOptions` (aurora types) that the save
// mutation actually maps. snake_case is preserved so form payloads can be
// forwarded unchanged from existing create-climb forms on both platforms.
export type SaveClimbOptions = {
  layout_id: number;
  /**
   * The board size the climb was painted on. Optional because the Aurora forms
   * never needed it — a hold id means the same hold on every Aurora size. It is
   * load-bearing on Woods, whose two sizes number their holds from their own
   * origins, so the same frames string describes different holds on each.
   */
  size_id?: number;
  name: string;
  description: string;
  is_draft: boolean;
  frames: string;
  frames_count?: number;
  frames_pace?: number;
  angle: number;
  // Freely-toggleable characteristics to set at creation (no_kickboard / campus).
  // any_feet and no_match ride their own fields below — the server rejects them
  // inside this array.
  characteristics?: string[] | null;
  /** Matching (both hands on one hold) is disallowed. */
  no_match?: boolean;
  /** Feet may use any hold, not only the marked ones. Mutually exclusive with the
   *  `campus` characteristic, which the editor enforces. */
  any_feet?: boolean;
};

export type SaveClimbResponse = {
  uuid: string;
  createdAt?: string | null;
  publishedAt?: string | null;
};

export type UpdateClimbResponse = {
  uuid: string;
  createdAt?: string | null;
  publishedAt?: string | null;
  isDraft: boolean;
};

/**
 * Maps the snake_case form payload to the camelCase GraphQL `SaveClimbInput`.
 *
 * The three optional flags are forwarded as `undefined` when the caller omits
 * them rather than coerced to `false`/`null`: omission means "say nothing about
 * this", and on the update path that is what preserves a flag already on the row.
 * A form that owns the switch sends the boolean either way, including `false`.
 */
export function toSaveClimbInput(boardName: BoardName, options: SaveClimbOptions): SaveClimbInput {
  return {
    boardType: boardName,
    layoutId: options.layout_id,
    sizeId: options.size_id,
    name: options.name,
    description: options.description || '',
    isDraft: options.is_draft,
    frames: options.frames,
    framesCount: options.frames_count,
    framesPace: options.frames_pace,
    angle: options.angle,
    characteristics: options.characteristics ?? null,
    noMatch: options.no_match,
    anyFeet: options.any_feet,
  };
}

/** True when an error is a duplicate-publish rejection the form handles inline. */
export function isDuplicateClimbError(err: unknown): boolean {
  return err instanceof GraphQLOperationError && isClimbDuplicateExtension(err.extensions);
}

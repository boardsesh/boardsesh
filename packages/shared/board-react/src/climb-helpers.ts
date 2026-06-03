import { GraphQLOperationError, isClimbDuplicateExtension } from '@boardsesh/graphql-client';
import type { BoardName, MoonBoardHoldsInput, SaveClimbInput, SaveMoonBoardClimbInput } from '@boardsesh/shared-schema';

// Mirrors the subset of web's `SaveClimbOptions` (aurora types) that the save
// mutation actually maps. snake_case is preserved so form payloads can be
// forwarded unchanged from existing create-climb forms on both platforms.
export type SaveClimbOptions = {
  layout_id: number;
  name: string;
  description: string;
  is_draft: boolean;
  frames: string;
  frames_count?: number;
  frames_pace?: number;
  angle: number;
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

/** Maps the snake_case form payload to the camelCase GraphQL `SaveClimbInput`. */
export function toSaveClimbInput(boardName: BoardName, options: SaveClimbOptions): SaveClimbInput {
  return {
    boardType: boardName,
    layoutId: options.layout_id,
    name: options.name,
    description: options.description || '',
    isDraft: options.is_draft,
    frames: options.frames,
    framesCount: options.frames_count,
    framesPace: options.frames_pace,
    angle: options.angle,
  };
}

/**
 * MoonBoard create payload. MoonBoard diverges from Aurora: holds are grid
 * coordinate buckets (not a frames string), grade/benchmark/setter are
 * MoonBoard-only, and there is no in-place update path (create-only). camelCase
 * here because the MoonBoard editor builds this directly (no legacy snake_case
 * form payload to forward).
 */
export type SaveMoonBoardClimbOptions = {
  layoutId: number;
  name: string;
  description?: string;
  holds: MoonBoardHoldsInput;
  angle: number;
  isDraft?: boolean;
  userGrade?: string;
  isBenchmark?: boolean;
  setter?: string;
};

/** Maps the MoonBoard create options to the GraphQL `SaveMoonBoardClimbInput`. */
export function toSaveMoonBoardClimbInput(options: SaveMoonBoardClimbOptions): SaveMoonBoardClimbInput {
  return {
    boardType: 'moonboard',
    layoutId: options.layoutId,
    name: options.name,
    description: options.description ?? '',
    holds: options.holds,
    angle: options.angle,
    isDraft: options.isDraft,
    userGrade: options.userGrade,
    isBenchmark: options.isBenchmark,
    setter: options.setter,
  };
}

/** True when an error is a duplicate-publish rejection the form handles inline. */
export function isDuplicateClimbError(err: unknown): boolean {
  return err instanceof GraphQLOperationError && isClimbDuplicateExtension(err.extensions);
}

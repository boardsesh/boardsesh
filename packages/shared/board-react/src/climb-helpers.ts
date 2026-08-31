import { GraphQLOperationError, isClimbDuplicateExtension } from '@boardsesh/graphql-client';
import type { BoardName, SaveClimbInput } from '@boardsesh/shared-schema';

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
  // Freely-toggleable characteristics to set at creation (no_kickboard / campus).
  characteristics?: string[] | null;
};

export type SaveClimbResponse = {
  uuid: string;
  controllerRouteUuid?: string | null;
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
    characteristics: options.characteristics ?? null,
  };
}

/** True when an error is a duplicate-publish rejection the form handles inline. */
export function isDuplicateClimbError(err: unknown): boolean {
  return err instanceof GraphQLOperationError && isClimbDuplicateExtension(err.extensions);
}

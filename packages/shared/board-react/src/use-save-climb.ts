import { useMutation } from '@tanstack/react-query';
import { useRef } from 'react';
import {
  SAVE_CLIMB_MUTATION,
  UPDATE_CLIMB_MUTATION,
  type SaveClimbMutationVariables,
  type SaveClimbMutationResponse,
  type UpdateClimbMutationVariables,
  type UpdateClimbMutationResponse,
} from '@boardsesh/graphql/operations/new-climb-feed';
import type { UpdateClimbInput } from '@boardsesh/shared-schema';
import type { SaveClimbDeps, UpdateClimbDeps } from './types';
import {
  toSaveClimbInput,
  isDuplicateClimbError,
  type SaveClimbOptions,
  type SaveClimbResponse,
  type UpdateClimbResponse,
} from './transforms';

/**
 * Renderer-agnostic climb create (SAVE_CLIMB over WS). Ported from web's
 * `packages/web/app/hooks/use-save-climb.ts`; the WS request, generic-error
 * feedback, and optional post-success invalidation are injected via `deps`.
 * Duplicate-publish rejections are suppressed (the form renders a richer inline
 * UX) — the caller still sees the rejection.
 */
export function useSaveClimb(deps: SaveClimbDeps, boardName: string | null) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  return useMutation({
    mutationFn: async (options: SaveClimbOptions): Promise<SaveClimbResponse> => {
      depsRef.current.assertAuthed();
      if (!boardName) {
        throw new Error('No board selected');
      }

      const variables: SaveClimbMutationVariables = { input: toSaveClimbInput(boardName, options) };
      const result = await depsRef.current.requestWs<SaveClimbMutationResponse>(
        SAVE_CLIMB_MUTATION,
        variables as unknown as Record<string, unknown>,
      );
      return result.saveClimb;
    },
    onSuccess: () => {
      depsRef.current.onSaved?.();
    },
    onError: (err) => {
      // Duplicate-publish rejections render a richer inline UX at the form level,
      // so suppress the generic feedback for that case.
      if (isDuplicateClimbError(err)) return;
      depsRef.current.onSaveClimbError();
    },
  });
}

/**
 * Renderer-agnostic climb update (UPDATE_CLIMB over WS). Only the owner may call
 * it, and only while the climb is a draft or within 24h of first publish — the
 * backend enforces both. Failure feedback is an optional injected seam (web
 * omits it today; mobile toasts).
 */
export function useUpdateClimb(deps: UpdateClimbDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  return useMutation({
    mutationFn: async (input: UpdateClimbInput): Promise<UpdateClimbResponse> => {
      depsRef.current.assertAuthed();

      const variables: UpdateClimbMutationVariables = { input };
      const result = await depsRef.current.requestWs<UpdateClimbMutationResponse>(
        UPDATE_CLIMB_MUTATION,
        variables as unknown as Record<string, unknown>,
      );
      return result.updateClimb;
    },
    onSuccess: () => {
      depsRef.current.onSaved?.();
    },
    onError: () => {
      depsRef.current.onError?.();
    },
  });
}

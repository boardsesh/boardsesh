'use client';

import { useEffect, useRef, useState } from 'react';
import type { CncBoardConfigInput } from '@boardsesh/shared-schema';
import {
  VALIDATE_CNC_ARTWORK,
  type ValidateCncArtworkMutationResponse,
  type ValidateCncArtworkMutationVariables,
} from '@boardsesh/graphql/operations/cnc-packs';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { cncErrorKey, type CncErrorKey } from '../cnc-error';

/**
 * The generator's verdict on where the buyer put their artwork.
 *
 * Deliberately NOT a React Query mutation. `useMutation` models "the user
 * pressed a button"; this fires on its own while somebody edits a number, which
 * means an in-flight request is routinely already stale. What that needs is a
 * request counter and a last-write-wins guard, which is what this hook is —
 * plus a debounce, because a width slider produces a call per pixel otherwise.
 */

/**
 * Quiet period before the generator is asked.
 *
 * Longer than the layout hook's 400 ms: this endpoint outlines every glyph and
 * checks a rotated bounding box against every hole on the panel, and the
 * resolver's own ceiling is 60 calls a minute. 500 ms still lands well inside
 * the pause between adjusting one field and looking at the answer.
 */
const ARTWORK_DEBOUNCE_MS = 500;

/** One reason an item cannot be routed where it is. Mirrors the generator's collision shape. */
export type CncArtworkCollision = {
  /** Which item, by its position in the submitted artwork list. */
  artworkIndex: number;
  panelIndex: number | null;
  /** `off_panel`, `keepout`, `crosses_seam` or `cut_through_keepout`. */
  kind: string;
  /** The generator's own sentence. Untranslated — see the note in the artwork step. */
  message: string | null;
};

export type CncArtworkValidationResult = {
  /**
   * Whether the placement is routable.
   *
   * Null means "no answer yet" — nothing placed, signed out, still in flight,
   * or the call failed. Callers must treat null as blocking, the same as a
   * hard `false`, never as a pass: the authoritative check runs again at
   * checkout, but that is a second gate, not a reason to let an unanswered
   * validation wave a buyer through here.
   */
  ok: boolean | null;
  collisions: CncArtworkCollision[];
  isChecking: boolean;
  errorKey: CncErrorKey | null;
};

function readCollisions(raw: unknown): CncArtworkCollision[] {
  if (!Array.isArray(raw)) return [];
  const collisions: CncArtworkCollision[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const collision = entry as Record<string, unknown>;
    const artworkIndex = collision.artwork_index;
    if (typeof artworkIndex !== 'number' || !Number.isFinite(artworkIndex)) continue;
    collisions.push({
      artworkIndex,
      panelIndex: typeof collision.panel_index === 'number' ? collision.panel_index : null,
      kind: typeof collision.kind === 'string' ? collision.kind : 'unknown',
      message: typeof collision.message === 'string' ? collision.message : null,
    });
  }
  return collisions;
}

/**
 * Ask the generator whether this configuration's artwork fits, debounced.
 *
 * Authenticated-only, because the mutation is: an anonymous buyer can still
 * place a label and see the local bounds checks, and gets the real verdict the
 * moment they sign in — which they have to do to buy anyway.
 *
 * A configuration with no artwork never calls out at all and reports `ok: null`
 * rather than `true`. "Nothing to check" and "checked and fine" are different
 * facts, and only one of them should ever unblock a button.
 */
export function useCncArtworkValidation(
  config: CncBoardConfigInput | null,
  authToken: string | null,
): CncArtworkValidationResult {
  const [result, setResult] = useState<{ ok: boolean | null; collisions: CncArtworkCollision[] }>({
    ok: null,
    collisions: [],
  });
  const [isChecking, setIsChecking] = useState(false);
  const [errorKey, setErrorKey] = useState<CncErrorKey | null>(null);

  // Serialised, so the effect re-runs on a CHANGED configuration rather than on
  // every render — the configurator rebuilds the input object each time.
  const hasArtwork = (config?.artwork?.length ?? 0) > 0;
  const configKey = hasArtwork && config ? JSON.stringify(config) : '';

  // Last-write-wins. A slow answer to an old placement must never overwrite a
  // fast answer to the current one, which is exactly what a bare `setResult` in
  // an async callback would allow.
  const requestRef = useRef(0);

  useEffect(() => {
    requestRef.current += 1;
    const requestId = requestRef.current;

    if (!configKey || !authToken) {
      setResult({ ok: null, collisions: [] });
      setIsChecking(false);
      setErrorKey(null);
      return;
    }

    setIsChecking(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const client = createGraphQLHttpClient(authToken);
          const response = await client.request<
            ValidateCncArtworkMutationResponse,
            ValidateCncArtworkMutationVariables
          >(VALIDATE_CNC_ARTWORK, { config: JSON.parse(configKey) as CncBoardConfigInput });
          if (requestId !== requestRef.current) return;
          const verdict = response.validateCncArtwork;
          setResult({ ok: verdict.ok, collisions: readCollisions(verdict.collisions) });
          setErrorKey(null);
        } catch (error) {
          if (requestId !== requestRef.current) return;
          // Back to "no answer", not to a pass. A failed check must leave the
          // Buy button in the same state as an unfinished one.
          setResult({ ok: null, collisions: [] });
          setErrorKey(cncErrorKey(error));
        } finally {
          if (requestId === requestRef.current) setIsChecking(false);
        }
      })();
    }, ARTWORK_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [configKey, authToken]);

  return { ok: result.ok, collisions: result.collisions, isChecking, errorKey };
}

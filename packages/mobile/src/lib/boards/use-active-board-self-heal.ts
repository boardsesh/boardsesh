// Active-board self-heal. The active board is a denormalised UserBoard snapshot
// in AsyncStorage (see active-board-store). A server-side duplicate merge can
// turn that snapshot into a tombstone while the app is already running, so we
// validate once after hydration and again whenever the app returns to the
// foreground. The backend follows merge tombstones and returns the canonical
// board; a null result means an ordinary deletion.
//
// The snapshot is also refreshed in place when the same board comes back with a
// different `hasLeds` — a gym admin flipping the light-kit flag has to reach
// every climber already carrying that board, and their next foreground is the
// only moment we look.

import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import type { UserBoard } from '@boardsesh/shared-schema';
import { fetchBoardByUuid } from '../graphql/hooks';
import {
  getActiveBoardWriteGeneration,
  useActiveBoard,
  useClearActiveBoardIfCurrentGeneration,
  useSetActiveBoardIfCurrentGeneration,
} from '../graphql/use-active-board';
import {
  captureActiveBoardSelfHealValidationEpoch,
  hasInitiallyValidatedActiveBoardUuid,
  isActiveBoardSelfHealValidationEpochCurrent,
  markInitiallyValidatedActiveBoardUuid,
  resetActiveBoardSelfHealValidationCache,
} from './active-board-self-heal-validation-cache';

type ValidationReason = 'initial' | 'foreground';

// The root hook can remount during navigation/provider churn. Remember only
// definitive initial validations across mounts so that churn does not create
// extra requests. Foreground validations deliberately bypass this cache: a merge
// may have happened after the initial result was returned.
/** Test-only reset for the per-session initial-validation guard. */
export function resetActiveBoardSelfHealForTests(): void {
  resetActiveBoardSelfHealValidationCache();
}

export function useActiveBoardSelfHeal(): void {
  const { data: activeBoard } = useActiveBoard();
  const setActiveBoardIfCurrent = useSetActiveBoardIfCurrentGeneration();
  const clearActiveBoardIfCurrent = useClearActiveBoardIfCurrentGeneration();

  const activeUuid = activeBoard?.uuid ?? null;
  const activeUuidRef = useRef<string | null>(activeUuid);
  // The whole stored board, not just its uuid: `validate` doesn't list
  // `activeBoard` in its deps, so reading the closed-over value inside the async
  // body would compare the server's answer against a stale snapshot.
  const activeBoardRef = useRef<UserBoard | null>(activeBoard ?? null);
  const selectionGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const validationInFlightRef = useRef(false);
  const pendingReasonRef = useRef<ValidationReason | null>(null);
  const validateRef = useRef<(reason: ValidationReason) => void>(() => {});
  // A mounted hook belongs to the authenticated tree that created it. Native
  // keeps that tree mounted while sign-out cleanup awaits storage, so capturing
  // a fresh epoch per request would let an old foreground/pending retry cross
  // the boundary. The next authenticated tree gets a fresh hook and epoch.
  const validationCacheEpochRef = useRef<number | null>(null);
  const hookValidationCacheEpoch = validationCacheEpochRef.current ?? captureActiveBoardSelfHealValidationEpoch();
  validationCacheEpochRef.current = hookValidationCacheEpoch;

  // Update during render so a fetch that resolves between commit effects still
  // sees the newest selection. The generation makes the cancellation explicit
  // even if a future board shape reuses a uuid-bearing wrapper object.
  if (activeUuidRef.current !== activeUuid) {
    activeUuidRef.current = activeUuid;
    selectionGenerationRef.current += 1;
  }
  activeBoardRef.current = activeBoard ?? null;

  const validate = useCallback(
    (reason: ValidationReason): void => {
      const storedUuid = activeUuidRef.current;
      if (
        !isActiveBoardSelfHealValidationEpochCurrent(hookValidationCacheEpoch) ||
        !storedUuid ||
        (reason === 'initial' && hasInitiallyValidatedActiveBoardUuid(storedUuid))
      ) {
        return;
      }

      if (validationInFlightRef.current) {
        // Do not lose a foreground or selection-change validation merely because
        // the previous board's request is still settling. Coalesce to one retry.
        pendingReasonRef.current = reason === 'foreground' ? 'foreground' : (pendingReasonRef.current ?? 'initial');
        return;
      }

      validationInFlightRef.current = true;
      const requestGeneration = selectionGenerationRef.current;
      const requestWriteGeneration = getActiveBoardWriteGeneration();

      void (async () => {
        let definitive = false;
        try {
          const resolved = await fetchBoardByUuid(storedUuid);
          if (
            !mountedRef.current ||
            selectionGenerationRef.current !== requestGeneration ||
            activeUuidRef.current !== storedUuid
          ) {
            return;
          }

          if (resolved === null) {
            definitive = await clearActiveBoardIfCurrent(requestWriteGeneration);
          } else if (resolved.uuid !== storedUuid) {
            definitive = await setActiveBoardIfCurrent(requestWriteGeneration, resolved);
            if (definitive) {
              // The canonical board does not need an immediate second initial
              // validation when the active-board cache re-renders this hook.
              markInitiallyValidatedActiveBoardUuid(resolved.uuid, hookValidationCacheEpoch);
            }
          } else if (resolved.hasLeds !== activeBoardRef.current?.hasLeds) {
            // Same board, different light-kit flag: a gym admin turned LEDs on or
            // off since this phone stored its copy. Compared with `!==` on the
            // optional values, so `undefined` on both sides (a query that omitted
            // the field) is not a difference and writes nothing.
            definitive = await setActiveBoardIfCurrent(requestWriteGeneration, resolved);
          } else {
            definitive = true;
          }
        } catch {
          // Offline/auth races are transient. Leave the uuid unvalidated so a
          // later mount, selection effect, or foreground transition retries.
          if (__DEV__) console.warn('[ActiveBoardSelfHeal] validation failed; will retry');
        } finally {
          if (definitive) markInitiallyValidatedActiveBoardUuid(storedUuid, hookValidationCacheEpoch);
          validationInFlightRef.current = false;
          const pendingReason = pendingReasonRef.current;
          pendingReasonRef.current = null;
          if (mountedRef.current && pendingReason) validateRef.current(pendingReason);
        }
      })();
    },
    [clearActiveBoardIfCurrent, hookValidationCacheEpoch, setActiveBoardIfCurrent],
  );
  validateRef.current = validate;

  useEffect(() => {
    mountedRef.current = true;
    validate('initial');
  }, [activeUuid, validate]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') validate('foreground');
    });
    return () => subscription.remove();
  }, [validate]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      selectionGenerationRef.current += 1;
      pendingReasonRef.current = null;
    },
    [],
  );
}

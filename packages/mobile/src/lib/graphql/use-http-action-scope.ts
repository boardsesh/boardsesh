import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { subscribeToCredentialChanges } from '../privacy/privacy-cache';
import { useHttpQueryScope } from './use-http-query-scope';

/** Each UI action keeps its original view and mount, including Strict Mode's
 * cleanup/remount. Local identity is not usable network authority.
 *
 * Two checks, for two kinds of follow-up:
 * - `assertView` / `isCurrent`: the screen's own state and navigation. Retired
 *   when the screen unmounts, on every platform.
 * - `assertOwner` / `isOwnerCurrent`: finishing what the climber started and
 *   saying so in an app-level toast. A browser view's action ends with its
 *   screen, so this is the same as `assertView` there. A native (or wholly
 *   legacy) action outlives its screen and ends only when the account changes,
 *   which is also the only thing that aborts its `signal`. */
export function useHttpActionScope() {
  const scope = useHttpQueryScope();
  const lifetime = useRef({ mounted: true, epoch: 0, controllers: new Set<AbortController>() });
  useLayoutEffect(() => {
    const current = lifetime.current;
    current.mounted = true;
    return () => {
      current.mounted = false;
      current.epoch += 1;
      for (const controller of current.controllers) controller.abort(new BrowserBackendConsumerError('superseded'));
      current.controllers.clear();
    };
  }, []);
  const capture = useCallback(() => {
    const current = lifetime.current;
    const epoch = current.epoch;
    const assertOriginalView = scope.assertView;
    const outlivesScreen = !scope.scoped;
    const controller = new AbortController();
    let finished = false;
    const retired = () => controller.signal.reason ?? new BrowserBackendConsumerError('superseded');
    const assertOwner = () => {
      if (finished || controller.signal.aborted || (!outlivesScreen && (!current.mounted || epoch !== current.epoch)))
        throw retired();
      assertOriginalView();
    };
    const assertView = () => {
      if (!current.mounted || epoch !== current.epoch) throw retired();
      assertOwner();
    };
    assertView();
    const releaseAccount = outlivesScreen
      ? subscribeToCredentialChanges(() => controller.abort(new BrowserBackendConsumerError('superseded')))
      : undefined;
    if (!outlivesScreen) current.controllers.add(controller);
    const passes = (check: () => void) => {
      try {
        check();
        return true;
      } catch {
        return false;
      }
    };
    return Object.freeze({
      signal: controller.signal,
      assertView,
      isCurrent: () => passes(assertView),
      assertOwner,
      isOwnerCurrent: () => passes(assertOwner),
      finish() {
        finished = true;
        current.controllers.delete(controller);
        releaseAccount?.();
      },
    });
  }, [scope]);
  return useMemo(
    () => ({
      key: scope.scoped ? (scope.scope ?? 'unavailable-browser-view') : 'native-legacy-view',
      capture,
    }),
    [scope, capture],
  );
}

export type HttpActionScope = ReturnType<typeof useHttpActionScope>;

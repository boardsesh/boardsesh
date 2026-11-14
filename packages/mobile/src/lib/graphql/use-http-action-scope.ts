import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { useHttpQueryScope } from './use-http-query-scope';

/** Each UI action keeps its original view and mount, including Strict Mode's
 * cleanup/remount. Local identity is not usable network authority. */
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
    const controller = new AbortController();
    let finished = false;
    const assertView = () => {
      if (finished || !current.mounted || epoch !== current.epoch || controller.signal.aborted)
        throw controller.signal.reason ?? new BrowserBackendConsumerError('superseded');
      assertOriginalView();
    };
    assertView();
    current.controllers.add(controller);
    return Object.freeze({
      signal: controller.signal,
      assertView,
      isCurrent() {
        try {
          assertView();
          return true;
        } catch {
          return false;
        }
      },
      finish() {
        finished = true;
        current.controllers.delete(controller);
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

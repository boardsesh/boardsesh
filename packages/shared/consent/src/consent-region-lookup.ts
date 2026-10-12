/** Cache a region answer until resume, including a resume during its request. */
export function createConsentRegionLookup<Answer>(request: () => Promise<Answer>): {
  lookUp: () => Promise<Answer>;
  expire: () => boolean;
  isCurrent: (answer: Promise<Answer>) => boolean;
} {
  let cached: { promise: Promise<Answer>; state: { pending: boolean; refreshRequested: boolean } } | null = null;

  const lookUp = (): Promise<Answer> => {
    if (!cached) {
      const state = { pending: true, refreshRequested: false };
      const promise = (async () => {
        try {
          let answer = await request();
          while (state.refreshRequested) {
            // A response from before resume cannot authorize the new location.
            // Resume events during one request share a single follow-up request.
            state.refreshRequested = false;
            answer = await request();
          }
          return answer;
        } finally {
          state.pending = false;
        }
      })();
      cached = { promise, state };
    }
    return cached.promise;
  };

  const expire = (): boolean => {
    if (!cached) return false;
    if (cached.state.pending) cached.state.refreshRequested = true;
    else cached = null;
    return true;
  };

  // A settled promise may still have UI callbacks waiting in the microtask
  // queue when resume expires it. Those callbacks must not restore capture.
  const isCurrent = (answer: Promise<Answer>): boolean => cached?.promise === answer;

  return { lookUp, expire, isCurrent };
}

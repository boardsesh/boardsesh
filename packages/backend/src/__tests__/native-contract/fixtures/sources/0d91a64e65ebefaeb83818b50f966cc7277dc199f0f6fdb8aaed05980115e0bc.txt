/**
 * Whether this bundle is a development build.
 *
 * A one-line wrapper around `__DEV__`, and it earns its own module for one
 * reason: `__DEV__` is a compile-time DEFINE, not a variable. Metro substitutes
 * it, and so does the mobile vitest config (`__DEV__: 'true'` in
 * packages/mobile/vite.config.ts) — which means a bare `if (!__DEV__)` branch is
 * literally `if (false)` under test and cannot be exercised, and
 * `vi.stubGlobal('__DEV__', false)` does nothing to it because there is no
 * global left to stub.
 *
 * Behind a function in its own module, a test can `vi.mock` it and drive the
 * production branch. Anything whose production-only behaviour must be TESTED
 * should read it through here; a `if (__DEV__) console.warn(...)` does not need
 * to and should stay as it is.
 */
export function isDevBuild(): boolean {
  return __DEV__;
}

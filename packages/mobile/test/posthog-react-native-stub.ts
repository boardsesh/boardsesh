// Vitest stub for `posthog-react-native`.
//
// The real package's entry (dist/index.js) re-exports `PostHogProvider`,
// `PostHogMaskView`, and other components that import React Native native
// modules. Under vitest (node environment) those untransformed RN files throw
// `SyntaxError: Unexpected token 'typeof'` at import time, which fails every
// test suite that transitively imports `src/lib/analytics` (favorites/auth/
// playlists/party-profile providers, use-board-bluetooth, etc.).
//
// Analytics is a no-op in tests anyway — `isAnalyticsEnabled` is false under the
// config's `__DEV__: true` define, so `getClient()` never actually constructs a
// PostHog instance. This stub just needs to satisfy the static imports.
//
// Wired via the `posthog-react-native` alias in packages/mobile/vite.config.ts.

export class PostHog {
  capture(): void {}
  identify(): void {}
  alias(): void {}
  reset(): void {}
  screen(): void {}
  setPersonProperties(): void {}
  startSessionRecording(): Promise<void> {
    return Promise.resolve();
  }
  stopSessionRecording(): Promise<void> {
    return Promise.resolve();
  }
}

export const PostHogProvider = ({ children }: { children?: unknown }) => children;

export default PostHog;

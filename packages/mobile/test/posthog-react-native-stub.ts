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
  constructor(_apiKey?: string, _options?: unknown) {}
  fetch(
    _url: string,
    _options: RequestInit,
  ): Promise<{ status: number; text(): Promise<string>; json(): Promise<unknown> }> {
    return Promise.resolve({ status: 200, text: async () => '', json: async () => ({}) });
  }
  getDistinctId(): string {
    return '';
  }
  getAnonymousId(): string {
    return '';
  }
  optIn(): Promise<void> {
    return Promise.resolve();
  }
  optOut(): Promise<void> {
    return Promise.resolve();
  }
  ready(): Promise<void> {
    return Promise.resolve();
  }
  setPersistedProperty(): void {}
  getPersistedProperty<T>(): T | undefined {
    return undefined;
  }
  capture(): void {}
  captureException(): void {}
  identify(): void {}
  alias(): void {}
  reset(): void {}
  register(): void {}
  screen(): void {}
  getSessionId(): string {
    return '';
  }
  registerForSession(): void {}
  setPersonProperties(): void {}
  flush(): Promise<void> {
    return Promise.resolve();
  }
  startSessionRecording(): Promise<void> {
    return Promise.resolve();
  }
  stopSessionRecording(): Promise<void> {
    return Promise.resolve();
  }
}

export const PostHogPersistedProperty = {
  Queue: 'queue',
  AiQueue: 'ai_queue',
  AiCaptureQueue: 'ai_capture_queue',
  LogsQueue: 'logs_queue',
  DistinctId: 'distinct_id',
  OptedOut: 'opted_out',
  FeatureFlagDetails: 'feature_flag_details',
};

export const PostHogProvider = ({ children }: { children?: unknown }) => children;

export default PostHog;

/**
 * Whether a bottom-chrome consumer that renders OUTSIDE
 * {@link BottomChromeMetricsProvider} should throw. Split into a tiny seam purely
 * so tests can force the release-build path by mocking it to `false`: vitest
 * statically defines `__DEV__` as `true` (packages/mobile/vite.config.ts), so a
 * bare `if (__DEV__)` fallback branch is otherwise unreachable dead code that no
 * test could exercise. Dev and real release builds keep the true behaviour —
 * throw in dev, degrade in release.
 */
export function shouldThrowOnMissingProvider(): boolean {
  return __DEV__;
}

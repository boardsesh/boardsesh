// Test stub for @react-native-community/blur. The real BlurView is a native module
// that can't load under vitest's node/jsdom env. Renders a placeholder so any suite
// can import a blur-backed primitive (GlassSurface, ProgressiveBlur); suites that
// assert blur props register their own vi.mock, which takes precedence over this
// alias.
import { createElement, type ReactNode } from 'react';

export function BlurView({ children }: { children?: ReactNode }) {
  return createElement('div', { 'data-testid': 'blur-view' }, children ?? null);
}

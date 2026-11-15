// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const config = vi.hoisted(() => ({
  platform: 'android',
  isTablet: false,
  widthClass: 'compact',
  nativeBar: false,
  bottom: 24,
  variant: 'material',
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return config.platform;
    },
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: config.bottom }),
}));
vi.mock('../../../hooks/use-device-layout', () => ({
  useDeviceLayout: () => ({ isTablet: config.isTablet, widthClass: config.widthClass }),
}));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ variant: config.variant }) }));
vi.mock('../../../hooks/use-bottom-accessory', () => ({ useNativeTabBar: () => config.nativeBar }));
import {
  StoryTabRootContext,
  useStoryBottomInset,
  useStoryFixedFooterBottom,
  useStoryTabBarOverlay,
  useStorySessionFooterBottom,
} from '../use-story-bottom-inset';
function useMetrics() {
  return { scroll: useStoryBottomInset(), footer: useStoryFixedFooterBottom(), overlay: useStoryTabBarOverlay() };
}
beforeEach(() =>
  Object.assign(config, {
    platform: 'android',
    isTablet: false,
    widthClass: 'compact',
    nativeBar: false,
    bottom: 24,
    variant: 'material',
  }),
);
describe('isolated tab content clearances', () => {
  it('clears the real Android phone overlay for lists and fixed controls', () => {
    expect(renderHook(useMetrics).result.current).toEqual({ scroll: 88, footer: 88, overlay: true });
  });
  it('keeps pushed screens above the in-flow bar without double-insetting fixed controls', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StoryTabRootContext value={false}>{children}</StoryTabRootContext>
    );
    expect(renderHook(useMetrics, { wrapper }).result.current).toEqual({ scroll: 88, footer: 0, overlay: false });
  });
  it('keeps a compact tablet bar in flow', () => {
    config.isTablet = true;
    expect(renderHook(useMetrics).result.current).toEqual({ scroll: 88, footer: 0, overlay: false });
  });
  it('reserves no bottom bar for the regular tablet rail', () => {
    config.isTablet = true;
    config.widthClass = 'regular';
    expect(renderHook(useMetrics).result.current).toEqual({ scroll: 24, footer: 24, overlay: false });
  });
  it('keeps the glass session footer above its safe area on an in-flow fallback', () => {
    config.platform = 'web';
    config.variant = 'liquidGlass';
    expect(renderHook(useStorySessionFooterBottom).result.current).toBe(24);
  });
  it('uses the native measured inset once, including its system tab bar', () => {
    config.platform = 'ios';
    config.nativeBar = true;
    config.bottom = 83;
    expect(renderHook(useMetrics).result.current).toEqual({ scroll: 83, footer: 83, overlay: false });
  });
});

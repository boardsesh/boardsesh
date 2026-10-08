// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// How New climb is presented. A focused, full-height modal task (HIG
// "Modality"; M3 full-screen dialog on Android), never a drawer over the list
// and never fullScreenModal (docs/mobile-sheets-vs-routes.md, rule 2). Swipe to
// dismiss stays off because painting and pinching the board are drags (rule 3).

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
const screens = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.OS;
    },
  },
}));
vi.mock('expo-router', () => {
  const Stack = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  Stack.Screen = ({ name, options }: { name: string; options?: Record<string, unknown> }) => {
    screens.set(name, options ?? {});
    return null;
  };
  return { Stack };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../src/hooks/use-stack-screen-options', () => ({ useStackScreenOptions: () => ({}) }));
vi.mock('../../../../src/hooks/use-pop-to-top-on-tab-blur', () => ({ usePopToTopOnTabBlur: () => undefined }));
vi.mock('../../../../src/components/navigation/NativeTabContentInsetProbe', () => ({
  NativeTabContentInsetProbe: () => null,
}));
vi.mock('../../../../src/providers/board-art-visibility-provider', () => ({
  BoardArtVisibilityProvider: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#221A33' } }),
}));

import ClimbsLayout from '../_layout';

function createOptions() {
  render(createElement(ClimbsLayout));
  const options = screens.get('create');
  expect(options, 'the create screen is declared').toBeTruthy();
  return options ?? {};
}

beforeEach(() => {
  screens.clear();
  platform.OS = 'ios';
});
afterEach(cleanup);

describe('the New climb route', () => {
  it('is a headerless modal sheet on iOS, with swipe-down off so the board keeps its drags', () => {
    const options = createOptions();
    expect(options.presentation).toBe('modal');
    expect(options.gestureEnabled).toBe(false);
    expect(options.headerShown).toBe(false);
    // A pageSheet always slides up on iOS. No `animation` key at all, so
    // nothing overrides the platform's own.
    expect(options).not.toHaveProperty('animation');
  });

  it('is opaque, since nothing behind it shows through any more', () => {
    expect(createOptions().contentStyle).toEqual({ backgroundColor: '#221A33' });
  });

  it('slides up from the bottom on Android, as an M3 full-screen dialog', () => {
    platform.OS = 'android';
    const options = createOptions();
    expect(options.presentation).toBe('modal');
    expect(options.animation).toBe('slide_from_bottom');
  });

  it('is never a drawer over the list, nor a full-screen cover over the tab bar', () => {
    const { presentation } = createOptions();
    expect(presentation).not.toBe('transparentModal');
    expect(presentation).not.toBe('fullScreenModal');
  });
});

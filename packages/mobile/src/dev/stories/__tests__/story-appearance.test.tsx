// @vitest-environment jsdom
import {
  createContext,
  createRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThemeOverride, UiVariantPreference } from '@boardsesh/key-value-storage';

type Appearance = { themeOverride: ThemeOverride; uiVariantPreference: UiVariantPreference };
type StoryFocus = { id: string; focused: boolean };
type AppearanceWrite = StoryFocus & ({ theme: ThemeOverride } | { variant: UiVariantPreference });
type AppearanceControls = { setPreferences: (preferences: Appearance) => void };
type SharedAppearance = Appearance & {
  setThemeOverride: (source: StoryFocus, next: ThemeOverride) => Promise<void>;
  setUiVariant: (source: StoryFocus, next: UiVariantPreference) => Promise<void>;
};

const AppearanceContext = createContext<SharedAppearance | null>(null);
const FocusContext = createContext<StoryFocus>({ id: '', focused: false });
const writes: AppearanceWrite[] = [];
const DARK_MATERIAL: Appearance = { themeOverride: 'dark', uiVariantPreference: 'material' };
const LIGHT_GLASS: Appearance = { themeOverride: 'light', uiVariantPreference: 'liquidGlass' };

// Model the router's focus contract: dependency changes run the callback only
// while focused, blur runs its cleanup, and refocus runs the latest callback.
// The installed expo-router/build/useFocusEffect.js follows this contract.
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    const { focused } = useContext(FocusContext);
    useEffect(() => (focused ? effect() : undefined), [effect, focused]);
  },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => {
    const shared = useContext(AppearanceContext);
    const source = useContext(FocusContext);
    if (!shared) throw new Error('Missing test appearance provider');
    const { themeOverride, uiVariantPreference, setThemeOverride, setUiVariant } = shared;
    return {
      themeOverride,
      uiVariantPreference,
      setThemeOverride: useCallback(
        (next: ThemeOverride) => setThemeOverride(source, next),
        [setThemeOverride, source],
      ),
      setUiVariant: useCallback((next: UiVariantPreference) => setUiVariant(source, next), [setUiVariant, source]),
    };
  },
}));

import { useStoryAppearance } from '../use-story-appearance';

function recordWrite(write: AppearanceWrite): void {
  writes.push(write);
  // Reintroducing the ordinary effects makes the opposing mounted stories
  // fight forever. Bound that regression so a failing test cannot hang Vitest.
  if (writes.length > 12) throw new Error('Story appearance did not settle after 12 preference writes');
}

function AppearanceProvider({
  children,
  initial = DARK_MATERIAL,
  controls,
}: {
  children: ReactNode;
  initial?: Appearance;
  controls?: Ref<AppearanceControls>;
}) {
  const [preferences, setPreferences] = useState(initial);
  useImperativeHandle(controls, () => ({ setPreferences }), [setPreferences]);
  const setThemeOverride = useCallback((source: StoryFocus, next: ThemeOverride) => {
    recordWrite({ ...source, theme: next });
    setPreferences((previous) => (previous.themeOverride === next ? previous : { ...previous, themeOverride: next }));
    return Promise.resolve();
  }, []);
  const setUiVariant = useCallback((source: StoryFocus, next: UiVariantPreference) => {
    recordWrite({ ...source, variant: next });
    setPreferences((previous) =>
      previous.uiVariantPreference === next ? previous : { ...previous, uiVariantPreference: next },
    );
    return Promise.resolve();
  }, []);
  const shared = useMemo(
    () => ({ ...preferences, setThemeOverride, setUiVariant }),
    [preferences, setThemeOverride, setUiVariant],
  );
  return (
    <AppearanceContext.Provider value={shared}>
      {children}
      <output data-testid="appearance">
        {preferences.themeOverride}/{preferences.uiVariantPreference}
      </output>
    </AppearanceContext.Provider>
  );
}

function AppearanceRequest({ theme, variant }: { theme?: string; variant?: string }) {
  useStoryAppearance(theme, variant);
  return null;
}

function Story({ id, focused, theme, variant }: StoryFocus & { theme?: string; variant?: string }) {
  const focus = useMemo(() => ({ id, focused }), [id, focused]);
  return (
    <FocusContext.Provider value={focus}>
      <AppearanceRequest theme={theme} variant={variant} />
    </FocusContext.Provider>
  );
}

beforeEach(() => {
  writes.length = 0;
});
afterEach(cleanup);

describe('useStoryAppearance', () => {
  it('settles on the focused story while opposing stories remain mounted', () => {
    const stories = (focused: string) => (
      <AppearanceProvider>
        <Story id="light" focused={focused === 'light'} theme="light" variant="liquidGlass" />
        <Story id="dark" focused={focused === 'dark'} theme="dark" variant="material" />
      </AppearanceProvider>
    );
    const { getByTestId, rerender } = render(stories('light'));
    expect(getByTestId('appearance').textContent).toBe('light/liquidGlass');
    expect(writes).toEqual([
      { id: 'light', focused: true, theme: 'light' },
      { id: 'light', focused: true, variant: 'liquidGlass' },
    ]);

    rerender(stories('dark'));
    expect(getByTestId('appearance').textContent).toBe('dark/material');
    expect(writes.slice(2)).toEqual([
      { id: 'dark', focused: true, theme: 'dark' },
      { id: 'dark', focused: true, variant: 'material' },
    ]);

    rerender(stories('light'));
    expect(getByTestId('appearance').textContent).toBe('light/liquidGlass');
    expect(writes.slice(4)).toEqual([
      { id: 'light', focused: true, theme: 'light' },
      { id: 'light', focused: true, variant: 'liquidGlass' },
    ]);
    rerender(stories('light'));
    expect(writes).toHaveLength(6);
  });

  it('responds to focused parameter changes and shared preference changes', () => {
    const controls = createRef<AppearanceControls>();
    const story = (theme: string, variant: string) => (
      <AppearanceProvider initial={LIGHT_GLASS} controls={controls}>
        <Story id="current" focused theme={theme} variant={variant} />
      </AppearanceProvider>
    );
    const { getByTestId, rerender } = render(story('light', 'liquidGlass'));
    expect(writes).toHaveLength(0);

    rerender(story('dark', 'material'));
    expect(getByTestId('appearance').textContent).toBe('dark/material');
    expect(writes).toHaveLength(2);

    act(() => controls.current?.setPreferences(LIGHT_GLASS));
    expect(getByTestId('appearance').textContent).toBe('dark/material');
    expect(writes.slice(2)).toEqual([
      { id: 'current', focused: true, theme: 'dark' },
      { id: 'current', focused: true, variant: 'material' },
    ]);
  });

  it('makes no writes on blur or while blurred, and applies the latest params on refocus', () => {
    const controls = createRef<AppearanceControls>();
    const story = (focused: boolean, theme = 'light', variant = 'liquidGlass') => (
      <AppearanceProvider controls={controls}>
        <Story id="story" focused={focused} theme={theme} variant={variant} />
      </AppearanceProvider>
    );
    const { getByTestId, rerender } = render(story(true));
    expect(writes).toHaveLength(2);
    rerender(story(false));
    expect(getByTestId('appearance').textContent).toBe('light/liquidGlass');
    expect(writes).toHaveLength(2);

    act(() => controls.current?.setPreferences({ themeOverride: 'dark', uiVariantPreference: 'auto' }));
    rerender(story(false, 'system', 'auto'));
    expect(getByTestId('appearance').textContent).toBe('dark/auto');
    expect(writes).toHaveLength(2);

    rerender(story(true, 'system', 'auto'));
    expect(getByTestId('appearance').textContent).toBe('system/auto');
    expect(writes.slice(2)).toEqual([{ id: 'story', focused: true, theme: 'system' }]);
  });

  it.each([
    { theme: undefined, variant: undefined },
    { theme: 'sepia', variant: 'retro' },
    { theme: 'light', variant: 'liquidGlass' },
  ])('leaves absent, invalid or matching preferences alone: %o', ({ theme, variant }) => {
    const { getByTestId } = render(
      <AppearanceProvider initial={LIGHT_GLASS}>
        <Story id="story" focused theme={theme} variant={variant} />
      </AppearanceProvider>,
    );
    expect(getByTestId('appearance').textContent).toBe('light/liquidGlass');
    expect(writes).toHaveLength(0);
  });
});

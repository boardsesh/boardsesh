// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState, type ReactNode, type ContextType } from 'react';
import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext';
import { NavigationHelpersContext } from 'expo-router/build/react-navigation/core/NavigationHelpersContext';
import { NavigationRouteContext } from 'expo-router/build/react-navigation/core/NavigationProvider';
import { PreventRemoveProvider } from 'expo-router/build/react-navigation/core/PreventRemoveProvider';
import { usePreventRemoveContext } from 'expo-router/build/react-navigation/core/usePreventRemoveContext';

const mocks = vi.hoisted(() => ({ alert: vi.fn(), dispatch: vi.fn() }));
vi.mock('react-native', () => ({ Alert: { alert: mocks.alert } }));
// Load the shipped hook and provider, avoiding unrelated native barrel exports.
vi.mock('expo-router/react-navigation', async () => import('expo-router/build/react-navigation/core/usePreventRemove'));
vi.mock('expo-router', async () => import('expo-router/build/react-navigation/core/useNavigation'));
import { useSprayLeaveGuard } from '../use-spray-leave-guard';

type RemoveEvent = { preventDefault: () => void; data: { action: { type: string } } };
let removeListener: ((event: RemoveEvent) => void) | undefined;
let parentProtected = false;
let childProtected = false;
const childNavigation = {
  getState: () => ({ routes: [{ key: 'wizard', name: 'spray/new' }] }),
  addListener: (_event: string, listener: (event: RemoveEvent) => void) => {
    removeListener = listener;
    return () => {
      removeListener = undefined;
    };
  },
  dispatch: mocks.dispatch,
};
const parentNavigation = { getState: () => ({ routes: [{ key: 'boards', name: 'boards' }] }) };
function ProtectionObserver({ parent }: { parent: boolean }) {
  const { preventedRoutes } = usePreventRemoveContext();
  if (parent) parentProtected = preventedRoutes.boards?.preventRemove ?? false;
  else childProtected = preventedRoutes.wizard?.preventRemove ?? false;
  return null;
}
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <NavigationHelpersContext.Provider
      value={parentNavigation as unknown as ContextType<typeof NavigationHelpersContext>}
    >
      <PreventRemoveProvider>
        <ProtectionObserver parent />
        <NavigationRouteContext.Provider value={{ key: 'boards', name: 'boards' }}>
          <NavigationHelpersContext.Provider
            value={childNavigation as unknown as ContextType<typeof NavigationHelpersContext>}
          >
            <PreventRemoveProvider>
              <ProtectionObserver parent={false} />
              <NavigationContext.Provider value={childNavigation as unknown as ContextType<typeof NavigationContext>}>
                <NavigationRouteContext.Provider value={{ key: 'wizard', name: 'spray/new' }}>
                  {children}
                </NavigationRouteContext.Provider>
              </NavigationContext.Provider>
            </PreventRemoveProvider>
          </NavigationHelpersContext.Provider>
        </NavigationRouteContext.Provider>
      </PreventRemoveProvider>
    </NavigationHelpersContext.Provider>
  );
}
const mobileRoot = existsSync(resolve(process.cwd(), 'packages/mobile/app'))
  ? resolve(process.cwd(), 'packages/mobile')
  : process.cwd();
const strings = { title: 'Leave?', body: 'Unsaved holds', stay: 'Keep going', leave: 'Leave' };
function remove() {
  const event = { preventDefault: vi.fn(), data: { action: { type: 'POP' } } };
  act(() => removeListener?.(event));
  return event;
}
function alertButton(index: number): { onPress: () => void } {
  return mocks.alert.mock.calls.at(-1)?.[2][index];
}
beforeEach(() => {
  vi.clearAllMocks();
  parentProtected = false;
  childProtected = false;
});
afterEach(cleanup);

describe('spray native leave guard', () => {
  it('registers native prevention on the flow and containing modal, preserving edits on cancel', () => {
    const { result } = renderHook(
      () => {
        const [holds] = useState(['added-hold']);
        useSprayLeaveGuard(true, strings);
        return holds;
      },
      { wrapper: Wrapper },
    );
    expect(childProtected).toBe(true);
    expect(parentProtected).toBe(true);
    expect(remove().preventDefault).toHaveBeenCalledOnce();
    act(() => alertButton(0).onPress());
    expect(result.current).toEqual(['added-hold']);
    expect(childProtected).toBe(true);
    expect(parentProtected).toBe(true);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('asks once across repeated exits and redispatches only the confirmed action', () => {
    renderHook(() => useSprayLeaveGuard(true, strings), { wrapper: Wrapper });
    const first = remove();
    remove();
    expect(mocks.alert).toHaveBeenCalledOnce();
    act(() => alertButton(1).onPress());
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(first.data.action);
  });

  it('releases child and parent protection after publish or commit completes', () => {
    const { rerender } = renderHook(({ unfinished }) => useSprayLeaveGuard(unfinished, strings), {
      wrapper: Wrapper,
      initialProps: { unfinished: true },
    });
    rerender({ unfinished: false });
    expect(childProtected).toBe(false);
    expect(parentProtected).toBe(false);
    expect(remove().preventDefault).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it('both routes use native protection and footer exits have no separate confirmation', () => {
    for (const filename of ['SprayWallWizardScreen.tsx', 'SprayWallResetScreen.tsx']) {
      const screen = readFileSync(resolve(mobileRoot, 'src/components/spray-wall', filename), 'utf8');
      expect(screen).toContain('useSprayLeaveGuard(shouldConfirmLeave(state),');
      expect(screen).not.toContain("'beforeRemove'");
      const footerBack = screen.slice(screen.indexOf('  const goBack ='), screen.indexOf('  }, [state, router]);'));
      expect(footerBack).toContain('router.back()');
      expect(footerBack).not.toMatch(/confirmLeave|Alert.alert/);
    }
    const layout = readFileSync(resolve(mobileRoot, 'app/boards/_layout.tsx'), 'utf8');
    expect(layout.match(/headerBackButtonMenuEnabled: false/g)).toHaveLength(2);
  });
});

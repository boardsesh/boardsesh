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
import { useSprayWizardLeaveGuard } from '../use-spray-wizard-leave-guard';

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
function remove() {
  const event = { preventDefault: vi.fn(), data: { action: { type: 'POP' } } };
  act(() => removeListener?.(event));
  return event;
}
beforeEach(() => {
  vi.clearAllMocks();
  parentProtected = false;
  childProtected = false;
});
afterEach(cleanup);

describe('native wizard exit protection', () => {
  it('holds the screen and containing modal while the existing confirmation decides', () => {
    const confirmLeave = vi.fn<(continueLeaving: () => void) => void>();
    const { result } = renderHook(
      () => {
        const [holds] = useState(['added-hold']);
        useSprayWizardLeaveGuard(confirmLeave);
        return holds;
      },
      { wrapper: Wrapper },
    );
    expect(childProtected).toBe(true);
    expect(parentProtected).toBe(true);
    const event = remove();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(confirmLeave).toHaveBeenCalledOnce();
    // Cancel or a busy/hand-over decision never calls the continuation.
    expect(result.current).toEqual(['added-hold']);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    act(() => confirmLeave.mock.calls[0][0]());
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(event.data.action);
  });

  it('permits a completed flow to redispatch the original removal without a prompt', () => {
    renderHook(() => useSprayWizardLeaveGuard((continueLeaving) => continueLeaving()), { wrapper: Wrapper });
    const event = remove();
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(event.data.action);
  });

  it('keeps the train decision and stale-answer checks wired and footer exits use one guard', () => {
    const screen = readFileSync(resolve(mobileRoot, 'src/components/spray-wall/SprayWallWizardScreen.tsx'), 'utf8');
    expect(screen.includes('useSprayWizardLeaveGuard(confirmLeave)')).toBe(true);
    expect(screen.includes('leaveDecision(state, readEditorLeaveState())')).toBe(true);
    expect(screen.includes('leaveStillApplies(askedAt, stateRef.current, readEditorLeaveState())')).toBe(true);
    expect(screen.includes("'beforeRemove'")).toBe(false);
    const footer = screen.slice(screen.indexOf('  const goBack ='), screen.indexOf('  }, [state, router]);'));
    expect(footer.includes('router.back()')).toBe(true);
    expect(footer.includes('confirmLeave')).toBe(false);
    const layout = readFileSync(resolve(mobileRoot, 'app/boards/_layout.tsx'), 'utf8');
    expect(layout.includes('headerBackButtonMenuEnabled: false')).toBe(true);
  });
  it('keeps editor controls below the measured header and photo actions ahead of the preview', () => {
    const editor = readFileSync(resolve(mobileRoot, 'src/components/outline-editor/SprayHoldEditorScreen.tsx'), 'utf8');
    expect(editor.includes('const headerInset = useTransparentHeaderInset()')).toBe(true);
    expect(/backgroundColor:\s*systemColors.background,\s*marginTop:\s*headerInset/.test(editor)).toBe(true);
    const wizard = readFileSync(resolve(mobileRoot, 'src/components/spray-wall/SprayWallWizardScreen.tsx'), 'utf8');
    const photo = wizard.slice(
      wizard.indexOf("{state.step === 'photo' ?"),
      wizard.indexOf("{state.step === 'upload' ?"),
    );
    expect(photo.indexOf('styles.photoActions')).toBeGreaterThan(0);
    expect(photo.indexOf('styles.photoActions')).toBeLessThan(photo.indexOf('styles.previewWrap'));
    const layout = readFileSync(resolve(mobileRoot, 'app/boards/_layout.tsx'), 'utf8');
    expect(/SprayWizardExitButton\s+returnTo=\{resolveBoardReturnTo\(/.test(layout)).toBe(true);
  });
});

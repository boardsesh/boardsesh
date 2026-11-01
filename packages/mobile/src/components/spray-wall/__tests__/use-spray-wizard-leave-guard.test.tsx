// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { use, useMemo, useState, type ReactNode, type ContextType } from 'react';
import { act, renderHook, cleanup, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext';
import { NavigationRouteContext } from 'expo-router/build/react-navigation/core/NavigationProvider';
import {
  RemovalPreventionProvider,
  PreventRemovalProvider,
  useRoutesWithRemovalPrevented,
} from 'expo-router/build/global-state/removalPrevention';

import {
  StackRouter,
  type NavigationAction,
  type NavigationState,
} from 'expo-router/build/react-navigation/routers/index';
import { usePreventRemove } from 'expo-router/build/react-navigation/core/usePreventRemove';
import { RoutingQueueProvider, RoutingQueueApiContext } from 'expo-router/build/global-state/routingQueueContext';
import { RoutingQueueDrainer } from 'expo-router/build/global-state/RoutingQueueDrainer';
import { useNavigationTreeReducer } from 'expo-router/build/global-state/useNavigationTreeReducer';
import { useNavigationTreeReportEvents } from 'expo-router/build/global-state/useNavigationTreeReportEvents';

// Expo's CJS reducer reads native configuration through require(), outside vi.mock.
// Supply only that native boundary; queue, reducers, hooks and providers stay real.
const restoreNativeConfig = await vi.hoisted(async () => {
  const { createRequire, Module } = await import('node:module');
  const require = createRequire(import.meta.url);
  const configPath = require.resolve('expo-constants');
  const previous = require.cache[configPath];
  const nativeConfig = new Module(configPath);
  nativeConfig.exports = { expoConfig: { extra: { router: { adaptiveColors: false } } } };
  require.cache[configPath] = nativeConfig;
  return () => {
    if (previous) require.cache[configPath] = previous;
    else delete require.cache[configPath];
  };
});
afterAll(restoreNativeConfig);

const mocks = vi.hoisted(() => ({ alert: vi.fn(), dispatch: vi.fn() }));
vi.mock('react-native', () => ({ Alert: { alert: mocks.alert }, Platform: { OS: 'ios' } }));
// Load the shipped hook and provider, avoiding unrelated native barrel exports.
vi.mock('expo-router', async () => ({
  ...(await import('expo-router/build/react-navigation/core/usePreventRemove')),
  ...(await import('expo-router/build/react-navigation/core/useNavigation')),
  unstable_useIsNavigating: (await import('expo-router/build/global-state/useIsNavigating')).useIsNavigating,
}));
import { useSprayWizardLeaveGuard } from '../use-spray-wizard-leave-guard';

type RemoveEvent = { data: { action: { type: string } } };
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
function ProtectionObserver() {
  const preventedRoutes = useRoutesWithRemovalPrevented();
  parentProtected = preventedRoutes.has('boards');
  childProtected = preventedRoutes.has('wizard');
  return null;
}
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <RemovalPreventionProvider>
      <ProtectionObserver />
      <PreventRemovalProvider routeKey="boards">
        <PreventRemovalProvider routeKey="wizard">
          <NavigationContext.Provider value={childNavigation as unknown as ContextType<typeof NavigationContext>}>
            <NavigationRouteContext.Provider value={{ key: 'wizard', name: 'spray/new' }}>
              {children}
            </NavigationRouteContext.Provider>
          </NavigationContext.Provider>
        </PreventRemovalProvider>
      </PreventRemovalProvider>
    </RemovalPreventionProvider>
  );
}
const mobileRoot = existsSync(resolve(process.cwd(), 'packages/mobile/app'))
  ? resolve(process.cwd(), 'packages/mobile')
  : process.cwd();
function remove() {
  const event = { data: { action: { type: 'POP' } } };
  act(() => removeListener?.(event));
  return event;
}
beforeEach(() => {
  vi.clearAllMocks();
  parentProtected = false;
  childProtected = false;
});
afterEach(cleanup);

const navigationAction = { type: 'GO_BACK', target: 'root' };
const stackRouter = StackRouter({});
const registry = new Map([
  [
    'root',
    {
      reduce: (state: NavigationState, action: NavigationAction) =>
        stackRouter.getStateForAction(
          state as Parameters<typeof stackRouter.getStateForAction>[0],
          action as Parameters<typeof stackRouter.getStateForAction>[1],
          { routeNames: ['home', 'boards'], routeGetIdList: {} },
        ),
    },
  ],
]);
const initialState: NavigationState = {
  key: 'root',
  routeKeySeq: 2,
  index: 1,
  routeNames: ['home', 'boards'],
  stale: false,
  type: 'stack',
  routes: [
    { key: 'home', name: 'home' },
    {
      key: 'boards',
      name: 'boards',
      state: {
        key: 'inner',
        routeKeySeq: 1,
        index: 0,
        routeNames: ['spray/new'],
        stale: false,
        type: 'stack',
        routes: [{ key: 'wizard', name: 'spray/new' }],
      },
    },
  ],
};
let requestQueuedRemoval = () => {};
let wizardMounted = false;
const parentBlocked = vi.fn();
function QueuedNavigation({ children, blockParent }: { children: ReactNode; blockParent: boolean }) {
  const queue = use(RoutingQueueApiContext)!;
  const preventedRoutes = useRoutesWithRemovalPrevented();
  const tree = useNavigationTreeReducer({ initialState, registry, routesWithRemovalPrevented: preventedRoutes });
  const navigation = useMemo(() => {
    const listeners = new Map<string, Set<(event: RemoveEvent) => void>>();
    const dispatch = (action: NavigationAction) =>
      queue.enqueue({ type: 'ACTION', payload: { action, originKey: 'root' } });
    const forRoute = (routeKey: string) => ({
      getState: () => initialState,
      dispatch,
      addListener: (type: string, listener: (event: RemoveEvent) => void) => {
        const eventKey = `${routeKey}:${type}`;
        const subscribers = listeners.get(eventKey) ?? new Set();
        subscribers.add(listener);
        listeners.set(eventKey, subscribers);
        return () => {
          subscribers.delete(listener);
        };
      },
    });
    return {
      dispatch,
      parent: forRoute('boards'),
      child: forRoute('wizard'),
      emit: (routeKey: string, type: string, action: NavigationAction) => {
        for (const listener of listeners.get(`${routeKey}:${type}`) ?? []) listener({ data: { action } });
      },
    };
  }, [queue]);
  requestQueuedRemoval = () => navigation.dispatch(navigationAction);
  wizardMounted = tree.state.routes.some((route) => route.key === 'boards');
  useNavigationTreeReportEvents(tree.report, tree.consumeReportEvents, { apply: () => {}, listen: () => () => {} });
  return (
    <>
      <RoutingQueueDrainer processIntent={tree.processIntent} />
      {wizardMounted ? (
        <PreventRemovalProvider routeKey="boards" emitRemovalEvent={navigation.emit}>
          <NavigationContext.Provider value={navigation.parent as unknown as ContextType<typeof NavigationContext>}>
            <NavigationRouteContext.Provider value={{ key: 'boards', name: 'boards' }}>
              <ParentBlocker enabled={blockParent} />
              <PreventRemovalProvider routeKey="wizard" emitRemovalEvent={navigation.emit}>
                <NavigationContext.Provider
                  value={navigation.child as unknown as ContextType<typeof NavigationContext>}
                >
                  <NavigationRouteContext.Provider value={{ key: 'wizard', name: 'spray/new' }}>
                    {children}
                  </NavigationRouteContext.Provider>
                </NavigationContext.Provider>
              </PreventRemovalProvider>
            </NavigationRouteContext.Provider>
          </NavigationContext.Provider>
        </PreventRemovalProvider>
      ) : null}
    </>
  );
}
function ParentBlocker({ enabled }: { enabled: boolean }) {
  usePreventRemove(enabled, parentBlocked);
  return null;
}
function QueueWrapper({ children, blockParent = false }: { children: ReactNode; blockParent?: boolean }) {
  return (
    <RoutingQueueProvider>
      <RemovalPreventionProvider>
        <ProtectionObserver />
        <QueuedNavigation blockParent={blockParent}>{children}</QueuedNavigation>
      </RemovalPreventionProvider>
    </RoutingQueueProvider>
  );
}

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
    expect(confirmLeave).toHaveBeenCalledOnce();
    // Cancel or a busy/hand-over decision never calls the continuation.
    expect(result.current).toEqual(['added-hold']);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    act(() => confirmLeave.mock.calls[0][0]());
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(event.data.action);
    expect(childProtected).toBe(true);
    expect(parentProtected).toBe(true);
  });

  it('rearms after another guard blocks the queued repeat, without prompting twice', async () => {
    const confirmLeave = vi.fn<(continueLeaving: () => void) => void>();
    renderHook(() => useSprayWizardLeaveGuard(confirmLeave), {
      wrapper: ({ children }) => <QueueWrapper blockParent>{children}</QueueWrapper>,
    });
    act(requestQueuedRemoval);
    await waitFor(() => expect(confirmLeave).toHaveBeenCalledOnce());
    act(() => confirmLeave.mock.calls[0][0]());
    await waitFor(() => expect(parentBlocked).toHaveBeenCalledTimes(2));
    expect(wizardMounted).toBe(true);
    expect(childProtected).toBe(true);
    expect(confirmLeave).toHaveBeenCalledOnce();
    act(requestQueuedRemoval);
    await waitFor(() => expect(confirmLeave).toHaveBeenCalledTimes(2));
  });

  it('removes the screen after confirmation when the queued repeat is unblocked', async () => {
    const confirmLeave = vi.fn<(continueLeaving: () => void) => void>();
    renderHook(() => useSprayWizardLeaveGuard(confirmLeave), { wrapper: QueueWrapper });
    act(requestQueuedRemoval);
    await waitFor(() => expect(confirmLeave).toHaveBeenCalledOnce());
    act(() => confirmLeave.mock.calls[0][0]());
    await waitFor(() => expect(wizardMounted).toBe(false));
    expect(childProtected).toBe(false);
    expect(parentProtected).toBe(false);
    expect(confirmLeave).toHaveBeenCalledOnce();
  });

  it('keeps the train decision and stale-answer checks wired and footer exits use one guard', () => {
    const screen = readFileSync(resolve(mobileRoot, 'src/components/spray-wall/SprayWallWizardScreen.tsx'), 'utf8');
    expect(screen.includes('useSprayWizardLeaveGuard(confirmLeave)')).toBe(true);
    // The guard is also told about a training switch flip still on the wire.
    expect(screen.includes('leaveDecision(state, readEditorLeaveState(), consentSavingNow())')).toBe(true);
    expect(screen.includes('leaveStillApplies(askedAt, stateRef.current, readEditorLeaveState())')).toBe(true);
    expect(screen.includes("'beforeRemove'")).toBe(false);
    const footer = screen.slice(screen.indexOf('  const goBack ='), screen.indexOf('  }, [state, router]);'));
    expect(footer.includes('router.back()')).toBe(true);
    expect(footer.includes('confirmLeave')).toBe(false);
    const layout = readFileSync(resolve(mobileRoot, 'app/boards/_layout.tsx'), 'utf8');
    expect(layout.includes('headerBackButtonMenuEnabled: false')).toBe(true);
  });
  it('keeps editor controls below the measured header and photo actions on screen under the photo', () => {
    const editor = readFileSync(resolve(mobileRoot, 'src/components/outline-editor/SprayHoldEditorScreen.tsx'), 'utf8');
    expect(editor.includes('const headerInset = useTransparentHeaderInset()')).toBe(true);
    expect(/backgroundColor:\s*systemColors.background,\s*marginTop:\s*headerInset/.test(editor)).toBe(true);
    const wizard = readFileSync(resolve(mobileRoot, 'src/components/spray-wall/SprayWallWizardScreen.tsx'), 'utf8');
    const photo = wizard.slice(
      wizard.indexOf("{state.step === 'photo' ?"),
      wizard.indexOf("{state.step === 'upload' ?"),
    );
    // The actions sit under the photo, which is capped at 55% of the window's
    // height so a portrait photo cannot push them below the fold.
    expect(photo.indexOf('styles.photoActions')).toBeGreaterThan(photo.indexOf('spray-photo-tile'));
    expect(wizard.includes('const MAX_PREVIEW_HEIGHT_SHARE = 0.55;')).toBe(true);
    expect(wizard.includes('windowHeight * MAX_PREVIEW_HEIGHT_SHARE')).toBe(true);
    const layout = readFileSync(resolve(mobileRoot, 'app/boards/_layout.tsx'), 'utf8');
    expect(/SprayWizardExitButton\s+returnTo=\{resolveBoardReturnTo\(/.test(layout)).toBe(true);
  });
});

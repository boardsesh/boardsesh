// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compileFunction } from 'node:vm';
import * as React from 'react';
import * as compilerRuntime from 'react/compiler-runtime';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as consentModel from '@boardsesh/consent';
import * as consentState from '../consent-state';
import { normalizeScreenPath } from '../analytics-screen-path';
import { trackScreen as trackProductScreen } from '../analytics';
import { resetScreenSessionGate } from '../analytics-screen-session-gate';
import { grantedConsent } from '../../../test/consent-fixture';

const sdk = vi.hoisted(() => ({
  sessionId: 'session-a',
  screen: vi.fn(),
  registerForSession: vi.fn(),
}));
vi.mock('../posthog-client', () => ({
  getPostHogClient: () => ({
    screen: sdk.screen,
    registerForSession: sdk.registerForSession,
    getSessionId: () => sdk.sessionId,
  }),
  registerAppSuperProperties: vi.fn(),
  clearPosthogQueues: vi.fn(),
  applyPosthogConsent: async () => {},
}));

const require = createRequire(import.meta.url);
const { renderToString } = require('react-dom/server') as {
  renderToString: (element: React.ReactElement) => string;
};
const expoRequire = createRequire(require.resolve('@expo/cli/package.json'));
const babel = expoRequire('@babel/core') as {
  transformSync: (source: string, options: Record<string, unknown>) => { code?: string | null } | null;
};
let segments: string[] = ['(tabs)', 'home'];
const trackScreen = vi.fn(trackProductScreen);

// Vitest does not run Expo's production React Compiler. Execute the compiled
// source too: the old hook passed all uncompiled tests but cached its initial
// false result forever, dropping screens after consent/SDK initialization.
function compileProductionModule(filename: string, imports: Record<string, unknown>): Record<string, unknown> {
  const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
  const compiled = babel.transformSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    plugins: [
      [require('babel-plugin-react-compiler'), { target: '19' }],
      expoRequire('@babel/plugin-transform-typescript'),
      expoRequire('@babel/plugin-transform-modules-commonjs'),
    ],
  });
  if (!compiled?.code) throw new Error(`Compiler produced no code for ${filename}`);
  const compiledModule = { exports: {} as Record<string, unknown> };
  compileFunction(compiled.code, ['require', 'module', 'exports'])(
    (specifier: string) => {
      if (!(specifier in imports)) throw new Error(`Unexpected compiled import: ${specifier}`);
      return imports[specifier];
    },
    compiledModule,
    compiledModule.exports,
  );
  return compiledModule.exports;
}

const compiledHooks = compileProductionModule('../consent-hooks.ts', {
  react: React,
  'react/compiler-runtime': compilerRuntime,
  './consent-state': consentState,
  '@boardsesh/consent': consentModel,
});
const useCompiledAnalyticsConsent = compiledHooks.useAnalyticsConsent as () => boolean;
const { AnalyticsScreenTracker } = compileProductionModule('../../components/analytics/AnalyticsScreenTracker.tsx', {
  react: React,
  'react/compiler-runtime': compilerRuntime,
  'expo-router': { useSegments: () => segments },
  '../../lib/analytics': { trackScreen },
  '../../lib/analytics-screen-path': { normalizeScreenPath },
  '../../lib/consent-hooks': compiledHooks,
}) as { AnalyticsScreenTracker: () => null };

function grantReadyAnalytics(): void {
  consentState.updateConsentState({
    record: grantedConsent,
    loaded: true,
    settled: true,
    flagsResolved: true,
    authSettled: true,
    accountResolved: true,
    sdkReady: true,
  });
}

beforeEach(() => {
  segments = ['(tabs)', 'home'];
  trackScreen.mockClear();
  sdk.sessionId = 'session-a';
  sdk.screen.mockClear();
  sdk.registerForSession.mockClear();
  resetScreenSessionGate();
  consentState.setBrowserConsentReader(() => null);
  consentState.updateConsentState({
    record: null,
    loaded: false,
    settled: false,
    killed: false,
    authSettled: false,
    accountResolved: false,
    authEpoch: 0,
    accountId: null,
    sdkReady: false,
    flagsResolved: false,
    regionConfirmed: false,
  });
});

afterEach(() => {
  cleanup();
  consentState.setBrowserConsentReader(() => null);
  vi.unstubAllEnvs();
});

describe('production-compiled analytics consent', () => {
  it('captures the current screen after delayed consent and SDK readiness, then navigation', () => {
    const view = render(React.createElement(AnalyticsScreenTracker));
    expect(trackScreen).not.toHaveBeenCalled();

    act(() => {
      grantReadyAnalytics();
      consentState.updateConsentState({ sdkReady: false });
    });
    expect(trackScreen).not.toHaveBeenCalled();

    act(() => consentState.updateConsentState({ sdkReady: true }));
    expect(consentState.isProductAnalyticsGranted()).toBe(true);
    expect(trackScreen).toHaveBeenCalledExactlyOnceWith('/home');

    segments = ['(tabs)', 'climbs'];
    view.rerender(React.createElement(AnalyticsScreenTracker));
    expect(trackScreen.mock.calls).toEqual([['/home'], ['/climbs']]);
  });

  it('rechecks the current screen after withdrawal and Allow without navigating', () => {
    grantReadyAnalytics();
    render(React.createElement(AnalyticsScreenTracker));
    expect(trackScreen).toHaveBeenCalledExactlyOnceWith('/home');

    act(() => consentState.updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } }));
    expect(trackScreen).toHaveBeenCalledTimes(1);
    act(() => grantReadyAnalytics());
    expect(trackScreen.mock.calls).toEqual([['/home'], ['/home']]);
  });

  it('deduplicates same-route consent toggles within a session and emits again after rotation', () => {
    grantReadyAnalytics();
    render(React.createElement(AnalyticsScreenTracker));
    expect(sdk.screen).toHaveBeenCalledExactlyOnceWith('/home');

    act(() => consentState.updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } }));
    expect(sdk.screen).toHaveBeenCalledTimes(1);
    act(() => grantReadyAnalytics());
    expect(trackScreen).toHaveBeenCalledTimes(2);
    expect(sdk.screen).toHaveBeenCalledTimes(1);
    expect(sdk.registerForSession).toHaveBeenLastCalledWith({ $screen_name: '/home' });

    // React may coalesce a rapid toggle into one commit with eligibility true.
    act(() => {
      consentState.updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } });
      grantReadyAnalytics();
    });
    expect(sdk.screen).toHaveBeenCalledTimes(1);

    act(() => consentState.updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } }));
    sdk.sessionId = 'session-b';
    act(() => grantReadyAnalytics());
    expect(trackScreen).toHaveBeenCalledTimes(3);
    expect(sdk.screen.mock.calls).toEqual([['/home'], ['/home']]);
  });

  it('hydrates the server eligibility snapshot and then follows client SDK readiness', () => {
    function ConsentProbe() {
      return React.createElement('output', null, useCompiledAnalyticsConsent() ? 'granted' : 'blocked');
    }

    const container = document.createElement('div');
    const onRecoverableError = vi.fn();
    const serverMarkup = renderToString(React.createElement(ConsentProbe));
    expect(serverMarkup).toBe('<output>blocked</output>');
    container.innerHTML = serverMarkup;
    document.body.appendChild(container);
    const view = render(React.createElement(ConsentProbe), { container, hydrate: true, onRecoverableError });
    expect(view.container.textContent).toBe('blocked');
    expect(onRecoverableError).not.toHaveBeenCalled();

    act(() => grantReadyAnalytics());
    expect(view.container.textContent).toBe('granted');
    expect(renderToString(React.createElement(ConsentProbe))).toBe('<output>granted</output>');

    act(() => consentState.updateConsentState({ sdkReady: false }));
    expect(view.container.textContent).toBe('blocked');
    expect(renderToString(React.createElement(ConsentProbe))).toBe('<output>blocked</output>');
  });

  it('waits for the replacement account before retrying the unchanged route', () => {
    grantReadyAnalytics();
    consentState.updateConsentState({ accountId: 'account-a', sdkReady: true });
    render(React.createElement(AnalyticsScreenTracker));
    expect(trackScreen).toHaveBeenCalledExactlyOnceWith('/home');
    act(() => consentState.invalidateConsentAccount());
    expect(trackScreen).toHaveBeenCalledTimes(1);
    act(() => consentState.updateConsentState({ accountId: 'account-b', authSettled: true }));
    expect(trackScreen).toHaveBeenCalledTimes(1);
    // The SDK resets its session when the resolved account changes.
    sdk.sessionId = 'session-b';
    act(() => consentState.updateConsentState({ accountResolved: true, sdkReady: true }));
    expect(trackScreen.mock.calls).toEqual([['/home'], ['/home']]);
    expect(sdk.screen.mock.calls).toEqual([['/home'], ['/home']]);
  });

  it('captures only the current route after navigating while analytics was denied', () => {
    grantReadyAnalytics();
    consentState.updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } });
    const view = render(React.createElement(AnalyticsScreenTracker));
    segments = ['(tabs)', 'climbs'];
    view.rerender(React.createElement(AnalyticsScreenTracker));
    segments = ['settings', 'privacy'];
    view.rerender(React.createElement(AnalyticsScreenTracker));
    expect(trackScreen).not.toHaveBeenCalled();
    act(() => grantReadyAnalytics());
    expect(trackScreen).toHaveBeenCalledExactlyOnceWith('/settings/privacy');
  });

  it.each([
    { record: null },
    { record: { ...grantedConsent, analytics: 'denied' as const } },
    { loaded: false },
    { settled: false },
    { flagsResolved: false },
    { authSettled: false },
    { accountResolved: false },
    { sdkReady: false },
    { killed: true },
  ])('stays blocked while a privacy/readiness gate is closed: %j', (blockedState) => {
    grantReadyAnalytics();
    const { result } = renderHook(useCompiledAnalyticsConsent);
    expect(result.current).toBe(true);
    act(() => consentState.updateConsentState(blockedState));
    expect(result.current).toBe(false);
  });

  it('waits for region confirmation again after a default is suspended', () => {
    grantReadyAnalytics();
    consentState.updateConsentState({ record: consentModel.createRegionDefaultConsent('ios') });
    render(React.createElement(AnalyticsScreenTracker));
    expect(trackScreen).not.toHaveBeenCalled();
    act(() => consentState.updateConsentState({ regionConfirmed: true }));
    expect(trackScreen).toHaveBeenCalledExactlyOnceWith('/home');
    act(() => consentState.updateConsentState({ regionConfirmed: false }));
    expect(trackScreen).toHaveBeenCalledTimes(1);
    act(() => consentState.updateConsentState({ regionConfirmed: true }));
    expect(trackScreen).toHaveBeenCalledTimes(2);
  });

  it('keeps screenshot mode out of analytics', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    grantReadyAnalytics();
    const { result } = renderHook(useCompiledAnalyticsConsent);
    expect(result.current).toBe(false);
  });

  it('observes external browser denial and waits for account resolution after an external grant', async () => {
    const storage = await import('../consent-storage.web');
    await storage.persistLocalConsent(grantedConsent);
    consentState.setBrowserConsentReader(storage.readConsentCookie);
    grantReadyAnalytics();
    consentState.updateConsentState({ accountId: 'account-a', sdkReady: true });
    const { result } = renderHook(useCompiledAnalyticsConsent);
    expect(result.current).toBe(true);

    act(() => {
      document.cookie = `boardsesh-consent=${consentModel.serializeConsentCookieValue({ ...grantedConsent, analytics: 'denied' })}; Path=/`;
      expect(consentState.isProductAnalyticsGranted()).toBe(false);
    });
    expect(result.current).toBe(false);

    act(() => {
      document.cookie = `boardsesh-consent=${consentModel.serializeConsentCookieValue(grantedConsent)}; Path=/`;
      expect(consentState.isProductAnalyticsGranted()).toBe(false);
    });
    expect(consentState.getConsentSnapshot().accountResolved).toBe(false);
    expect(result.current).toBe(false);
    act(() => consentState.updateConsentState({ accountResolved: true, sdkReady: true }));
    expect(result.current).toBe(true);
    await storage.persistLocalConsent(null);
  });
});

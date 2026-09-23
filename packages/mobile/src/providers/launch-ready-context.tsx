import { createContext, useContext, type ReactNode } from 'react';

/**
 * "The app has settled": auth has resolved and the required fonts have loaded,
 * so the splash is coming down. The launch gates (OnboardingGate,
 * ConnectivityBanner, QaTesterGate, SendRecoveryGate) wait on it before they
 * paint or push anything.
 *
 * **Why a context and not a prop (#5654).** `RootLayout` owns the two states,
 * but every gate is mounted inside `<DatabaseProvider>`, and expo-sqlite's
 * `SQLiteProvider` is `memo()`'d with a comparator that ignores `children`. A
 * `RootLayout` re-render therefore never reaches anything below it: each JSX
 * prop created there keeps its FIRST-render value. `ready={authReady &&
 * fontsReady}` was `false` on that render, so from 2.2.0 (July 2026) until this
 * fix all four gates sat frozen at "not ready" and never ran. A context value
 * changing still reaches its consumers past a memo boundary, so the provider
 * goes ABOVE `<DatabaseProvider>` and the gates read `useLaunchReady()`.
 *
 * The default is `false`: a gate rendered outside the provider never runs, and
 * the onboarding gate's stall watchdog reports that as `not_ready`.
 */
const LaunchReadyContext = createContext<boolean>(false);

export function LaunchReadyProvider({ ready, children }: { ready: boolean; children: ReactNode }) {
  return <LaunchReadyContext.Provider value={ready}>{children}</LaunchReadyContext.Provider>;
}

/** True once auth and fonts have both resolved. Never goes back to false. */
export function useLaunchReady(): boolean {
  return useContext(LaunchReadyContext);
}

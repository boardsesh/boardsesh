// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';

// The store is a module-level singleton that non-React code reads directly, so
// the bridge exists purely to push the flag into it (issue #4862).
const setOutageDetectionEnabled = vi.hoisted(() => vi.fn());
vi.mock('../../lib/connectivity/connectivity-store', () => ({
  setOutageDetectionEnabled: (enabled: boolean) => setOutageDetectionEnabled(enabled),
}));
const setInteractiveRequestDeadlineEnabled = vi.hoisted(() => vi.fn());
vi.mock('../../lib/graphql/request-timeout', () => ({
  setInteractiveRequestDeadlineEnabled: (enabled: boolean) => setInteractiveRequestDeadlineEnabled(enabled),
}));

const flagState = vi.hoisted(() => ({ detectionEnabled: true, deadlineEnabled: true }));
vi.mock('../../providers/feature-flags-provider', () => ({
  useBackendOutageDetectionEnabled: () => flagState.detectionEnabled,
  useInteractiveRequestDeadlineEnabled: () => flagState.deadlineEnabled,
}));

// Only the one field the bridge reads, through the same narrowed subscription
// it uses in the app. The store behind the real hook is the singleton this
// suite deliberately never touches.
const connectivity = vi.hoisted(() => ({ offlineMode: false }));
vi.mock('../../lib/connectivity/use-connectivity', () => ({
  selectOfflineMode: (snapshot: { offlineMode: boolean }) => snapshot.offlineMode,
  useConnectivityField: (select: (snapshot: { offlineMode: boolean }) => boolean) =>
    select({ offlineMode: connectivity.offlineMode }),
}));

const disposeWsClient = vi.hoisted(() => vi.fn());
vi.mock('../../lib/graphql/ws-client', () => ({
  disposeWsClient: () => disposeWsClient(),
}));

import { ConnectivityBridge } from '../connectivity-bridge';

describe('ConnectivityBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flagState.detectionEnabled = true;
    flagState.deadlineEnabled = true;
    connectivity.offlineMode = false;
  });

  it('publishes the interactive deadline switch independently of detection', () => {
    flagState.deadlineEnabled = false;

    render(createElement(ConnectivityBridge));

    expect(setInteractiveRequestDeadlineEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(setOutageDetectionEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('renders nothing and publishes the resolved flag to the store', () => {
    const { container } = render(createElement(ConnectivityBridge));

    expect(container.innerHTML).toBe('');
    expect(setOutageDetectionEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('publishes the kill switch when the flag resolves to false', () => {
    flagState.detectionEnabled = false;

    render(createElement(ConnectivityBridge));

    expect(setOutageDetectionEnabled).toHaveBeenCalledExactlyOnceWith(false);
  });

  // PostHog flags resolve asynchronously, so the effect runs at least twice on a
  // cold open: once with the default and again when the real value lands. A late
  // kill switch has to fully undo whatever the store concluded before it.
  it('republishes when the flag changes after resolving', () => {
    const { rerender } = render(createElement(ConnectivityBridge));
    expect(setOutageDetectionEnabled).toHaveBeenLastCalledWith(true);

    flagState.detectionEnabled = false;
    rerender(createElement(ConnectivityBridge));

    expect(setOutageDetectionEnabled).toHaveBeenCalledTimes(2);
    expect(setOutageDetectionEnabled).toHaveBeenLastCalledWith(false);
  });

  it('does not rewrite the store on a re-render that changed nothing', () => {
    const { rerender } = render(createElement(ConnectivityBridge));

    rerender(createElement(ConnectivityBridge));

    expect(setOutageDetectionEnabled).toHaveBeenCalledTimes(1);
  });

  // graphql-ws reconnects on its own schedule and knows nothing about the store,
  // so "stop every request" would leave exactly one kind of traffic running.
  it('closes the realtime socket when offline mode is switched on', () => {
    const { rerender } = render(createElement(ConnectivityBridge));
    expect(disposeWsClient).not.toHaveBeenCalled();

    connectivity.offlineMode = true;
    rerender(createElement(ConnectivityBridge));

    expect(disposeWsClient).toHaveBeenCalledTimes(1);
  });

  // The client is lazy and PR-A's deferred join re-subscribes on the online
  // edge, so tearing it down again here would only cost a reconnect.
  it('leaves the socket alone on the way back online', () => {
    connectivity.offlineMode = true;
    const { rerender } = render(createElement(ConnectivityBridge));

    connectivity.offlineMode = false;
    rerender(createElement(ConnectivityBridge));

    expect(disposeWsClient).not.toHaveBeenCalled();
  });

  // A launch that restored offline mode from the persisted setting has no socket
  // yet — disposing one nobody opened would be pure noise.
  it('does not dispose on a mount that starts in offline mode', () => {
    connectivity.offlineMode = true;

    render(createElement(ConnectivityBridge));

    expect(disposeWsClient).not.toHaveBeenCalled();
  });

  it('does not dispose again while offline mode simply stays on', () => {
    const { rerender } = render(createElement(ConnectivityBridge));
    connectivity.offlineMode = true;
    rerender(createElement(ConnectivityBridge));

    rerender(createElement(ConnectivityBridge));

    expect(disposeWsClient).toHaveBeenCalledTimes(1);
  });
});

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

import { ConnectivityBridge } from '../connectivity-bridge';

describe('ConnectivityBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flagState.detectionEnabled = true;
    flagState.deadlineEnabled = true;
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
});

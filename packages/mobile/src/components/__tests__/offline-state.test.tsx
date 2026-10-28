// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const connectivity = vi.hoisted(() => ({ effectiveOffline: false }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { tertiaryLabel: '#999', label: '#000', secondaryLabel: '#666' } }),
}));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 8: 32, 10: 40 } }));
vi.mock('../../lib/connectivity/use-connectivity', () => ({
  selectEffectiveOffline: (snapshot: typeof connectivity) => snapshot.effectiveOffline,
  useConnectivityField: <Field,>(select: (snapshot: typeof connectivity) => Field) => select(connectivity),
}));
vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../Button', () => ({
  Button: ({ title, onPress, variant }: { title: string; onPress: () => void; variant?: string }) =>
    createElement('button', { onClick: onPress, 'data-variant': variant }, title),
}));

import { OfflineState } from '../OfflineState';

describe('OfflineState', () => {
  beforeEach(() => {
    connectivity.effectiveOffline = false;
  });

  it('names what failed when the caller passes an error title', () => {
    const { getByText, queryByText } = render(
      <OfflineState reason="error" errorTitle="Couldn't load your sessions" onRetry={() => {}} />,
    );
    expect(getByText("Couldn't load your sessions")).toBeTruthy();
    expect(queryByText('mobile.offlineState.errorTitle')).toBeNull();
  });

  it('falls back to the generic title without one', () => {
    const { getByText } = render(<OfflineState reason="error" onRetry={() => {}} />);
    expect(getByText('mobile.offlineState.errorTitle')).toBeTruthy();
  });

  it('keeps the server title for a server failure, even with an error title', () => {
    const { getByText, queryByText } = render(
      <OfflineState reason="backend_unreachable" errorTitle="Couldn't load your sessions" onRetry={() => {}} />,
    );
    expect(getByText('mobile.offlineState.serverTitle')).toBeTruthy();
    expect(queryByText("Couldn't load your sessions")).toBeNull();
  });

  it('draws Retry as the filled button and calls back on tap', () => {
    const onRetry = vi.fn();
    const { getByText } = render(<OfflineState reason="error" onRetry={onRetry} />);
    const retry = getByText('mobile.offlineState.retry');
    expect(retry.getAttribute('data-variant')).toBe('filled');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers Retry for a server failure the connectivity banner is not handling yet', () => {
    const { getByText } = render(<OfflineState reason="backend_unreachable" onRetry={() => {}} />);
    expect(getByText('mobile.offlineState.retry')).toBeTruthy();
  });

  it('leaves the retry to the banner once the store has declared an outage', () => {
    connectivity.effectiveOffline = true;
    const { queryByText } = render(<OfflineState reason="backend_unreachable" onRetry={() => {}} />);
    expect(queryByText('mobile.offlineState.retry')).toBeNull();
  });

  it('never offers Retry for no signal', () => {
    connectivity.effectiveOffline = true;
    const { queryByText } = render(<OfflineState reason="offline" onRetry={() => {}} />);
    expect(queryByText('mobile.offlineState.retry')).toBeNull();
  });
});

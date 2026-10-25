// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ModalMockProps = { children?: ReactNode; header?: ReactNode; onClose?: () => void };
type SegmentMockProps = {
  options: { key: string; label: string }[];
  selectedKey: string;
  onSelect: (key: string) => void;
};
const captures = vi.hoisted(() => ({
  platform: 'ios',
  qrValue: undefined as string | undefined,
  qrLabel: undefined as string | undefined,
  showToast: vi.fn(),
  track: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return captures.platform;
    },
  },
  Share: { share: vi.fn(async () => ({ action: 'sharedAction' })) },
  View: ({
    children,
    accessibilityRole,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
    accessibilityLabel?: string;
  }) => {
    if (accessibilityRole === 'image') captures.qrLabel = accessibilityLabel;
    return createElement('div', null, children);
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../ModalSheet', () => ({
  ModalSheet: ({ children, header }: ModalMockProps) => createElement('div', null, header, children),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('react-native-qrcode-svg', () => ({
  default: ({ value }: { value: string }) => {
    captures.qrValue = value;
    return null;
  },
}));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../SegmentedControl', () => ({
  SegmentedControl: ({ options, selectedKey, onSelect }: SegmentMockProps) =>
    createElement(
      'div',
      null,
      options.map((option) =>
        createElement(
          'button',
          { key: option.key, 'aria-pressed': option.key === selectedKey, onClick: () => onSelect(option.key) },
          option.label,
        ),
      ),
    ),
}));
vi.mock('../SheetTopBar', () => ({
  SheetTopBar: ({ title, leading }: { title: string; leading: { onPress: () => void } }) =>
    createElement('div', null, title, createElement('button', { 'data-testid': 'close', onClick: leading.onPress })),
}));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { label: '#LABEL' } }) }));
vi.mock('../../providers/toast-provider', () => ({ useToast: () => ({ showToast: captures.showToast }) }));
vi.mock('../sheet-snap-points', () => ({ MEDIUM_LARGE_SNAP_POINTS: ['50%', '90%'] }));
vi.mock('../../lib/analytics', () => ({ track: captures.track }));
vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16, 6: 24 }, borderRadius: { lg: 12 } }));

import { ShareAppSheet } from '../ShareAppSheet';
import { Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { storeUrlForAppShare } from '../../lib/store-links';

describe('ShareAppSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captures.platform = 'ios';
    captures.qrValue = undefined;
    captures.qrLabel = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens on the App Store on an iPhone', () => {
    render(<ShareAppSheet onDismiss={vi.fn()} />);
    expect(captures.qrValue).toBe(storeUrlForAppShare('ios'));
    expect(captures.qrLabel).toBe('mobile.about.shareApp.qrLabelIos');
  });

  it('opens on Google Play on an Android phone', () => {
    captures.platform = 'android';
    render(<ShareAppSheet onDismiss={vi.fn()} />);
    expect(captures.qrValue).toBe(storeUrlForAppShare('android'));
    expect(captures.qrLabel).toBe('mobile.about.shareApp.qrLabelAndroid');
  });

  it('reads the store from the user agent in the browser app', () => {
    captures.platform = 'web';
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/141.0 Mobile Safari/537.36',
    });
    render(<ShareAppSheet onDismiss={vi.fn()} />);
    expect(captures.qrValue).toBe(storeUrlForAppShare('android'));
  });

  it('opens on the App Store for an iPhone browser and a desktop browser', () => {
    captures.platform = 'web';
    for (const userAgent of [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Version/18.5 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.5 Safari/605.1.15',
    ]) {
      vi.stubGlobal('navigator', { userAgent });
      const { unmount } = render(<ShareAppSheet onDismiss={vi.fn()} />);
      expect(captures.qrValue).toBe(storeUrlForAppShare('ios'));
      unmount();
    }
  });

  it('confirms a copy, and says so when the copy fails', async () => {
    const { getByText } = render(<ShareAppSheet onDismiss={vi.fn()} />);
    await act(async () => getByText('mobile.about.shareApp.copyLink').click());
    expect(captures.showToast).toHaveBeenLastCalledWith('mobile.about.shareApp.copied', 'success');
    vi.mocked(Clipboard.setStringAsync).mockRejectedValueOnce(new Error('denied'));
    await act(async () => getByText('mobile.about.shareApp.copyLink').click());
    expect(captures.showToast).toHaveBeenLastCalledWith('mobile.about.shareApp.copyFailed', 'error');
  });

  it('treats a copy that resolves false as failed, as the browser clipboard does', async () => {
    vi.mocked(Clipboard.setStringAsync).mockResolvedValueOnce(false);
    const { getByText } = render(<ShareAppSheet onDismiss={vi.fn()} />);
    await act(async () => getByText('mobile.about.shareApp.copyLink').click());
    expect(captures.showToast).toHaveBeenCalledWith('mobile.about.shareApp.copyFailed', 'error');
    expect(captures.showToast).not.toHaveBeenCalledWith('mobile.about.shareApp.copied', 'success');
  });

  it('copies the message without trying to share in a browser with no share menu', async () => {
    captures.platform = 'web';
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15' });
    const { getByText } = render(<ShareAppSheet onDismiss={vi.fn()} />);
    await act(async () => getByText('mobile.about.shareApp.share').click());
    expect(Share.share).not.toHaveBeenCalled();
    expect(vi.mocked(Clipboard.setStringAsync).mock.calls[0]?.[0]).toContain('mobile.about.shareApp.message');
    expect(captures.showToast).toHaveBeenCalledWith('mobile.about.shareApp.messageCopied', 'success');
  });

  it('opens the share menu in a phone browser that has one', async () => {
    captures.platform = 'web';
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Version/18.5 Mobile/15E148 Safari/604.1',
      share: vi.fn(),
    });
    const { getByText } = render(<ShareAppSheet onDismiss={vi.fn()} />);
    await act(async () => getByText('mobile.about.shareApp.share').click());
    expect(Share.share).toHaveBeenCalledOnce();
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  });

  it('copies the message when sharing fails', async () => {
    vi.mocked(Share.share).mockRejectedValueOnce(new Error('share failed'));
    const { getByText } = render(<ShareAppSheet onDismiss={vi.fn()} />);
    await act(async () => getByText('mobile.about.shareApp.share').click());
    expect(vi.mocked(Clipboard.setStringAsync).mock.calls[0]?.[0]).toContain('mobile.about.shareApp.message');
    expect(captures.showToast).toHaveBeenCalledWith('mobile.about.shareApp.messageCopied', 'success');
  });

  it('says the message, not the link, failed to copy', async () => {
    vi.mocked(Share.share).mockRejectedValueOnce(new Error('share failed'));
    vi.mocked(Clipboard.setStringAsync).mockResolvedValueOnce(false);
    const { getByText } = render(<ShareAppSheet onDismiss={vi.fn()} />);
    await act(async () => getByText('mobile.about.shareApp.share').click());
    expect(captures.showToast).toHaveBeenCalledWith('mobile.about.shareApp.messageCopyFailed', 'error');
  });

  it('does nothing more when the climber backs out of the share menu', async () => {
    const abort = new Error('Share canceled');
    abort.name = 'AbortError';
    vi.mocked(Share.share).mockRejectedValueOnce(abort);
    const { getByText } = render(<ShareAppSheet onDismiss={vi.fn()} />);
    await act(async () => getByText('mobile.about.shareApp.share').click());
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    expect(captures.showToast).not.toHaveBeenCalled();
  });

  it('switches the QR code and copied link with the store toggle', async () => {
    const { getByText } = render(<ShareAppSheet onDismiss={vi.fn()} />);
    act(() => getByText('mobile.about.shareApp.googlePlay').click());
    expect(captures.qrValue).toBe(storeUrlForAppShare('android'));
    await act(async () => getByText('mobile.about.shareApp.copyLink').click());
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(storeUrlForAppShare('android'));
  });

  it('shares both store links in one message', () => {
    const { getByText } = render(<ShareAppSheet onDismiss={vi.fn()} />);
    act(() => getByText('mobile.about.shareApp.share').click());
    const message = vi.mocked(Share.share).mock.calls[0]?.[0]?.message ?? '';
    expect(message).toContain(JSON.stringify(storeUrlForAppShare('ios')).slice(1, -1));
    expect(message).toContain(JSON.stringify(storeUrlForAppShare('android')).slice(1, -1));
  });

  it('counts copy and share taps with the store the QR code showed', async () => {
    const { getByText } = render(<ShareAppSheet onDismiss={vi.fn()} />);
    act(() => getByText('mobile.about.shareApp.googlePlay').click());
    await act(async () => getByText('mobile.about.shareApp.copyLink').click());
    await act(async () => getByText('mobile.about.shareApp.share').click());
    expect(captures.track).toHaveBeenNthCalledWith(1, 'App Share Action', { action: 'copy-link', store: 'android' });
    expect(captures.track).toHaveBeenNthCalledWith(2, 'App Share Action', { action: 'share', store: 'android' });
  });

  it('closes from the top bar', () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(<ShareAppSheet onDismiss={onDismiss} />);
    act(() => getByTestId('close').click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

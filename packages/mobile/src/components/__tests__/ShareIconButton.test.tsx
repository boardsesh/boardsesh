// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  share: vi.fn(),
  setStringAsync: vi.fn(),
  showToast: vi.fn(),
  prewarmShareCaches: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: mocks.platform, Share: { share: mocks.share } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.setStringAsync }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000', fill: '#eee' } }),
}));
vi.mock('../../providers/toast-provider', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../lib/share-prewarm', () => ({ prewarmShareCaches: mocks.prewarmShareCaches }));
vi.mock('../GlassIconButton', () => ({
  GlassIconButton: ({ onPress, accessibilityLabel }: { onPress: () => void; accessibilityLabel: string }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }),
}));

import { ShareIconButton } from '../ShareIconButton';

const URL_TO_SHARE = 'https://www.boardsesh.com/playlists/abc';
const onShare = vi.fn();

function tapShare(prewarmOgImageUrl?: string) {
  const { getByRole } = render(
    <ShareIconButton
      url={URL_TO_SHARE}
      message="Check this out"
      accessibilityLabel="Share"
      copiedMessage="copied"
      errorMessage="failed"
      onShare={onShare}
      prewarmOgImageUrl={prewarmOgImageUrl}
    />,
  );
  fireEvent.click(getByRole('button', { name: 'Share' }));
}

function setBrowserShare(share: unknown) {
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
}

beforeEach(() => {
  mocks.platform.OS = 'ios';
  mocks.share.mockReset().mockResolvedValue({ action: 'sharedAction' });
  mocks.setStringAsync.mockReset().mockResolvedValue(true);
  mocks.showToast.mockReset();
  onShare.mockReset();
  mocks.prewarmShareCaches.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'share');
  vi.restoreAllMocks();
});

describe('ShareIconButton', () => {
  it('warms the page and its card before the sheet opens, when it is given one', () => {
    tapShare('https://ws.boardsesh.com/og/playlist?uuid=abc');

    expect(mocks.prewarmShareCaches).toHaveBeenCalledWith(
      URL_TO_SHARE,
      'https://ws.boardsesh.com/og/playlist?uuid=abc',
    );
    expect(mocks.prewarmShareCaches.mock.invocationCallOrder[0]).toBeLessThan(mocks.share.mock.invocationCallOrder[0]);
  });

  it('warms nothing for a link with no card', () => {
    tapShare();

    expect(mocks.prewarmShareCaches).not.toHaveBeenCalled();
    expect(mocks.share).toHaveBeenCalled();
  });

  it('sends the url in its own field on iOS and reports the tap', () => {
    tapShare();
    expect(mocks.share).toHaveBeenCalledWith({ message: 'Check this out', url: URL_TO_SHARE });
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('puts the url in the message on Android', () => {
    mocks.platform.OS = 'android';
    tapShare();
    expect(mocks.share).toHaveBeenCalledWith({ message: `Check this out\n${URL_TO_SHARE}` });
  });

  it('toasts a failed native share', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.share.mockRejectedValue(new Error('nope'));
    tapShare();
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('failed', 'error'));
  });

  it('copies the link in a browser with no share menu', async () => {
    mocks.platform.OS = 'web';
    setBrowserShare(undefined);
    tapShare();
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.setStringAsync).toHaveBeenCalledWith(URL_TO_SHARE);
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('copied', 'success'));
  });

  it('says so when the browser blocks the copy', async () => {
    mocks.platform.OS = 'web';
    setBrowserShare(undefined);
    mocks.setStringAsync.mockResolvedValue(false);
    tapShare();
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('failed', 'error'));
  });

  it('stays quiet when the climber backs out of the browser share menu', async () => {
    mocks.platform.OS = 'web';
    setBrowserShare(vi.fn());
    const aborted = new Error('cancelled');
    aborted.name = 'AbortError';
    mocks.share.mockRejectedValue(aborted);
    tapShare();
    await waitFor(() => expect(mocks.share).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.setStringAsync).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('falls back to copying when the browser share menu fails', async () => {
    mocks.platform.OS = 'web';
    setBrowserShare(vi.fn());
    mocks.share.mockRejectedValue(new Error('not allowed'));
    tapShare();
    await waitFor(() => expect(mocks.setStringAsync).toHaveBeenCalledWith(URL_TO_SHARE));
  });
});

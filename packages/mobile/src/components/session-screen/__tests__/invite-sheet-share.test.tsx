// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  share: vi.fn(async () => ({ action: 'sharedAction' })),
  setStringAsync: vi.fn(async () => true),
  showToast: vi.fn(),
  prewarmShareCaches: vi.fn(async () => {}),
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  Share: { share: mocks.share, dismissedAction: 'dismissedAction' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.setStringAsync }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../SheetTopBar', () => ({ SheetTopBar: () => null }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));
vi.mock('../../sheet-snap-points', () => ({ MEDIUM_LARGE_SNAP_POINTS: ['50%', '90%'] }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16, 6: 24 }, borderRadius: { lg: 12 } }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/showcase-anchor', () => ({ useShowcaseAnchor: () => ({}) }));
vi.mock('../../../lib/session-share', () => ({
  buildSessionShareUrl: (sessionId: string) => `https://www.boardsesh.com/join/${sessionId}`,
}));
vi.mock('../../../lib/share-prewarm', () => ({
  buildSessionInviteOgImageUrl: (sessionId: string) =>
    `https://ws.boardsesh.com/og/session?sessionId=${sessionId}&variant=join`,
  prewarmShareCaches: mocks.prewarmShareCaches,
}));

import { InviteSheet } from '../InviteSheet';

const url = 'https://www.boardsesh.com/join/session-1';
const imageUrl = 'https://ws.boardsesh.com/og/session?sessionId=session-1&variant=join';

beforeEach(() => {
  mocks.platform.OS = 'ios';
  mocks.share.mockReset().mockResolvedValue({ action: 'sharedAction' });
  mocks.setStringAsync.mockReset().mockResolvedValue(true);
  mocks.showToast.mockReset();
  mocks.prewarmShareCaches.mockClear();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'share');
});

function tapShare() {
  const screen = render(<InviteSheet visible onDismiss={vi.fn()} sessionId="session-1" />);
  act(() => screen.getByText('mobile.session.inviteShare').click());
}

describe('InviteSheet sharing', () => {
  it('warms the invite card without waiting before sharing the join URL', async () => {
    mocks.prewarmShareCaches.mockImplementationOnce(() => new Promise<void>(() => {}));
    tapShare();
    expect(mocks.prewarmShareCaches).toHaveBeenCalledWith(url, imageUrl);
    expect(mocks.share).toHaveBeenCalledWith({ message: url, url });
  });

  it('shares the join URL once on Android', () => {
    mocks.platform.OS = 'android';
    tapShare();
    expect(mocks.share).toHaveBeenCalledWith({ message: url });
  });

  it('copies the join URL when the browser has no share menu', async () => {
    mocks.platform.OS = 'web';
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    tapShare();
    await vi.waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('mobile.session.inviteCopied', 'success'));
    expect(mocks.setStringAsync).toHaveBeenCalledWith(url);
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it('reports a failed native share instead of leaving a rejected promise', async () => {
    mocks.share.mockRejectedValue(new Error('Share failed'));
    tapShare();
    await vi.waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('detail.shareError', 'error'));
  });
});

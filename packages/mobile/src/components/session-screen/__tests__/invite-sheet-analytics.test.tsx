// @vitest-environment jsdom
//
// The invite sheet's analytics wiring (#6004): opened once per open, a copy
// and a system share each counted, and a dismissed share sheet counted as
// nothing. The payloads themselves are pinned in
// `src/lib/__tests__/session-invite-analytics.test.ts`.
import { act, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const share = vi.hoisted(() => ({ share: vi.fn() }));
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async () => true) }));
const buttons = vi.hoisted(() => ({ byTitle: new Map<string, () => void>() }));

vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Share: { share: share.share, sharedAction: 'sharedAction', dismissedAction: 'dismissedAction' },
}));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  BottomSheetView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard.setStringAsync }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));
vi.mock('../../../lib/showcase-anchor', () => ({ useShowcaseAnchor: () => ({}) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ onPress, title }: { onPress?: () => void; title: string }) => {
    if (onPress) buttons.byTitle.set(title, onPress);
    return createElement('button', null, title);
  },
}));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: () => ({ onChange: vi.fn(), onFullyDismissed: vi.fn() }),
}));
vi.mock('../../sheet-snap-points', () => ({ androidSafeSnapPoints: (points: unknown) => points }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({ spacing: {}, borderRadius: {}, sheetStyles: {} }));
vi.mock('../../../lib/session-share', () => ({
  buildSessionShareUrl: (sessionId: string) => `https://www.boardsesh.com/join/${sessionId}`,
}));

import { InviteSheet } from '../InviteSheet';

function sheet(visible: boolean, sessionId = 'session-1') {
  return createElement(InviteSheet, { visible, sessionId, onDismiss: () => {} });
}

function opened(): unknown[][] {
  return analytics.track.mock.calls.filter(([name]) => name === 'Session Invite Sheet Opened');
}

beforeEach(() => {
  analytics.track.mockClear();
  share.share.mockReset();
  clipboard.setStringAsync.mockClear();
  buttons.byTitle.clear();
});

describe('InviteSheet analytics', () => {
  it('stays quiet while the always-mounted sheet is closed', () => {
    render(sheet(false));

    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('counts one open per open, not per render', () => {
    const { rerender } = render(sheet(false));
    rerender(sheet(true));
    rerender(sheet(true));
    expect(opened()).toEqual([['Session Invite Sheet Opened', { sessionId: 'session-1' }]]);

    rerender(sheet(false));
    rerender(sheet(true));
    expect(opened()).toHaveLength(2);
  });

  it('does not count an open before there is a session to invite to', () => {
    render(sheet(true, ''));

    expect(opened()).toEqual([]);
  });

  it('counts a copied link once the clipboard write lands', async () => {
    render(sheet(true));

    await act(async () => {
      buttons.byTitle.get('mobile.session.inviteCopyLink')?.();
    });

    await waitFor(() =>
      expect(analytics.track).toHaveBeenCalledWith('Session Invite Shared', {
        sessionId: 'session-1',
        method: 'copy_link',
      }),
    );
    expect(clipboard.setStringAsync).toHaveBeenCalledWith('https://www.boardsesh.com/join/session-1');
  });

  it('counts a completed system share with the app it went to', async () => {
    share.share.mockResolvedValue({ action: 'sharedAction', activityType: 'com.apple.UIKit.activity.Message' });
    render(sheet(true));

    await act(async () => {
      buttons.byTitle.get('mobile.session.inviteShare')?.();
    });

    await waitFor(() =>
      expect(analytics.track).toHaveBeenCalledWith('Session Invite Shared', {
        sessionId: 'session-1',
        method: 'system_share',
        shareTarget: 'com.apple.UIKit.activity.Message',
      }),
    );
  });

  it('counts nothing for a dismissed share sheet, or one that failed to open', async () => {
    share.share.mockResolvedValueOnce({ action: 'dismissedAction' });
    render(sheet(true));

    await act(async () => {
      buttons.byTitle.get('mobile.session.inviteShare')?.();
    });
    share.share.mockRejectedValueOnce(new Error('no share sheet'));
    await act(async () => {
      buttons.byTitle.get('mobile.session.inviteShare')?.();
    });

    expect(share.share).toHaveBeenCalledTimes(2);
    expect(analytics.track).not.toHaveBeenCalledWith('Session Invite Shared', expect.anything());
  });
});

// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));

// The attach mutation. `mutate` synchronously invokes the success callback so
// the component's onSuccess (where the analytics fire) runs inline in the test.
const attach = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn((_variables: unknown, callbacks: { onSuccess?: () => void }) => {
    callbacks.onSuccess?.();
  }),
}));

// Capture the paste field + submit button handlers so the test can drive a
// submit without a real renderer. The only react-native Pressable in the sheet
// is the submit button (steps use Views; copy / open-Instagram are <Button>s,
// which we mock out below).
const captured = vi.hoisted(() => ({
  onChangeText: null as ((text: string) => void) | null,
  onPress: null as (() => void) | null,
  buttons: {} as Record<string, (() => Promise<void>) | undefined>,
}));

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => {}) }));

vi.mock('../../lib/analytics', () => ({ track: analytics.track }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Pressable: ({ onPress, children }: { onPress?: () => void; children?: ReactNode }) => {
    captured.onPress = onPress ?? null;
    return createElement('button', null, typeof children === 'function' ? null : children);
  },
}));

// The paste field is a gorhom `BottomSheetTextInput` (so the host sheet lifts it
// above the keyboard). Mock it here to capture onChangeText and to keep the real
// module — which pulls in reanimated — out of the jsdom run.
vi.mock('@gorhom/bottom-sheet', () => ({
  BottomSheetTextInput: ({ onChangeText }: { onChangeText?: (text: string) => void }) => {
    captured.onChangeText = onChangeText ?? null;
    return createElement('input');
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard.setStringAsync }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(async () => {}),
  selectionAsync: vi.fn(async () => {}),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));
vi.mock('../ModalSheet', () => ({
  ModalSheet: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../Icon', () => ({ Icon: () => null }));
vi.mock('../Button', () => ({
  Button: ({ title, onPress }: { title?: string; onPress?: () => Promise<void> }) => {
    if (title) captured.buttons[title] = onPress;
    return createElement('button', null, title);
  },
}));
vi.mock('../../lib/instagram', () => ({ openInstagram: vi.fn(async () => ({ opened: true, usedFallback: false })) }));
vi.mock('../../lib/graphql/hooks', () => ({ useAttachBetaLink: () => attach }));
vi.mock('../../lib/graphql/extract-error-message', () => ({ extractGraphqlMessage: () => null }));
vi.mock('../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: '#000', primaryFill: '#000', onPrimary: '#fff' },
    systemColors: { separator: '#ccc', secondaryLabel: '#666', tertiaryLabel: '#999', label: '#000' },
  }),
}));
vi.mock('../../theme/ios-colors', () => ({ iosSystemColors: {} }));
vi.mock('../../theme/tokens', () => ({ spacing: {}, borderRadius: {} }));

import { AddBetaVideoSheet } from '../AddBetaVideoSheet';

const CLIMB = {
  uuid: 'climb-1',
  name: 'Test Climb',
  difficulty: 'V4',
  setter_username: 'someone',
} as unknown as Parameters<typeof AddBetaVideoSheet>[0]['climb'];

beforeEach(() => {
  analytics.track.mockClear();
  attach.mutate.mockClear();
  attach.isPending = false;
  clipboard.setStringAsync.mockClear();
  captured.onChangeText = null;
  captured.onPress = null;
  captured.buttons = {};
});

function renderSheet() {
  return render(
    createElement(AddBetaVideoSheet, {
      visible: true,
      climb: CLIMB,
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      onClose: vi.fn(),
    }),
  );
}

// Type a URL (flushing the setState re-render so the submit closure sees it),
// then press submit.
function typeAndSubmit(url: string) {
  act(() => captured.onChangeText?.(url));
  act(() => captured.onPress?.());
}

describe('AddBetaVideoSheet attach analytics', () => {
  it('fires "Beta Video Added" with platform "TikTok" on a successful submit', () => {
    renderSheet();
    typeAndSubmit('https://www.tiktok.com/@user/video/123');

    expect(attach.mutate).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith('Beta Video Added', {
      boardType: 'kilter',
      climbUuid: 'climb-1',
      platform: 'TikTok',
    });
  });

  it('classifies an Instagram URL as platform "Instagram"', () => {
    renderSheet();
    typeAndSubmit('https://www.instagram.com/reel/abc/');

    expect(analytics.track).toHaveBeenCalledWith('Beta Video Added', {
      boardType: 'kilter',
      climbUuid: 'climb-1',
      platform: 'Instagram',
    });
  });

  it('does not fire for an invalid (non-beta) URL', () => {
    renderSheet();
    typeAndSubmit('not a url');

    expect(attach.mutate).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
  });

  // Regression guard for the decoupled copy/open flow: "Open Instagram" must copy
  // the caption itself, so a user who skips "Copy caption" still arrives in the
  // camera with it on the clipboard (PR #2846 review finding #1).
  it('copies the caption when opening Instagram, even if Copy was skipped', async () => {
    renderSheet();
    await act(async () => {
      await captured.buttons['mobile.betaVideos.openInstagram']?.();
    });

    expect(clipboard.setStringAsync).toHaveBeenCalledTimes(1);
    expect(clipboard.setStringAsync.mock.calls[0]?.[0]).toContain('Test Climb');
    expect(analytics.track).toHaveBeenCalledWith('Beta Instagram Opened', {
      boardType: 'kilter',
      climbUuid: 'climb-1',
      opened: true,
      usedFallback: false,
    });
  });
});

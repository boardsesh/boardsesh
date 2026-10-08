// @vitest-environment jsdom
vi.mock('../AccessibleBottomSheetTextInput', async () => {
  const { BottomSheetTextInput } = await import('@expo/ui/community/bottom-sheet');
  return { AccessibleBottomSheetTextInput: BottomSheetTextInput };
});
vi.mock('../../providers/dialog-provider', () => ({ useConfirm: () => async () => false }));
vi.mock('../../lib/announce-queued', () => ({ announceQueued: vi.fn() }));
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));

// The attach mutation. `mutate` synchronously invokes the success callback so
// the component's onSuccess (where the analytics fire) runs inline in the test.
const attach = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn((_variables: unknown, callbacks: { onSuccess?: () => void; onError?: (error: Error) => void }) => {
    callbacks.onSuccess?.();
  }),
}));

// Capture the paste field handler so the test can type a URL without a real
// renderer; the submit is the top bar's trailing action (copy / open-Instagram
// are <Button>s, which we mock out below).
const captured = vi.hoisted(() => ({
  onChangeText: null as ((text: string) => void) | null,
  buttons: {} as Record<string, (() => Promise<void>) | undefined>,
}));

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => {}) }));

vi.mock('../../lib/analytics', () => ({ track: analytics.track }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

// The paste field is a gorhom `BottomSheetTextInput` (so the host sheet lifts it
// above the keyboard). Mock it here to capture onChangeText and to keep the real
// module — which pulls in reanimated — out of the jsdom run.
vi.mock('@expo/ui/community/bottom-sheet', () => ({
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
  // Render both slots: the submit lives in the `header` top bar.
  ModalSheet: ({ children, header }: { children?: ReactNode; header?: ReactNode }) =>
    createElement('div', null, header, children),
}));
vi.mock('../SheetTopBar', async () => (await import('../../test/sheet-top-bar-stub')).sheetTopBarModule);
vi.mock('../sheet-scroll-into-view', () => ({ useSheetScrollIntoView: () => null }));
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
    brandColors: { primary: '#000', primaryFill: '#000', onPrimary: '#fff', error: '#C81E1E' },
    systemColors: { separator: '#ccc', secondaryLabel: '#666', tertiaryLabel: '#999', label: '#000' },
  }),
}));
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
  captured.buttons = {};
});

let rendered: ReturnType<typeof render> | null = null;
function renderSheet() {
  rendered = render(
    createElement(AddBetaVideoSheet, {
      visible: true,
      climb: CLIMB,
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      onClose: vi.fn(),
    }),
  );
  return rendered;
}

// Type a URL (flushing the setState re-render so the submit closure sees it),
// then press submit.
function typeAndSubmit(url: string) {
  act(() => captured.onChangeText?.(url));
  act(() => {
    (rendered?.container.querySelector('[data-testid="sheet-top-bar-trailing"]') as HTMLButtonElement | null)?.click();
  });
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

  it('keeps a failed link editable and displays the error until retry', () => {
    attach.mutate.mockImplementationOnce((_variables, callbacks) => callbacks.onError?.(new Error('offline')));
    const screen = renderSheet();
    typeAndSubmit('https://www.instagram.com/reel/ABC123/');
    expect(screen.getByText('mobile.betaVideos.attachError')).toBeTruthy();
    expect(analytics.track).not.toHaveBeenCalled();
    act(() => captured.onChangeText?.('https://www.instagram.com/reel/XYZ456/'));
    expect(screen.queryByText('mobile.betaVideos.attachError')).toBeNull();
    typeAndSubmit('https://www.instagram.com/reel/XYZ456/');
    expect(attach.mutate).toHaveBeenCalledTimes(2);
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

// This suite exercises the existing flow before the server privacy rollout.
vi.mock('../../lib/graphql/hooks/use-privacy', () => ({ usePrivacySettings: () => ({ data: undefined }) }));
vi.mock('../privacy/PublicationAudiencePicker', () => ({
  PublicationAudiencePicker: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../privacy/ContentAudienceControl', () => ({
  ContentAudienceControl: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../privacy/ResourcePrivacyControl', () => ({
  ResourcePrivacyControl: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../privacy/AudiencePicker', () => ({
  AudiencePicker: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../privacy/use-publication-audience', () => ({
  usePublicationAudience: () => ({
    enabled: false,
    isPrivate: false,
    audience: 'public',
    publication: undefined,
    chooseAudience: () => {},
  }),
}));

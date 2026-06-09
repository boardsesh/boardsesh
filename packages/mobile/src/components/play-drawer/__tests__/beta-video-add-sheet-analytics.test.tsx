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

// Capture the host handlers so the test can type a URL and press submit without
// a real renderer.
const captured = vi.hoisted(() => ({
  onChangeText: null as ((text: string) => void) | null,
  onPress: null as (() => void) | null,
}));

vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  TextInput: ({ onChangeText }: { onChangeText?: (text: string) => void }) => {
    captured.onChangeText = onChangeText ?? null;
    return createElement('input');
  },
  Pressable: ({ onPress, children }: { onPress?: () => void; children?: ReactNode }) => {
    captured.onPress = onPress ?? null;
    return createElement('button', null, typeof children === 'function' ? null : children);
  },
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Platform: { OS: 'ios' },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(async () => {}),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));
vi.mock('../../Sheet', () => ({
  Sheet: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../lib/graphql/hooks', () => ({ useAttachBetaLink: () => attach }));
vi.mock('../../../lib/graphql/extract-error-message', () => ({ extractGraphqlMessage: () => null }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: {} }));
vi.mock('../../../theme/colors', () => ({ brandColors: {} }));
vi.mock('../../../theme/tokens', () => ({ spacing: {}, borderRadius: {} }));

import { BetaVideoAddSheet } from '../BetaVideoAddSheet';

beforeEach(() => {
  analytics.track.mockClear();
  attach.mutate.mockClear();
  attach.isPending = false;
  captured.onChangeText = null;
  captured.onPress = null;
});

function renderSheet() {
  return render(createElement(BetaVideoAddSheet, { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 }));
}

// Type a URL (flushing the setState re-render so the submit closure sees it),
// then press submit.
function typeAndSubmit(url: string) {
  act(() => captured.onChangeText?.(url));
  act(() => captured.onPress?.());
}

describe('BetaVideoAddSheet analytics', () => {
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
});

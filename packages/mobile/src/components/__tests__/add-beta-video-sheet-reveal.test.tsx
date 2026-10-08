// @vitest-environment jsdom
vi.mock('../AccessibleBottomSheetTextInput', async () => {
  const { BottomSheetTextInput } = await import('@expo/ui/community/bottom-sheet');
  return { AccessibleBottomSheetTextInput: BottomSheetTextInput };
});
vi.mock('../../providers/dialog-provider', () => ({ useConfirm: () => async () => false }));
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The paste field reveals itself above the keyboard on focus, then follows its
// own growth (the invalid-URL line) so the error clears the keyboard too.
const analytics = vi.hoisted(() => ({ track: vi.fn() }));

// The attach mutation. `mutate` synchronously invokes the success callback so
// the component's onSuccess (where the analytics fire) runs inline in the test.
const attach = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn((_variables: unknown, callbacks: { onSuccess?: () => void }) => {
    callbacks.onSuccess?.();
  }),
}));

// Capture the paste field handler so the test can type a URL without a real
// renderer; the submit is the top bar's trailing action (copy / open-Instagram
// are <Button>s, which we mock out below).
const captured = vi.hoisted(() => ({
  onChangeText: null as ((text: string) => void) | null,
  onFocus: null as (() => void) | null,
  onBlur: null as (() => void) | null,
  layouts: [] as Array<() => void>,
  buttons: {} as Record<string, (() => Promise<void>) | undefined>,
}));

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => {}) }));

vi.mock('../../lib/analytics', () => ({ track: analytics.track }));

vi.mock('react-native', () => ({
  View: ({ children, ref, onLayout }: { children?: ReactNode; ref?: unknown; onLayout?: () => void }) => {
    if (onLayout) captured.layouts.push(onLayout);
    return createElement('div', { ref }, children);
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

// The paste field is a gorhom `BottomSheetTextInput` (so the host sheet lifts it
// above the keyboard). Mock it here to capture onChangeText and to keep the real
// module — which pulls in reanimated — out of the jsdom run.
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetTextInput: ({
    onChangeText,
    onFocus,
    onBlur,
  }: {
    onChangeText?: (text: string) => void;
    onFocus?: () => void;
    onBlur?: () => void;
  }) => {
    captured.onChangeText = onChangeText ?? null;
    captured.onFocus = onFocus ?? null;
    captured.onBlur = onBlur ?? null;
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
const scrollIntoView = vi.hoisted(() => ({ reveal: vi.fn(), follow: vi.fn(), release: vi.fn() }));
vi.mock('../sheet-scroll-into-view', () => ({ useSheetScrollIntoView: () => scrollIntoView }));
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

// The URL field's wrapper is the last View with an onLayout in the tree.
function layoutUrlField() {
  act(() => captured.layouts.at(-1)?.());
}

beforeEach(() => {
  scrollIntoView.reveal.mockClear();
  scrollIntoView.follow.mockClear();
  scrollIntoView.release.mockClear();
  captured.layouts = [];
  captured.onFocus = null;
  captured.onBlur = null;
});

describe('AddBetaVideoSheet URL field reveal', () => {
  it('follows the field again when its layout changes while focused', () => {
    renderSheet();
    act(() => captured.onFocus?.());
    expect(scrollIntoView.reveal).toHaveBeenCalledTimes(1);
    act(() => captured.onChangeText?.('not a url'));
    layoutUrlField();
    expect(scrollIntoView.follow).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.follow.mock.calls[0]?.[0]).toBe(scrollIntoView.reveal.mock.calls[0]?.[0]);
  });

  it('does not scroll on a layout change while the field is not focused', () => {
    renderSheet();
    layoutUrlField();
    act(() => captured.onFocus?.());
    act(() => captured.onBlur?.());
    layoutUrlField();
    expect(scrollIntoView.follow).not.toHaveBeenCalled();
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

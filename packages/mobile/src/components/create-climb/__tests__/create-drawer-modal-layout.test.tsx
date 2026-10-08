// @vitest-environment jsdom
vi.mock('../AccessibleHoldList', () => ({ AccessibleHoldList: () => null }));
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// New climb is a full-height modal route now, not a bottom sheet with a peek.
// What these cases pin: the top bar (X, name, Save) is pinned ABOVE the scroll,
// so it never moves with the content or the keyboard; everything else scrolls
// under it; and the editor pads for the status bar only where the modal draws
// under it (Android), never inside an iOS pageSheet.

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android', isPad: false }));
const keyboard = vi.hoisted(() => ({ height: 0 }));
type ViewMockProps = { children?: ReactNode; testID?: string; style?: unknown };
const flatten = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : ((style as Record<string, unknown>) ?? {});
vi.mock('react-native', () => ({
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) =>
    createElement('button', { onClick: disabled ? undefined : onPress, 'aria-label': accessibilityLabel }, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  View: ({ children, testID, style }: ViewMockProps) =>
    createElement(
      'div',
      { 'data-testid': testID, 'data-padding-top': flatten(style).paddingTop as number | undefined },
      children,
    ),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
  useWindowDimensions: () => ({ width: 405, height: 900 }),
  Platform: {
    get OS() {
      return platform.OS;
    },
    get isPad() {
      return platform.isPad;
    },
  },
}));
vi.mock('../../../hooks/use-keyboard-height', () => ({
  useKeyboardHeight: (enabled = true) => (enabled ? keyboard.height : 0),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0 }) }));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 48 }));
type ScrollMockProps = {
  children?: ReactNode;
  automaticallyAdjustKeyboardInsets?: boolean;
  contentContainerStyle?: { paddingBottom?: number };
};
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children, automaticallyAdjustKeyboardInsets, contentContainerStyle }: ScrollMockProps) =>
    createElement(
      'div',
      {
        'data-scroll': 'true',
        'data-keyboard-insets': automaticallyAdjustKeyboardInsets ? 'true' : undefined,
        'data-padding-bottom': contentContainerStyle?.paddingBottom,
      },
      children,
    ),
}));
// Records which namespace each lookup went through. Every other CreateDrawer
// suite mocks `t` as a bare identity, which is exactly why a key looked up in
// the wrong namespace shipped: identity returns the key, and a raw key looks
// like a rendered string to a structural assertion.
type TranslateCall = { ns: unknown; key: string; options?: Record<string, unknown> };
const translateCalls = vi.hoisted(() => [] as TranslateCall[]);
vi.mock('react-i18next', () => ({
  useTranslation: (ns?: unknown) => ({
    t: (key: string, options?: Record<string, unknown>) => {
      translateCalls.push({ ns, key, options });
      return key;
    },
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ systemColors: { secondaryBackground: '#221A33' } }),
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
}));
// The heat layer pulls in the native renderer hook and the download flow; the
// drawer's own layout is what these cases are about.
vi.mock('../../board/HeatmapOverlay', () => ({
  HeatmapOverlay: () => null,
  useHeatLayer: () => ({ cells: [], codeColors: {}, legend: { kind: 'count', edgeValues: [], total: 0 } }),
}));
vi.mock('../../board/HeatmapLegend', () => ({ HeatmapLegend: () => null }));
vi.mock('../../board/HeatmapDownloadLine', () => ({ HeatmapDownloadLine: () => null }));
vi.mock('../InteractiveCreateBoard', () => ({
  InteractiveCreateBoard: () => createElement('div', { 'data-node': 'board' }),
}));
const header = vi.hoisted(() => ({ onClose: null as (() => void) | null }));
vi.mock('../CreateDrawerHeader', () => ({
  CreateDrawerHeader: ({ onClose }: { onClose: () => void }) => {
    header.onClose = onClose;
    return createElement('div', { 'data-node': 'header' });
  },
}));
vi.mock('../CreateDrawerActionBar', () => ({
  CreateDrawerActionBar: () => createElement('div', { 'data-node': 'action-bar' }),
}));
// The lost-hold ring layer draws through react-native-svg and has its own suite.
vi.mock('../LostHoldGhostLayer', () => ({ LostHoldGhostLayer: () => null }));
vi.mock('../CreateDrawerForm', () => ({ CreateDrawerForm: () => createElement('div', { 'data-node': 'form' }) }));
vi.mock('../OpenDraftsSection', () => ({ OpenDraftsSection: () => createElement('div', { 'data-node': 'drafts' }) }));
vi.mock('../InlineConfirmBanner', () => ({
  InlineConfirmBanner: () => createElement('div', { 'data-node': 'confirm-banner' }),
}));
vi.mock('../DuplicateBanner', () => ({
  DuplicateBanner: () => createElement('div', { 'data-node': 'duplicate-banner' }),
}));
vi.mock('../NameRequiredHint', () => ({
  NameRequiredHint: () => createElement('div', { 'data-node': 'name-required-hint' }),
}));
// The real slot mounts PlaybackControls at 2+ frames, which drags Reanimated and
// a GestureDetector into jsdom. What matters here is only WHERE it sits.
vi.mock('../CreateRoutePlaybackSlot', () => ({
  CreateRoutePlaybackSlot: () => createElement('div', { 'data-node': 'route-slot' }),
}));

import { CreateDrawer } from '../CreateDrawer';

const board = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
const boardHolds = { holdTargets: [], boardWidth: 650, boardHeight: 1000 };

type Controller = Parameters<typeof CreateDrawer>[0]['controller'];

function makeController(overrides: Record<string, unknown>): Controller {
  return {
    name: '',
    setName: vi.fn(),
    startingCount: 0,
    finishCount: 0,
    focusNameSignal: 0,
    bleConnected: false,
    bleConnecting: false,
    handleToggleBle: vi.fn(),
    litUpHoldsMap: {},
    handlePaint: vi.fn(),
    selectedBrush: 'HAND',
    setSelectedBrush: vi.fn(),
    canUndo: false,
    canRedo: false,
    undo: vi.fn(),
    redo: vi.fn(),
    handleClearHolds: vi.fn(),
    handleNewClimb: vi.fn(),
    supportsMultiFrame: true,
    frameCount: 1,
    currentFrameIndex: 0,
    duplicateFrame: vi.fn(),
    deleteFrame: vi.fn(),
    handedOff: false,
    playback: {
      isPlaying: false,
      speed: 1,
      paceMs: 750,
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      setSpeed: vi.fn(),
    },
    canSetActive: false,
    handleSetActive: vi.fn(),
    saveState: 'ready',
    handleSave: vi.fn(),
    publishBlocked: false,
    draftStatus: null,
    pendingNewClimb: false,
    confirmNewClimb: vi.fn(),
    cancelNewClimb: vi.fn(),
    publishDuplicateError: null,
    dismissDuplicateError: vi.fn(),
    description: '',
    setDescription: vi.fn(),
    noMatch: false,
    setNoMatch: vi.fn(),
    isDraft: true,
    setIsDraft: vi.fn(),
    setShowAllHolds: vi.fn(),
    ...overrides,
  } as unknown as Controller;
}

function renderDrawer(overrides: Record<string, unknown>, onClose: () => void = vi.fn()) {
  const { container } = render(
    createElement(CreateDrawer, {
      board,
      controller: makeController(overrides),
      boardHolds,
      onLongPressHold: vi.fn(),
      onLoadDraft: vi.fn(),
      onClose,
      onViewDuplicate: vi.fn(),
    }),
  );
  const scroll = container.querySelector('[data-scroll="true"]');
  return {
    container,
    scroll,
    node: (name: string) => container.querySelector(`[data-node="${name}"]`),
    scrolls: (name: string) => scroll?.contains(container.querySelector(`[data-node="${name}"]`)) ?? false,
  };
}

describe('CreateDrawer as a full-height modal', () => {
  beforeEach(() => {
    translateCalls.length = 0;
    platform.OS = 'ios';
    platform.isPad = false;
    keyboard.height = 0;
  });

  it('pins the top bar above the scroll, and scrolls the board, tools, form and drafts under it', () => {
    const result = renderDrawer({});
    expect(result.node('header')).toBeTruthy();
    expect(result.scrolls('header')).toBe(false);
    for (const name of ['board', 'route-slot', 'action-bar', 'form', 'drafts']) {
      expect(result.scrolls(name), name).toBe(true);
    }
  });

  it('hands the header X the route close, so leaving goes through the screen', () => {
    const onClose = vi.fn();
    renderDrawer({}, onClose);
    header.onClose?.();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('puts the transient banners in the scroll, under the pinned bar', () => {
    const confirm = renderDrawer({ pendingNewClimb: true });
    expect(confirm.scrolls('confirm-banner')).toBe(true);
    const duplicate = renderDrawer({
      publishDuplicateError: { existingClimbUuid: 'x', existingClimbName: 'Other climb' },
    });
    expect(duplicate.scrolls('duplicate-banner')).toBe(true);
    const hint = renderDrawer({ nameMissingHint: true });
    expect(hint.scrolls('name-required-hint')).toBe(true);
  });

  it('lets iOS lift the scroll over the keyboard', () => {
    expect(renderDrawer({}).scroll?.getAttribute('data-keyboard-insets')).toBe('true');
  });

  it('starts inside the iPad editing card below the status bar', () => {
    platform.isPad = true;
    const { container } = renderDrawer({});
    expect(container.firstElementChild?.getAttribute('data-padding-top')).toBe('0');
  });

  it('pads the scroll by the keyboard on Android, on top of the window inset', () => {
    platform.OS = 'android';
    keyboard.height = 300;
    // 48 window inset + 16 + 300: RN's height already leaves out the nav bar.
    expect(renderDrawer({}).scroll?.getAttribute('data-padding-bottom')).toBe('364');
  });

  it('leaves the keyboard to iOS, which lifts the scroll itself', () => {
    keyboard.height = 300;
    expect(renderDrawer({}).scroll?.getAttribute('data-padding-bottom')).toBe('64');
  });

  it('adds no status-bar inset inside an iPhone pageSheet, which already starts below it', () => {
    const { container } = renderDrawer({});
    expect(container.firstElementChild?.getAttribute('data-padding-top')).toBe('0');
  });

  it('clears the status bar on Android, where the full-screen dialog draws under it', () => {
    platform.OS = 'android';
    const { container } = renderDrawer({});
    expect(container.firstElementChild?.getAttribute('data-padding-top')).toBe('24');
  });

  it('looks the wall-state chip up in the session namespace it actually lives in', () => {
    // `playView.wallState.onWall` is in session.json; every other key this file
    // renders is in climbs.json. It used to be read through
    // `useTranslation(['climbs', 'session'])`, and with an ARRAY i18next resolves
    // against the first namespace only — so the chip rendered the raw key on a
    // real device while every identity-`t` test stayed green.
    // `pendingNewClimb` too, so this render exercises a climbs key and the one
    // session key side by side — otherwise the climbs half below asserts nothing.
    renderDrawer({ handedOff: true, pendingNewClimb: true });

    const namespaceFor = (key: string) => {
      const call = translateCalls.find((entry) => entry.key === key);
      expect(call, `no lookup recorded for ${key}`).toBeTruthy();
      // Either shape is correct — a `session`-scoped hook or an explicit ns
      // option. What must never hold again is a lookup that only reaches climbs.
      return call?.options?.ns ?? call?.ns;
    };

    expect(namespaceFor('playView.wallState.onWall')).toBe('session');
    // ...and the keys that DO live in climbs must not drift the other way.
    expect(namespaceFor('createClimbForm.dismiss')).toBe('climbs');
    expect(namespaceFor('mobile.create.newClimb.confirm.title')).toBe('climbs');
  });

  it('renders no wall-state chip while the creator still drives the wall', () => {
    renderDrawer({ handedOff: false });
    expect(translateCalls.some((call) => call.key === 'playView.wallState.onWall')).toBe(false);
  });
});

// This suite exercises the existing flow before the server privacy rollout.
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({ usePrivacySettings: () => ({ data: undefined }) }));
vi.mock('../../privacy/PublicationAudiencePicker', () => ({
  PublicationAudiencePicker: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../../privacy/ContentAudienceControl', () => ({
  ContentAudienceControl: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../../privacy/ResourcePrivacyControl', () => ({
  ResourcePrivacyControl: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../../privacy/AudiencePicker', () => ({
  AudiencePicker: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../../privacy/use-publication-audience', () => ({
  usePublicationAudience: () => ({
    enabled: false,
    isPrivate: false,
    audience: 'public',
    publication: undefined,
    chooseAudience: () => {},
  }),
}));

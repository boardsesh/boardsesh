// @vitest-environment jsdom
//
// The real `BoardForm`, for the one thing no other suite can see: where it draws
// the slots a spray wall's edit screen hands it. Every suite that mounts create
// or edit stubs the whole form, so the owner's "Help train hold finding" switch
// (SW-20, #5471) could be dropped from it, or left reachable in only one of the
// two visibility modes, with every other test still green.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, useImperativeHandle, type ComponentProps, type ReactNode, type Ref } from 'react';

type Children = { children?: ReactNode };

/** The privacy rollout: off (no answer or `enabled: false`) or on. */
const privacy = vi.hoisted(() => ({
  settings: undefined as { enabled: boolean; isPrivate: boolean } | undefined,
}));
const quantumCatalog = vi.hoisted(() => ({ ready: false, selectedGeometryReady: false, boardOptions: [] as string[] }));
const quantumAngles = vi.hoisted(() => ({
  data: undefined as { angle: number }[] | undefined,
  isSuccess: false,
  isPending: true,
  isFetching: false,
}));
const headerActions = vi.hoisted(() => ({ trailingDisabled: false }));
vi.mock('../../../lib/quantum-geometry-store', () => ({
  useHasCompleteQuantumGeometryCatalog: () => quantumCatalog.ready,
  useQuantumGeometry: (layoutId: number, sizeId: number, enabled: boolean) =>
    quantumCatalog.selectedGeometryReady && enabled
      ? { layoutId, sizeId, revision: 'test', edgeLeft: 0, edgeRight: 10, edgeBottom: 0, edgeTop: 10, placements: [] }
      : null,
}));
const platform = vi.hoisted(() => ({ OS: 'ios' }));
const keyboard = vi.hoisted(() => ({ height: 0 }));
const scroll = vi.hoisted(() => ({
  revealInput: vi.fn(),
  focusedInput: undefined as object | undefined,
  contentSizeChanged: undefined as (() => void) | undefined,
}));

vi.mock('../../../lib/graphql/hooks', () => ({ useAngles: () => quantumAngles }));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 56 }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn() }),
  useNavigation: () => ({ getState: () => ({ index: 1 }) }),
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Platform: platform,
  TextInput: { State: { currentlyFocusedInput: () => scroll.focusedInput } },
  // `src/theme/colors` resolves the iOS palette at import time.
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  KeyboardAvoidingView: ({ children }: Children) => createElement('div', null, children),
  ScrollView: ({
    children,
    contentContainerStyle,
    ref,
    onFocus,
    onBlur,
    onContentSizeChange,
  }: Children & {
    contentContainerStyle: { paddingBottom?: number }[];
    ref: Ref<{ scrollResponderScrollNativeHandleToKeyboard: typeof scroll.revealInput }>;
    onFocus?: () => void;
    onBlur?: () => void;
    onContentSizeChange?: () => void;
  }) => {
    useImperativeHandle(ref, () => ({ scrollResponderScrollNativeHandleToKeyboard: scroll.revealInput }));
    scroll.contentSizeChanged = onContentSizeChange;
    return createElement(
      'div',
      { 'data-padding-bottom': Object.assign({}, ...contentContainerStyle).paddingBottom, onFocus, onBlur },
      children,
    );
  },
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#111', secondaryLabel: '#888', tertiaryLabel: '#666' } }),
}));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({
  usePrivacySettings: () => ({ data: privacy.settings }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 48 }),
}));
vi.mock('../../../hooks/use-keyboard-height', () => ({
  useKeyboardHeight: (enabled: boolean) => (enabled ? keyboard.height : 0),
}));
vi.mock('../../../hooks/use-header-actions', () => ({
  useHeaderActions: ({ trailing }: { trailing: { disabled: boolean } }) => {
    headerActions.trailingDisabled = trailing.disabled;
  },
}));
vi.mock('../../../hooks/use-transparent-header-inset', () => ({ useTransparentHeaderInset: () => 0 }));
vi.mock('../../../lib/boards/use-foreign-serial-board', () => ({ useForeignSerialBoard: () => null }));
vi.mock('../../../lib/board-details', () => ({ getBoardRenderDimensions: () => null }));
vi.mock('../../../lib/use-board-render-data', () => ({ useBoardRenderData: () => null }));
vi.mock('../../../lib/spray/use-spray-wall-token', () => ({ useSprayWallToken: () => '' }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: Children) => createElement('div', null, children),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../BoardImageNative', () => ({ BoardImageNative: () => null }));
vi.mock('../../play-drawer/AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));
vi.mock('../../ble/TimerPairingSheet', () => ({ TimerPairingSheet: () => null }));
vi.mock('../GymPickerSheet', () => ({ GymPickerSheet: () => null }));
// The gym-location warning has its own hook coverage; these tests exercise form slots.
vi.mock('../OwnPublicGymWarning', () => ({ OwnPublicGymWarning: () => null }));
vi.mock('../BoardConfigChips', () => ({
  BoardConfigChips: ({ groupLabel, options }: { groupLabel: string; options: { key: string }[] }) => {
    if (groupLabel === 'mobile.custom.board') quantumCatalog.boardOptions = options.map((option) => option.key);
    return null;
  },
}));
vi.mock('../../privacy/AudiencePicker', () => ({ AudiencePicker: () => null, BOARD_AUDIENCES: [] }));
// The two controls that say who sees the wall, one per mode, as markers.
vi.mock('../../privacy/ResourcePrivacyControl', () => ({
  ResourcePrivacyControl: () => createElement('div', { 'data-testid': 'privacy-control' }),
}));
vi.mock('../BoardMetaFields', () => ({
  BoardIdentityFields: () => createElement('div', { 'data-testid': 'identity' }),
  BoardVisibilityFields: () => null,
  BuilderTextInput: () => null,
  SectionLabel: () => null,
  SprayWallVisibilityField: () => createElement('div', { 'data-testid': 'spray-visibility' }),
}));

import { BoardForm } from '../BoardForm';

type BoardFormProps = ComponentProps<typeof BoardForm>;

/** A board that is already built, as the edit screen's builder holds it. */
function builderFor(boardName: string): BoardFormProps['builder'] {
  return {
    boardName,
    layoutId: boardName === 'quantum' ? 9101 : 4242,
    sizeId: boardName === 'quantum' ? 9201 : 4242,
    setIds: [1],
    serialNumber: '',
    layouts: [],
    sizes: [],
    sets: [],
    angles: [],
    canCreate: true,
    setCatalogAngleOptions: vi.fn(),
    selectedGym: null,
    coords: null,
    isPublic: false,
  } as unknown as BoardFormProps['builder'];
}

function formFor(boardName: string, withLedSection = false, builder = builderFor(boardName)) {
  return (
    <BoardForm
      builder={builder}
      defaultName="Garage wall"
      submitting={false}
      onSubmit={() => {}}
      submitLabel="Save"
      currentBoardUuid="board-uuid"
      sprayTrainingSection={<div data-testid="training" />}
      sprayBackgroundSection={<div data-testid="background" />}
      sprayLedSection={
        withLedSection ? (
          <div data-testid="led-settings">
            <input aria-label="WLED URL" />
            <input aria-label="Other field" />
          </div>
        ) : undefined
      }
    />
  );
}

function renderForm(boardName: string, withLedSection = false) {
  return render(formFor(boardName, withLedSection));
}

/** The marked sections, in the order the form draws them. */
function drawnSections(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid]')].map((element) => element.getAttribute('data-testid') ?? '');
}

beforeEach(() => {
  privacy.settings = undefined;
  quantumCatalog.ready = false;
  quantumCatalog.selectedGeometryReady = false;
  quantumCatalog.boardOptions = [];
  quantumAngles.data = undefined;
  quantumAngles.isSuccess = false;
  quantumAngles.isPending = true;
  quantumAngles.isFetching = false;
  headerActions.trailingDisabled = false;
  platform.OS = 'ios';
  keyboard.height = 0;
  scroll.focusedInput = undefined;
  scroll.revealInput.mockClear();
});

describe('BoardForm keyboard clearance', () => {
  it('reveals the focused URL after keyboard padding is laid out and follows focus changes', () => {
    platform.OS = 'android';
    const view = renderForm('spray', true);
    const urlInput = view.getByLabelText('WLED URL');
    scroll.focusedInput = urlInput;
    fireEvent.focus(urlInput);
    expect(scroll.revealInput).not.toHaveBeenCalled();

    keyboard.height = 300;
    view.rerender(formFor('spray', true));
    scroll.contentSizeChanged?.();
    expect(scroll.revealInput).toHaveBeenLastCalledWith(urlInput, 72, true);

    const otherInput = view.getByLabelText('Other field');
    fireEvent.blur(urlInput);
    scroll.focusedInput = otherInput;
    fireEvent.focus(otherInput);
    expect(scroll.revealInput).toHaveBeenLastCalledWith(otherInput, 72, true);

    fireEvent.blur(otherInput);
    scroll.revealInput.mockClear();
    scroll.contentSizeChanged?.();
    expect(scroll.revealInput).not.toHaveBeenCalled();
  });

  it.each([
    ['android', 300, 348],
    ['android', 0, 48],
    ['ios', 300, 48],
  ])('keeps the LED field scrollable on %s with keyboard height %i', (os, height, padding) => {
    platform.OS = os;
    keyboard.height = height;
    const { container } = renderForm('spray', true);
    expect(container.querySelector('[data-padding-bottom]')?.getAttribute('data-padding-bottom')).toBe(String(padding));
  });
});

describe('BoardForm on a spray wall: Help train hold finding', () => {
  it('draws the switch right under the three-way visibility control', () => {
    const { container } = renderForm('spray');
    expect(drawnSections(container)).toEqual(['identity', 'spray-visibility', 'training', 'background']);
  });

  it('draws it the same way while the privacy rollout says off', () => {
    privacy.settings = { enabled: false, isPrivate: false };
    const { container } = renderForm('spray');
    expect(drawnSections(container)).toEqual(['identity', 'spray-visibility', 'training', 'background']);
  });

  it('still draws it once the privacy rollout replaces that control, directly above the audience control', () => {
    privacy.settings = { enabled: true, isPrivate: false };
    const { container } = renderForm('spray');
    expect(drawnSections(container)).toEqual(['identity', 'background', 'training', 'privacy-control']);
  });
});

describe('BoardForm fixed Quantum catalogue', () => {
  it('offers the shipped board while catalogue angles are still loading', () => {
    const builder = { ...builderFor('quantum'), canCreate: false };
    render(formFor('quantum', false, builder));
    expect(quantumCatalog.boardOptions).toContain('quantum');
    expect(headerActions.trailingDisabled).toBe(true);
  });

  it('allows a complete fixed setup without a geometry download and rejects mismatched sizes', () => {
    const builder = builderFor('quantum');
    const view = render(formFor('quantum', false, builder));
    expect(headerActions.trailingDisabled).toBe(false);
    expect(view.queryByText('mobile.create.geometryLoading')).toBeNull();
    view.rerender(formFor('quantum', false, { ...builder, layoutId: 9104, sizeId: 9201 }));
    expect(headerActions.trailingDisabled).toBe(true);
  });

  it('clears observed catalog angles when the selected layout or board changes', () => {
    const builder = builderFor('quantum');
    quantumAngles.data = [{ angle: 20 }, { angle: 40 }];
    quantumAngles.isSuccess = true;
    const view = render(formFor('quantum', false, builder));
    expect(builder.setCatalogAngleOptions).toHaveBeenLastCalledWith([20, 40]);
    quantumAngles.data = undefined;
    quantumAngles.isSuccess = false;
    view.rerender(formFor('quantum', false, { ...builder, layoutId: 9104, sizeId: 9204 }));
    expect(builder.setCatalogAngleOptions).toHaveBeenLastCalledWith([]);
    quantumAngles.data = [{ angle: 25 }];
    quantumAngles.isSuccess = true;
    view.rerender(formFor('quantum', false, { ...builder, layoutId: 9104, sizeId: 9204 }));
    expect(builder.setCatalogAngleOptions).toHaveBeenLastCalledWith([25]);
    view.rerender(formFor('kilter', false, { ...builder, boardName: 'kilter' }));
    expect(builder.setCatalogAngleOptions).toHaveBeenLastCalledWith([]);
  });

  it('offers each shipped board only once', () => {
    renderForm('kilter');
    expect(quantumCatalog.boardOptions.filter((boardName) => boardName === 'quantum')).toHaveLength(1);
  });
});

describe('BoardForm on a catalogue board', () => {
  it('draws neither spray slot, whichever way the privacy rollout stands', () => {
    const off = renderForm('kilter');
    expect(drawnSections(off.container)).toEqual(['identity']);
    off.unmount();

    privacy.settings = { enabled: true, isPrivate: false };
    const on = renderForm('kilter');
    expect(drawnSections(on.container)).toEqual(['identity', 'privacy-control']);
  });
});

describe('BoardForm spray wall LED placement', () => {
  it.each([false, true])('places LED directly above More options with privacy enabled=%s', (enabled) => {
    privacy.settings = { enabled, isPrivate: false };
    const view = renderForm('spray', true);
    const ledSection = view.getByTestId('led-settings');
    const moreOptionsHeader = view.getByText('mobile.create.moreOptions').parentElement;
    expect(ledSection.nextElementSibling).toBe(moreOptionsHeader);
  });

  it('never renders the LED section for catalogue boards, even when supplied', () => {
    const view = renderForm('kilter', true);
    expect(view.queryByTestId('led-settings')).toBeNull();
  });
});

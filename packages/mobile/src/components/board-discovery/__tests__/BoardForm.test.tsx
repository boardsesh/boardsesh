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
const platform = vi.hoisted(() => ({ OS: 'ios' }));
const keyboard = vi.hoisted(() => ({ height: 0 }));
const scroll = vi.hoisted(() => ({
  revealInput: vi.fn(),
  focusedInput: undefined as object | undefined,
  contentSizeChanged: undefined as (() => void) | undefined,
}));

const pushMock = vi.hoisted(() => vi.fn());
/** What the restyled form handed its setup rows, and the gym lock its identity fields got. */
const setupRows = vi.hoisted(() => ({
  last: null as null | {
    rows: { label: string; options: { label: string }[]; onSelectIndex: (index: number) => void; listField?: string }[];
    onOpenList: (field: string) => void;
  },
  gymLocked: undefined as boolean | undefined,
}));

vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 56 }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: pushMock }),
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
vi.mock('../../../hooks/use-header-actions', () => ({ useHeaderActions: () => {} }));
vi.mock('../../../hooks/use-transparent-header-inset', () => ({ useTransparentHeaderInset: () => 0 }));
vi.mock('../../../lib/boards/use-foreign-serial-board', () => ({ useForeignSerialBoard: () => null }));
vi.mock('../../../lib/board-details', () => ({ getBoardRenderData: () => null }));
vi.mock('../../../lib/spray/use-spray-wall-token', () => ({ useSprayWallToken: () => '' }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: Children) => createElement('div', null, children),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({ label }: { label: string }) => createElement('span', null, label),
}));
vi.mock('../../BoardImageNative', () => ({ BoardImageNative: () => null }));
vi.mock('../../play-drawer/AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));
vi.mock('../../ble/TimerPairingSheet', () => ({ TimerPairingSheet: () => null }));
// The gym row pushes a route; its own suite covers the handoff.
vi.mock('../../../lib/boards/use-gym-picker-route', () => ({ useGymPickerRoute: () => () => undefined }));
// The gym-location warning has its own hook coverage; these tests exercise form slots.
vi.mock('../OwnPublicGymWarning', () => ({ OwnPublicGymWarning: () => null }));
// A marker per chip row, by its label, so a test can see which rows are drawn.
vi.mock('../BoardConfigChips', () => ({
  BoardConfigChips: ({ groupLabel }: { groupLabel: string }) => createElement('div', { 'data-chips': groupLabel }),
}));
vi.mock('../BoardHoldsSummary', () => ({
  BoardHoldsSummary: ({ onToggleExpanded }: { onToggleExpanded: () => void }) =>
    createElement('button', { type: 'button', 'data-holds-summary': true, onClick: onToggleExpanded }),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, title),
}));
vi.mock('../../privacy/AudiencePicker', () => ({ AudiencePicker: () => null, BOARD_AUDIENCES: [] }));
// The two controls that say who sees the wall, one per mode, as markers.
vi.mock('../../privacy/ResourcePrivacyControl', () => ({
  ResourcePrivacyControl: () => createElement('div', { 'data-testid': 'privacy-control' }),
}));
vi.mock('../BoardSetupRows', () => ({
  BoardSetupRows: (props: NonNullable<(typeof setupRows)['last']>) => {
    setupRows.last = props;
    return createElement('div', { 'data-setup-rows': props.rows.map((row) => row.label).join(',') });
  },
}));
vi.mock('../../spray-wall/StepCounter', () => ({
  StepCounter: ({ label }: { label: string }) => createElement('p', { 'data-step-counter': true }, label),
}));
vi.mock('../BoardMetaFields', () => ({
  BoardIdentityFields: ({ gymLocked }: { gymLocked?: boolean }) => {
    setupRows.gymLocked = gymLocked;
    return createElement('div', { 'data-testid': 'identity' });
  },
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
    layoutId: 4242,
    sizeId: 4242,
    setIds: [1],
    serialNumber: '',
    layouts: [],
    sizes: [],
    sets: [],
    angles: [],
    canCreate: true,
    selectedGym: null,
    coords: null,
    isPublic: false,
  } as unknown as BoardFormProps['builder'];
}

function formFor(boardName: string, withLedSection = false) {
  return (
    <BoardForm
      builder={builderFor(boardName)}
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

describe('BoardForm hold sets and catalogue errors (#8151)', () => {
  const toggleSet = vi.fn();
  function catalogueBuilder(): BoardFormProps['builder'] {
    return {
      ...builderFor('moonboard'),
      layoutId: 5,
      sizeId: 1,
      setIds: [17, 18, 99],
      layouts: [{ id: 5, name: 'MoonBoard Masters 2019' }],
      sizes: [{ id: 1, name: 'Standard' }],
      sets: [
        { id: 17, name: 'Hold Set A' },
        { id: 18, name: 'Hold Set B' },
        { id: 20, name: 'Screw-on Feet' },
      ],
      toggleSet,
    } as unknown as BoardFormProps['builder'];
  }
  function renderCatalogue(configError: BoardFormProps['configError'] = null, lockedConfig = false) {
    return render(
      <BoardForm
        builder={catalogueBuilder()}
        defaultName="Gym MoonBoard"
        submitting={false}
        onSubmit={() => {}}
        submitLabel="Save"
        configError={configError}
        lockedConfig={lockedConfig}
      />,
    );
  }
  const setChips = (container: HTMLElement) => container.querySelector('[data-chips="mobile.custom.sets"]');

  beforeEach(() => toggleSet.mockClear());

  it('draws the holds summary in the main form, and the set chips under it on Change', () => {
    const { container } = renderCatalogue();
    expect(container.querySelector('[data-holds-summary]')).not.toBeNull();
    // Not behind More options any more, and closed until asked for.
    expect(setChips(container)).toBeNull();
    fireEvent.click(container.querySelector('[data-holds-summary]')!);
    expect(setChips(container)).not.toBeNull();
  });

  it("keeps a locked setup's sets in view, since it has no Change", () => {
    const { container } = renderCatalogue(null, true);
    expect(setChips(container)).not.toBeNull();
  });

  it.each([
    ['boardType', 'mobile.create.configError.boardType'],
    ['layoutId', 'mobile.create.configError.layoutId'],
    ['sizeId', 'mobile.create.configError.sizeId'],
  ] as const)('says a refused %s under its row', (field, message) => {
    const { getByText } = renderCatalogue({ field, invalidSetIds: [] });
    expect(getByText(message)).toBeTruthy();
  });

  it('opens the set chips for refused sets, and removes the picked ones in one tap', () => {
    const { container, getByText } = renderCatalogue({ field: 'setIds', invalidSetIds: [99, 404] });
    expect(getByText('mobile.create.configError.setIds')).toBeTruthy();
    expect(setChips(container)).not.toBeNull();
    fireEvent.click(getByText('mobile.create.configError.removeSets'));
    // Only the refused set still picked: 404 isn't in the setup.
    expect(toggleSet.mock.calls).toEqual([[99]]);
  });
});

// The serial the In range slot heard lives under More options; the form says it
// above the fold, and Change opens More options to it.
describe('BoardForm with a heard serial', () => {
  function renderHeard(heardSerial: string | null) {
    return render(
      <BoardForm
        builder={{ ...builderFor('kilter'), serialNumber: heardSerial ?? '', heardSerial } as BoardFormProps['builder']}
        defaultName="Home Kilter"
        submitting={false}
        onSubmit={() => {}}
        submitLabel="Save"
      />,
    );
  }

  it('says the serial above More options, and Change opens it', () => {
    const view = renderHeard('751737');
    expect(view.getByText('mobile.create.heardSerial')).toBeTruthy();
    expect(view.queryByText('mobile.create.timerPairCta')).toBeNull();
    fireEvent.click(view.getByText('mobile.create.heardSerialChange'));
    expect(view.getByText('mobile.create.timerPairCta')).toBeTruthy();
  });

  it('says nothing when no serial was heard', () => {
    const view = renderHeard(null);
    expect(view.queryByText('mobile.create.heardSerial')).toBeNull();
    expect(view.queryByText('mobile.create.heardSerialChange')).toBeNull();
  });
});

// The add-a-board wizard's Set up (`setupStyle="rows"`): Board, Layout and Size
// as rows (a menu, or the pushed checklist past eight options), the chips kept
// for Holds only, the gym locked when the wizard picked it.
describe("BoardForm restyled as the wizard's Set up", () => {
  const selectBoard = vi.fn();
  const selectLayout = vi.fn();
  const selectSize = vi.fn();
  function rowsBuilder(): BoardFormProps['builder'] {
    return {
      ...builderFor('kilter'),
      layoutId: 8,
      sizeId: 25,
      setIds: [26, 27],
      layouts: [
        { id: 1, name: 'Kilter Board Original' },
        { id: 8, name: 'Kilter Board Homewall' },
      ],
      sizes: [
        { id: 25, name: '10 x 12', description: 'Full Ride' },
        { id: 27, name: '8 x 12', description: 'Mainline' },
      ],
      sets: [{ id: 26, name: 'Mainline' }],
      selectBoard,
      selectLayout,
      selectSize,
    } as unknown as BoardFormProps['builder'];
  }
  function renderRows(props: Partial<BoardFormProps> = {}) {
    return render(
      <BoardForm
        builder={rowsBuilder()}
        defaultName="Home Kilter"
        submitting={false}
        onSubmit={() => {}}
        submitLabel="Save"
        setupStyle="rows"
        {...props}
      />,
    );
  }
  function rows() {
    if (!setupRows.last) throw new Error('no setup rows');
    return setupRows.last;
  }

  beforeEach(() => {
    setupRows.last = null;
    setupRows.gymLocked = undefined;
    pushMock.mockClear();
    selectBoard.mockClear();
    selectLayout.mockClear();
    selectSize.mockClear();
  });

  it('draws Board, Layout and Size as rows, and chips for nothing but the holds', () => {
    const { container } = renderRows();
    expect(container.querySelector('[data-setup-rows]')?.getAttribute('data-setup-rows')).toBe(
      'mobile.custom.board,mobile.custom.layout,mobile.custom.size',
    );
    expect(container.querySelector('[data-chips="mobile.custom.board"]')).toBeNull();
    expect(container.querySelector('[data-chips="mobile.custom.layout"]')).toBeNull();
    expect(container.querySelector('[data-chips="mobile.custom.size"]')).toBeNull();
    expect(container.querySelector('[data-holds-summary]')).not.toBeNull();
    // Only Layout and Size can grow past a menu's eight options.
    expect(rows().rows.map((row) => row.listField ?? null)).toEqual([null, 'layout', 'size']);
  });

  it('keeps the chip rows with the default style (the flag off, and the edit screen)', () => {
    const { container } = render(
      <BoardForm builder={rowsBuilder()} defaultName="x" submitting={false} onSubmit={() => {}} submitLabel="Save" />,
    );
    expect(container.querySelector('[data-setup-rows]')).toBeNull();
    expect(container.querySelector('[data-chips="mobile.custom.layout"]')).not.toBeNull();
  });

  it('picks from a menu by the index of the option it drew', () => {
    renderRows();
    const [boardRow, layoutRow, sizeRow] = rows().rows;
    layoutRow?.onSelectIndex(0);
    expect(selectLayout).toHaveBeenCalledExactlyOnceWith(1);
    sizeRow?.onSelectIndex(1);
    expect(selectSize).toHaveBeenCalledExactlyOnceWith(27);
    boardRow?.onSelectIndex(99);
    expect(selectBoard).not.toHaveBeenCalled();
  });

  it('pushes the checklist for a long row, and takes the pick it hands back', async () => {
    const { emitSetupOptionPick } = await import('../../../lib/boards/setup-option-handoff');
    renderRows();
    rows().onOpenList('size');
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [{ pathname, params }] = pushMock.mock.calls[0] as [{ pathname: string; params: Record<string, string> }];
    expect(pathname).toBe('/boards/add/setup-option');
    expect(params).toMatchObject({ field: 'size', boardType: 'kilter', layoutId: '8', selected: '25' });

    emitSetupOptionPick(params.handoffId ?? '', { field: 'size', value: 27 });
    expect(selectSize).toHaveBeenCalledExactlyOnceWith(27);
    // Another form's address gets nothing.
    emitSetupOptionPick('setup-option-elsewhere', { field: 'layout', value: 1 });
    expect(selectLayout).not.toHaveBeenCalled();
  });

  it('says the step above the art, and hands the gym lock to the identity fields', () => {
    const { container } = renderRows({ stepLabel: 'Step 4 of 4', gymLocked: true });
    expect(container.querySelector('[data-step-counter]')?.textContent).toBe('Step 4 of 4');
    expect(setupRows.gymLocked).toBe(true);
  });
});

// @vitest-environment jsdom
//
// The real `BoardForm`, for the one thing no other suite can see: where it draws
// the slots a spray wall's edit screen hands it. Every suite that mounts create
// or edit stubs the whole form, so the owner's "Help train hold finding" switch
// (SW-20, #5471) could be dropped from it, or left reachable in only one of the
// two visibility modes, with every other test still green.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ComponentProps, type ReactNode } from 'react';

type Children = { children?: ReactNode };

/** The privacy rollout: off (no answer or `enabled: false`) or on. */
const privacy = vi.hoisted(() => ({
  settings: undefined as { enabled: boolean; isPrivate: boolean } | undefined,
}));

vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn() }),
  useNavigation: () => ({ getState: () => ({ index: 1 }) }),
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Platform: { OS: 'ios' },
  // `src/theme/colors` resolves the iOS palette at import time.
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  KeyboardAvoidingView: ({ children }: Children) => createElement('div', null, children),
  ScrollView: ({ children }: Children) => createElement('div', null, children),
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
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
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
vi.mock('../../BoardImageNative', () => ({ BoardImageNative: () => null }));
vi.mock('../../play-drawer/AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));
vi.mock('../../ble/TimerPairingSheet', () => ({ TimerPairingSheet: () => null }));
vi.mock('../GymPickerSheet', () => ({ GymPickerSheet: () => null }));
vi.mock('../BoardConfigChips', () => ({ BoardConfigChips: () => null }));
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

function renderForm(boardName: string) {
  return render(
    <BoardForm
      builder={builderFor(boardName)}
      defaultName="Garage wall"
      submitting={false}
      onSubmit={() => {}}
      submitLabel="Save"
      currentBoardUuid="board-uuid"
      sprayTrainingSection={<div data-testid="training" />}
      sprayBackgroundSection={<div data-testid="background" />}
    />,
  );
}

/** The marked sections, in the order the form draws them. */
function drawnSections(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid]')].map((element) => element.getAttribute('data-testid') ?? '');
}

beforeEach(() => {
  privacy.settings = undefined;
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

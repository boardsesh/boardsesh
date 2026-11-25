// @vitest-environment jsdom
//
// The add-a-board wizard's routes: what each step pushes, how it counts itself,
// and what it reports. The step components (GymStep, BoardTypeStep) are stubs
// that hand back their callbacks; their own suites cover what they draw.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Children = { children?: ReactNode };

const pushMock = vi.hoisted(() => vi.fn());
const dismissToMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());
const backMock = vi.hoisted(() => vi.fn());
const headerActions = vi.hoisted(() => ({
  leading: undefined as null | undefined | { kind: string; onPress: () => void },
}));
const wallList = vi.hoisted(() => ({ last: null as null | { gymUuid: string; entry: string } }));
const trackMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  signedIn: true,
  focusEffects: [] as Array<() => void>,
  /** The screen's index in its stack: 0 is the stack's first screen. */
  stackIndex: 1,
  /** What `useSteppedBackInWizard` would find: the climber went Back to a wizard step. */
  steppedBack: false,
}));
const gymStep = vi.hoisted(() => ({
  last: null as null | {
    stepLabel?: string;
    initialBoardType: string | null;
    onPickGym: (gym: { uuid: string }, boardType: string | null) => void;
    onAddGym: (boardType: string | null) => void;
  },
}));
const newGymStep = vi.hoisted(() => ({
  last: null as null | {
    stepLabel: string | null;
    onPickExistingGym: (gymUuid: string) => void;
    onClaimGym: (gymUuid: string) => void;
    onCreated: (gym: { uuid: string }) => void;
    onSignInNeeded: () => void;
    onSubmittingChange: (submitting: boolean) => void;
  },
}));
const navigationState = vi.hoisted(() => ({
  preventRemove: [] as boolean[],
  options: [] as Array<Record<string, unknown>>,
  focused: true,
  disablePrevention: vi.fn(),
}));
const typeStep = vi.hoisted(() => ({
  last: null as null | { stepLabel: string | null; onPick: (boardName: string) => void },
}));

vi.mock('react-native', () => ({
  ScrollView: ({ children }: Children) => createElement('div', null, children),
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: pushMock, back: backMock, dismissTo: dismissToMock, replace: replaceMock }),
  useNavigation: () => ({
    getState: () => ({ index: state.stackIndex }),
    setOptions: (options: Record<string, unknown>) => navigationState.options.push(options),
  }),
  useIsFocused: () => navigationState.focused,
  usePreventRemove: (prevent: boolean) => {
    navigationState.preventRemove.push(prevent);
    return navigationState.disablePrevention;
  },
  Redirect: ({ href }: { href: { pathname: string; params: Record<string, string> } }) =>
    createElement('a', { 'data-testid': 'redirect', 'data-href': JSON.stringify(href) }),
  useLocalSearchParams: () => state.params,
  useFocusEffect: (effect: () => void) => {
    state.focusEffects.push(effect);
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
vi.mock('@boardsesh/board-config', () => ({
  toBoardName: (value: string | undefined) => (value === 'kilter' || value === 'moonboard' ? value : null),
  SUPPORTED_BOARDS: ['kilter', 'moonboard'],
}));
vi.mock('../../../src/components/board-discovery/FirstBoardChoice', () => ({
  ChoiceCard: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, title),
}));
vi.mock('../../../src/components/board-discovery/add-board-wizard/WizardStepHeader', () => ({
  WizardStepHeader: ({ title }: { title: string }) => createElement('h1', null, title),
}));
vi.mock('../../../src/components/board-discovery/gym-step/GymStep', () => ({
  GymStep: (props: NonNullable<(typeof gymStep)['last']>) => {
    gymStep.last = props;
    return null;
  },
}));
vi.mock('../../../src/components/board-discovery/new-gym-step/NewGymStep', () => ({
  NewGymStep: (props: NonNullable<(typeof newGymStep)['last']>) => {
    newGymStep.last = props;
    return null;
  },
}));
vi.mock('../../../src/components/board-discovery/add-board-wizard/BoardTypeStep', () => ({
  BoardTypeStep: (props: NonNullable<(typeof typeStep)['last']>) => {
    typeStep.last = props;
    return null;
  },
}));
vi.mock('../../../src/hooks/use-header-actions', () => ({
  useHeaderActions: ({ leading }: { leading?: null | { kind: string; onPress: () => void } }) => {
    headerActions.leading = leading;
  },
}));
vi.mock('../../../src/lib/boards/use-stepped-back-in-wizard', () => ({
  useSteppedBackInWizard: () => (report: () => void) => {
    if (!state.steppedBack) report();
  },
}));
vi.mock('../../../src/components/board-discovery/GymWallList', () => ({
  GymWallList: (props: { gymUuid: string; entry: string }) => {
    wallList.last = props;
    return null;
  },
}));
vi.mock('../../../src/lib/graphql/hooks', () => ({ usePopularBoardConfigs: () => ({ data: undefined }) }));
vi.mock('../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../src/lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: state.signedIn }) }));
vi.mock('../../../src/theme/tokens', () => ({ spacing: { 3: 12, 4: 16, 5: 20 } }));

const { default: AddBoardWhere } = await import('../add/index');
const { default: AddBoardGym } = await import('../add/gym');
const { default: AddBoardType } = await import('../add/board');
const { default: AddBoardGymBoards } = await import('../add/gym-boards');
const { default: AddBoardNewGym } = await import('../add/new-gym');

function events(name: string) {
  return trackMock.mock.calls.filter(([eventName]) => eventName === name).map(([, props]) => props);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.params = { returnTo: '/(tabs)/climbs', source: 'onboarding', entry: 'picker' };
  state.signedIn = true;
  state.focusEffects = [];
  gymStep.last = null;
  newGymStep.last = null;
  navigationState.focused = true;
  navigationState.preventRemove = [];
  navigationState.options = [];
  typeStep.last = null;
  wallList.last = null;
  headerActions.leading = undefined;
  state.stackIndex = 1;
  state.steppedBack = false;
});

describe("step 1, Where's the board?", () => {
  it('offers a gym, home and a Spraywall, and counts itself viewed with no path yet', () => {
    render(createElement(AddBoardWhere));
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'mobile.addWizard.gym',
      'mobile.addWizard.home',
      'mobile.addWizard.spray',
    ]);
    expect(events('Add Board Wizard Step Viewed')).toEqual([{ step: 'where', path: null, entry: 'picker' }]);
  });

  it('goes on to Which gym? as step 2 of the gym path', () => {
    render(createElement(AddBoardWhere));
    fireEvent.click(screen.getByText('mobile.addWizard.gym'));
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/boards/add/gym',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding', entry: 'picker', trail: 'where' },
    });
    expect(events('Board Kind Chosen')).toEqual([{ kind: 'gym', surface: 'where', preAnswered: false }]);
  });

  it('goes on to Which board? on the home path', () => {
    render(createElement(AddBoardWhere));
    fireEvent.click(screen.getByText('mobile.addWizard.home'));
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/boards/add/board',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding', entry: 'picker', trail: 'where', path: 'home' },
    });
  });

  it('hands a Spraywall to its own wizard, unchanged, and leaves the abandonment to it', () => {
    const { unmount } = render(createElement(AddBoardWhere));
    fireEvent.click(screen.getByText('mobile.addWizard.spray'));
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/boards/spray/new',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding' },
    });
    expect(events('Board Kind Chosen')).toEqual([{ kind: 'spray', surface: 'where', preAnswered: false }]);
    expect(events('Add Board Wizard Step Viewed')).toContainEqual({ step: 'spray', path: 'spray', entry: 'picker' });
    unmount();
    expect(events('Board Builder Abandoned')).toEqual([]);
  });

  it('reports leaving with no answer once, at the choice step, with its entry', () => {
    const { unmount } = render(createElement(AddBoardWhere));
    unmount();
    expect(events('Board Builder Abandoned')).toEqual([
      { kind: null, step: 'choice', openedFrom: 'onboarding', wizardEntry: 'picker', wizardPath: null, secondsOpen: 0 },
    ]);
  });

  it('names the picker it came from the way the builder does', () => {
    state.params = { entry: 'manage' };
    const { unmount } = render(createElement(AddBoardWhere));
    unmount();
    expect(events('Board Builder Abandoned')).toEqual([
      expect.objectContaining({ openedFrom: 'board_picker', wizardEntry: 'manage' }),
    ]);
  });

  it('reports again once back from the Spraywall wizard and then closed', () => {
    const { unmount } = render(createElement(AddBoardWhere));
    fireEvent.click(screen.getByText('mobile.addWizard.spray'));
    for (const effect of state.focusEffects) effect();
    unmount();
    expect(events('Board Builder Abandoned')).toHaveLength(1);
  });
});

describe('Which gym?', () => {
  beforeEach(() => {
    state.params = { ...state.params, trail: 'where' };
  });

  it('counts itself step 2 of 4 and opens a picked gym on its boards with the type chosen', () => {
    render(createElement(AddBoardGym));
    expect(gymStep.last?.stepLabel).toBe('mobile.addWizard.stepCounter {"current":2,"total":4}');
    gymStep.last?.onPickGym({ uuid: 'gym-1' }, 'kilter');
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/boards/add/gym-boards',
      params: {
        returnTo: '/(tabs)/climbs',
        source: 'onboarding',
        entry: 'picker',
        trail: 'where,gym',
        gymUuid: 'gym-1',
        boardType: 'kilter',
      },
    });
  });

  it('sends Add my gym to Add your gym, carrying the type chosen on the map', () => {
    render(createElement(AddBoardGym));
    gymStep.last?.onAddGym('moonboard');
    expect(pushMock).toHaveBeenLastCalledWith({
      pathname: '/boards/add/new-gym',
      params: {
        returnTo: '/(tabs)/climbs',
        source: 'onboarding',
        entry: 'picker',
        trail: 'where,gym',
        boardType: 'moonboard',
      },
    });
    gymStep.last?.onAddGym(null);
    const [route] = pushMock.mock.calls.at(-1) as [{ pathname: string; params: Record<string, string> }];
    expect(route.pathname).toBe('/boards/add/new-gym');
    expect(route.params).not.toHaveProperty('boardType');
    expect(route.params).not.toHaveProperty('focusLocation');
  });

  // In place of the picker: pushed from in here it stacked a second sheet.
  it('sends a signed-out climber to sign in to add a gym', () => {
    state.signedIn = false;
    render(createElement(AddBoardGym));
    gymStep.last?.onAddGym('kilter');
    expect(dismissToMock).toHaveBeenCalledExactlyOnceWith('/auth/login');
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe('Which board?', () => {
  it('opens Set up on the picked type, as the last step of the home path', () => {
    state.params = { ...state.params, trail: 'where', path: 'home' };
    render(createElement(AddBoardType));
    expect(typeStep.last?.stepLabel).toBe('mobile.addWizard.stepCounter {"current":2,"total":3}');
    typeStep.last?.onPick('moonboard');
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/boards/create',
      params: {
        returnTo: '/(tabs)/climbs',
        source: 'onboarding',
        entry: 'picker',
        trail: 'where,board',
        path: 'home',
        kind: 'home',
        preset: '1',
        presetBoardType: 'moonboard',
      },
    });
    expect(events('Add Board Wizard Step Viewed')).toEqual([{ step: 'board', path: 'home', entry: 'picker' }]);
  });

  it('carries a gym just added on to Set up, where it is locked', () => {
    state.params = { ...state.params, trail: 'where,gym,new_gym', path: 'gym', gymUuid: 'gym-new' };
    render(createElement(AddBoardType));
    expect(typeStep.last?.stepLabel).toBe('mobile.addWizard.stepCounter {"current":4,"total":5}');
    typeStep.last?.onPick('kilter');
    const [route] = pushMock.mock.calls.at(-1) as [{ pathname: string; params: Record<string, string> }];
    expect(route).toEqual({
      pathname: '/boards/create',
      params: {
        returnTo: '/(tabs)/climbs',
        source: 'onboarding',
        entry: 'picker',
        trail: 'where,gym,new_gym,board',
        path: 'gym',
        kind: 'gym',
        boardType: 'kilter',
        gymUuid: 'gym-new',
      },
    });
  });

  it('ignores a gym on the home path', () => {
    state.params = { ...state.params, trail: 'where', path: 'home', gymUuid: 'gym-new' };
    render(createElement(AddBoardType));
    typeStep.last?.onPick('kilter');
    const [route] = pushMock.mock.calls.at(-1) as [{ pathname: string; params: Record<string, string> }];
    expect(route.params).not.toHaveProperty('gymUuid');
  });
});

describe('leaving and stepping back', () => {
  it('reports nothing when Back lands on the wizard step under it', () => {
    state.params = { ...state.params, trail: 'where' };
    state.steppedBack = true;
    const { unmount } = render(createElement(AddBoardGym));
    unmount();
    expect(events('Board Builder Abandoned')).toEqual([]);
  });

  it('reports the step it left from when the wizard is closed', () => {
    state.params = { ...state.params, trail: 'where' };
    const { unmount } = render(createElement(AddBoardGym));
    unmount();
    expect(events('Board Builder Abandoned')).toEqual([expect.objectContaining({ step: 'find', kind: 'gym' })]);
  });
});

describe('a step that is the first screen of its stack', () => {
  it("gets an X that closes the modal (a gym page's Boards at {gym})", () => {
    state.stackIndex = 0;
    state.params = { entry: 'gym_page', gymUuid: 'gym-1' };
    render(createElement(AddBoardGymBoards));
    expect(headerActions.leading?.kind).toBe('close');
    headerActions.leading?.onPress();
    expect(backMock).toHaveBeenCalledOnce();
  });

  it('keeps the back chevron when there is a step under it', () => {
    state.params = { ...state.params, trail: 'where' };
    render(createElement(AddBoardGym));
    expect(headerActions.leading).toBeNull();
  });

  it("leaves step 1's own X to the layout", () => {
    state.stackIndex = 0;
    render(createElement(AddBoardWhere));
    expect(headerActions.leading).toBeNull();
  });
});

describe('Boards at {gym}', () => {
  it("opens a gym page's gym as step 1 of 2", () => {
    state.params = { entry: 'gym_page', gymUuid: 'gym-1' };
    render(createElement(AddBoardGymBoards));
    expect(wallList.last).toMatchObject({ gymUuid: 'gym-1', entry: 'gym_page' });
    expect(events('Add Board Wizard Step Viewed')).toEqual([{ step: 'gym_boards', path: 'gym', entry: 'gym_page' }]);
  });

  it('sends a link with no gym to Which gym?, logging nothing', () => {
    state.params = { entry: 'link', trail: 'where', boardType: 'kilter' };
    const { unmount } = render(createElement(AddBoardGymBoards));
    const href = JSON.parse(screen.getByTestId('redirect').getAttribute('data-href') ?? '{}') as {
      pathname: string;
      params: Record<string, string>;
    };
    expect(href).toEqual({
      pathname: '/boards/add/gym',
      params: { entry: 'link', trail: 'where', boardType: 'kilter' },
    });
    expect(wallList.last).toBeNull();
    unmount();
    expect(trackMock).not.toHaveBeenCalled();
  });
});

describe('Add your gym', () => {
  const created = { uuid: 'gym-new' };

  it('counts itself step 3 of 4 with the type known, and opens Set up with the new gym locked', () => {
    state.params = { ...state.params, trail: 'where,gym', boardType: 'kilter' };
    const { unmount } = render(createElement(AddBoardNewGym));
    expect(newGymStep.last?.stepLabel).toBe('mobile.addWizard.stepCounter {"current":3,"total":4}');
    expect(events('Add Board Wizard Step Viewed')).toEqual([{ step: 'new_gym', path: 'gym', entry: 'picker' }]);
    newGymStep.last?.onCreated(created);
    // Replaced, not pushed: Back from Set up never lands on the filled-in form.
    expect(pushMock).not.toHaveBeenCalled();
    expect(replaceMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards/create',
      params: {
        returnTo: '/(tabs)/climbs',
        source: 'onboarding',
        entry: 'picker',
        trail: 'where,gym,new_gym',
        path: 'gym',
        kind: 'gym',
        boardType: 'kilter',
        gymUuid: 'gym-new',
      },
    });
    // Set up takes the flow over: this screen going is not the climber leaving.
    unmount();
    expect(events('Board Builder Abandoned')).toEqual([]);
  });

  it('counts itself step 3 of 5 with no type, and goes on to Which board? carrying the gym', () => {
    state.params = { ...state.params, trail: 'where,gym' };
    render(createElement(AddBoardNewGym));
    expect(newGymStep.last?.stepLabel).toBe('mobile.addWizard.stepCounter {"current":3,"total":5}');
    newGymStep.last?.onCreated(created);
    expect(replaceMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards/add/board',
      params: {
        returnTo: '/(tabs)/climbs',
        source: 'onboarding',
        entry: 'picker',
        trail: 'where,gym,new_gym',
        path: 'gym',
        gymUuid: 'gym-new',
      },
    });
  });

  it("opens a gym that is already listed on its boards, as Which gym?'s pick would", () => {
    state.params = { ...state.params, trail: 'where,gym', boardType: 'moonboard' };
    render(createElement(AddBoardNewGym));
    newGymStep.last?.onPickExistingGym('gym-listed');
    expect(pushMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards/add/gym-boards',
      params: {
        returnTo: '/(tabs)/climbs',
        source: 'onboarding',
        entry: 'picker',
        trail: 'where,gym,new_gym',
        gymUuid: 'gym-listed',
        boardType: 'moonboard',
      },
    });
  });

  it("opens a listed gym's page in the Boards stack to claim it", () => {
    state.params = { ...state.params, trail: 'where,gym' };
    render(createElement(AddBoardNewGym));
    newGymStep.last?.onClaimGym('gym-listed');
    expect(pushMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards/gym/[gym]',
      params: { gym: 'gym-listed', returnTo: '/(tabs)/climbs' },
    });
  });

  it('sends a signed-out Save to sign in in place of the picker, not stacked on it', () => {
    state.params = { ...state.params, trail: 'where,gym' };
    render(createElement(AddBoardNewGym));
    newGymStep.last?.onSignInNeeded();
    expect(dismissToMock).toHaveBeenCalledExactlyOnceWith('/auth/login');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('holds the screen while a save is out, and lets it go for the hand-off', () => {
    state.params = { ...state.params, trail: 'where,gym', boardType: 'kilter' };
    navigationState.preventRemove = [];
    navigationState.options = [];
    render(createElement(AddBoardNewGym));
    expect(navigationState.preventRemove.at(-1)).toBe(false);
    act(() => newGymStep.last?.onSubmittingChange(true));
    expect(navigationState.preventRemove.at(-1)).toBe(true);
    expect(navigationState.options.at(-1)).toEqual({ gestureEnabled: false });
    act(() => newGymStep.last?.onCreated(created));
    expect(navigationState.disablePrevention).toHaveBeenCalled();
    expect(replaceMock).toHaveBeenCalledOnce();
    expect(navigationState.preventRemove.at(-1)).toBe(false);
  });

  it('frees the screen again when the save comes back refused', () => {
    state.params = { ...state.params, trail: 'where,gym' };
    navigationState.preventRemove = [];
    render(createElement(AddBoardNewGym));
    act(() => newGymStep.last?.onSubmittingChange(true));
    act(() => newGymStep.last?.onSubmittingChange(false));
    expect(navigationState.preventRemove.at(-1)).toBe(false);
    expect(navigationState.options.at(-1)).toEqual({ gestureEnabled: true });
  });

  it('moves nothing for a save that lands after the screen went, and reports the flow once', () => {
    state.params = { ...state.params, trail: 'where,gym', boardType: 'kilter' };
    const { unmount } = render(createElement(AddBoardNewGym));
    const step = newGymStep.last;
    act(() => step?.onSubmittingChange(true));
    unmount();
    step?.onCreated(created);
    expect(replaceMock).not.toHaveBeenCalled();
    // The gym is on its way: leaving mid-save is not abandoning (Gym Created reports it).
    expect(events('Board Builder Abandoned')).toEqual([]);
  });

  it('finishes a save that landed while another screen was in front once it is back in front', () => {
    state.params = { ...state.params, trail: 'where,gym' };
    navigationState.focused = false;
    const { rerender } = render(createElement(AddBoardNewGym));
    act(() => newGymStep.last?.onSubmittingChange(true));
    act(() => newGymStep.last?.onCreated(created));
    expect(replaceMock).not.toHaveBeenCalled();
    navigationState.focused = true;
    rerender(createElement(AddBoardNewGym));
    expect(replaceMock).toHaveBeenCalledTimes(1);
    // Not left holding the screen on "saving".
    expect(navigationState.preventRemove.at(-1)).toBe(false);
  });

  it('ignores a listed gym or its Claim while a save is out', () => {
    state.params = { ...state.params, trail: 'where,gym', boardType: 'kilter' };
    render(createElement(AddBoardNewGym));
    act(() => newGymStep.last?.onSubmittingChange(true));
    newGymStep.last?.onPickExistingGym('gym-listed');
    newGymStep.last?.onClaimGym('gym-listed');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('reports leaving after a refused save as leaving', () => {
    state.params = { ...state.params, trail: 'where,gym' };
    const { unmount } = render(createElement(AddBoardNewGym));
    act(() => newGymStep.last?.onSubmittingChange(true));
    act(() => newGymStep.last?.onSubmittingChange(false));
    unmount();
    expect(events('Board Builder Abandoned')).toEqual([expect.objectContaining({ step: 'find', kind: 'gym' })]);
  });

  it('reports leaving with nothing added as the find step on the gym path', () => {
    state.params = { ...state.params, trail: 'where,gym' };
    const { unmount } = render(createElement(AddBoardNewGym));
    unmount();
    expect(events('Board Builder Abandoned')).toEqual([expect.objectContaining({ step: 'find', kind: 'gym' })]);
  });
});

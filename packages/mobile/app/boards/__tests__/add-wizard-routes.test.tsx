// @vitest-environment jsdom
//
// The add-a-board wizard's routes: what each step pushes, how it counts itself,
// and what it reports. The step components (GymStep, BoardTypeStep) are stubs
// that hand back their callbacks; their own suites cover what they draw.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Children = { children?: ReactNode };

const pushMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  signedIn: true,
  focusEffects: [] as Array<() => void>,
}));
const gymStep = vi.hoisted(() => ({
  last: null as null | {
    stepLabel?: string;
    initialBoardType: string | null;
    onPickGym: (gym: { uuid: string }, boardType: string | null) => void;
    onAddGym: (boardType: string | null) => void;
  },
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
  useRouter: () => ({ push: pushMock }),
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
vi.mock('../../../src/components/board-discovery/add-board-wizard/BoardTypeStep', () => ({
  BoardTypeStep: (props: NonNullable<(typeof typeStep)['last']>) => {
    typeStep.last = props;
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

function events(name: string) {
  return trackMock.mock.calls.filter(([eventName]) => eventName === name).map(([, props]) => props);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.params = { returnTo: '/(tabs)/climbs', source: 'onboarding', entry: 'picker' };
  state.signedIn = true;
  state.focusEffects = [];
  gymStep.last = null;
  typeStep.last = null;
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

  it('asks Which board? for an unlisted gym with no type, and opens Set up when the type is known', () => {
    render(createElement(AddBoardGym));
    gymStep.last?.onAddGym(null);
    expect(pushMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pathname: '/boards/add/board',
        params: expect.objectContaining({ path: 'gym', focusLocation: '1', trail: 'where,gym' }),
      }),
    );
    gymStep.last?.onAddGym('moonboard');
    expect(pushMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pathname: '/boards/create',
        params: expect.objectContaining({ path: 'gym', presetBoardType: 'moonboard', focusLocation: '1' }),
      }),
    );
  });

  it('sends a signed-out climber to sign in to add a gym', () => {
    state.signedIn = false;
    render(createElement(AddBoardGym));
    gymStep.last?.onAddGym('kilter');
    expect(pushMock).toHaveBeenCalledExactlyOnceWith('/auth/login');
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

  it('carries an unlisted gym on to Set up with the location focused', () => {
    state.params = { ...state.params, trail: 'where,gym', path: 'gym', focusLocation: '1' };
    render(createElement(AddBoardType));
    expect(typeStep.last?.stepLabel).toBe('mobile.addWizard.stepCounter {"current":3,"total":4}');
    typeStep.last?.onPick('kilter');
    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ path: 'gym', kind: 'gym', focusLocation: '1', trail: 'where,gym,board' }),
      }),
    );
  });
});

// @vitest-environment jsdom
//
// The builders' gym row: the gym step in pick mode, pushed in the board picker's
// stack instead of a searchable list in a sheet on the Boards sheet. A choice is
// handed back to the form that pushed it, then the screen goes back. Opened
// with nobody to hand it to, it leaves instead of drawing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import type { Gym } from '@boardsesh/shared-schema';
import type { GymStepProps } from '../../../src/components/board-discovery/gym-step/GymStep';
import type { GymPick } from '../../../src/lib/boards/gym-pick-handoff';

const routerMock = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn(), canGoBack: vi.fn(() => true) }));
const state = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  gymStep: null as GymStepProps | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
  useLocalSearchParams: () => state.params,
}));
vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../src/components/board-discovery/gym-step/GymStep', () => ({
  GymStep: (props: GymStepProps) => {
    state.gymStep = props;
    return createElement('div', { 'data-testid': 'gym-step' });
  },
}));

const { default: BoardGymPicker } = await import('../gym-picker');
const { subscribeToGymPicks } = await import('../../../src/lib/boards/gym-pick-handoff');

const CRUX = { uuid: 'gym-1', name: 'Crux', latitude: 52.37, longitude: 4.9, boardCount: 2 } as unknown as Gym;

beforeEach(() => {
  vi.clearAllMocks();
  routerMock.canGoBack.mockReturnValue(true);
  state.gymStep = null;
  state.params = { handoffId: 'form-1', gymUuid: 'gym-0', latitude: '52.3', longitude: '4.8', showsOnMap: '0' };
});

function listen(): { picks: GymPick[]; stop: () => void } {
  const picks: GymPick[] = [];
  return { picks, stop: subscribeToGymPicks('form-1', (pick) => picks.push(pick)) };
}

describe('/boards/gym-picker', () => {
  it('opens the gym step in pick mode, on the board, with its gym ticked and no step count', () => {
    render(createElement(BoardGymPicker));
    expect(state.gymStep?.stepLabel).toBeUndefined();
    expect(state.gymStep?.picker).toMatchObject({
      currentGymUuid: 'gym-0',
      showsOnMap: false,
      initialCenter: { latitude: 52.3, longitude: 4.8 },
    });
  });

  it('hands a picked gym back to its form and goes back', () => {
    const { picks, stop } = listen();
    render(createElement(BoardGymPicker));
    state.gymStep?.onPickGym(CRUX, null);
    expect(picks).toEqual([{ kind: 'gym', gym: { uuid: 'gym-1', name: 'Crux', latitude: 52.37, longitude: 4.9 } }]);
    expect(routerMock.back).toHaveBeenCalledOnce();
    stop();
  });

  it.each([
    ['Not at a gym', 'none'],
    ["My gym isn't listed", 'not_listed'],
  ] as const)('hands back %s', (_label, kind) => {
    const { picks, stop } = listen();
    render(createElement(BoardGymPicker));
    if (kind === 'none') state.gymStep?.picker?.onPickNone();
    else state.gymStep?.onAddGym(null);
    expect(picks).toEqual([{ kind }]);
    expect(routerMock.back).toHaveBeenCalledOnce();
    stop();
  });

  // A second tap while the screen is leaving would pop the builder under it too.
  it('hands back one answer per visit, however fast the taps', () => {
    const { picks, stop } = listen();
    render(createElement(BoardGymPicker));
    state.gymStep?.onPickGym(CRUX, null);
    state.gymStep?.picker?.onPickNone();
    expect(picks).toHaveLength(1);
    expect(routerMock.back).toHaveBeenCalledOnce();
    stop();
  });

  it('leaves a bare link without drawing, to the wizard when there is nothing to go back to', () => {
    state.params = {};
    routerMock.canGoBack.mockReturnValue(false);
    const view = render(createElement(BoardGymPicker));
    expect(view.queryByTestId('gym-step')).toBeNull();
    expect(routerMock.replace).toHaveBeenCalledWith('/boards/add');
  });
});

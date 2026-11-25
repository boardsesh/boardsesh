// @vitest-environment jsdom
//
// "Which gym?" (the add-a-board gym step): nothing is asked on open, the map
// starts on the world, a town flies it there and lists the gyms around it, and
// a row picks with the board type in force.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, forwardRef, useEffect, useImperativeHandle, type ReactNode, type Ref } from 'react';
import type { Gym, PlaceSuggestion } from '@boardsesh/shared-schema';
import type { GymListRow } from '../../../gym-directory/gym-list-rows';

type Children = { children?: ReactNode; testID?: string };
type Coords = { latitude: number; longitude: number };

const trackMock = vi.hoisted(() => vi.fn());
const requestMock = vi.hoisted(() => vi.fn());
const requestIfAllowedMock = vi.hoisted(() => vi.fn());
const setCenterMock = vi.hoisted(() => vi.fn());
const showWorldMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  location: { status: 'idle', permission: 'unknown', coords: null as Coords | null },
  gyms: undefined as { gyms: unknown[] } | undefined,
  gymsArgs: [] as unknown[],
  mapCenter: undefined as Coords | null | undefined,
}));

vi.mock('react-native', () => ({
  View: ({
    children,
    testID,
    onLayout,
  }: Children & { onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { height: 600 } } });
    }, [onLayout]);
    return createElement('div', { 'data-testid': testID }, children);
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => (options?.count ?? '') + key }),
}));
vi.mock('../../../../lib/graphql/hooks', () => ({
  useNearbyGyms: (...args: unknown[]) => {
    state.gymsArgs = args;
    const enabled = args[0] !== null || typeof args[2] === 'string';
    return {
      data: enabled ? state.gyms : undefined,
      isLoading: enabled && !state.gyms,
      isError: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));
vi.mock('../../../../lib/graphql/extract-error-message', () => ({ isGraphqlRateLimitedError: () => false }));
vi.mock('../../../../lib/use-device-location', () => ({
  useDeviceLocation: () => ({ ...state.location, request: requestMock, requestIfAllowed: requestIfAllowedMock }),
}));
vi.mock('../../../../lib/connectivity/use-connectivity', () => ({
  selectEffectiveOffline: () => false,
  useConnectivityField: () => false,
}));
vi.mock('../../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { primary: '#639' } }),
}));
vi.mock('../../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { xl: 20, full: 999 },
}));
vi.mock('../../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress }: Children & { onPress?: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, children),
}));
vi.mock('../../../spray-wall/StepCounter', () => ({
  StepCounter: ({ label }: { label: string }) => createElement('p', { 'data-testid': 'step-counter' }, label),
}));
vi.mock('../../board-builder-labels', () => ({ boardTypeLabel: (board: string) => `label:${board}` }));
vi.mock('../../../filter-capsules/CapsuleRow', () => ({
  CapsuleRow: ({
    capsules,
  }: {
    capsules: { key: string; options: { value: string; label: string }[]; onSelect: (value: string) => void }[];
  }) =>
    createElement(
      'div',
      null,
      capsules.flatMap((capsule) =>
        capsule.options.map((option) =>
          createElement(
            'button',
            {
              key: `${capsule.key}:${option.value}`,
              type: 'button',
              'data-testid': `type-${option.value}`,
              onClick: () => capsule.onSelect(option.value),
            },
            option.label,
          ),
        ),
      ),
    ),
}));
vi.mock('../../../gym-directory/GymMap', () => ({
  GymMap: forwardRef(({ center }: { center: Coords | null }, ref: Ref<unknown>) => {
    state.mapCenter = center;
    useImperativeHandle(ref, () => ({ setCenter: setCenterMock, showWorld: showWorldMock }), []);
    return createElement('div', { 'data-testid': 'gym-map' });
  }),
}));
vi.mock('../../../gym-directory/GymListPanel', () => ({
  GymListPanel: forwardRef(
    (
      {
        data,
        onPickGym,
        onAddGym,
        filterSlot,
        locationPrompt,
      }: {
        data: GymListRow[];
        onPickGym: (gym: Gym) => void;
        onAddGym: () => void;
        filterSlot?: ReactNode;
        locationPrompt?: ReactNode;
      },
      ref: Ref<unknown>,
    ) => {
      useImperativeHandle(ref, () => ({ snapTo: vi.fn(), ensureVisible: vi.fn(), scrollToRowKey: vi.fn() }), []);
      return createElement('section', { 'data-testid': 'panel' }, [
        createElement('div', { key: 'filters' }, filterSlot),
        locationPrompt
          ? createElement('div', { key: 'prompt' }, locationPrompt)
          : data.map((row) =>
              row.kind === 'pickGym'
                ? createElement(
                    'button',
                    { key: row.key, type: 'button', 'data-testid': row.key, onClick: () => onPickGym(row.gym) },
                    `${row.gym.name} | ${row.subtitle} | ${row.boardsLabel}`,
                  )
                : row.kind === 'addGym'
                  ? createElement(
                      'button',
                      { key: row.key, type: 'button', 'data-testid': 'add-gym', onClick: onAddGym },
                      row.title,
                    )
                  : createElement('div', { key: row.key, 'data-testid': `row-${row.kind}` }),
            ),
      ]);
    },
  ),
}));
vi.mock('../../../gym-directory/GymLocationPrompt', () => ({
  GymLocationPrompt: ({ status, onRequest }: { status: string; onRequest: () => void }) =>
    createElement('button', { type: 'button', 'data-testid': 'location-prompt', onClick: onRequest }, status),
}));
const AMSTERDAM: PlaceSuggestion = {
  id: 2759794,
  name: 'Amsterdam',
  region: 'North Holland',
  country: 'Netherlands',
  countryCode: 'NL',
  latitude: 52.374,
  longitude: 4.8897,
};
vi.mock('../../../gym-directory/GymSearchField', () => ({
  GymSearchField: ({
    text,
    onChangeText,
    onSelectPlace,
  }: {
    text: string;
    onChangeText: (text: string) => void;
    onSelectPlace: (place: PlaceSuggestion) => void;
  }) =>
    createElement('div', null, [
      createElement('input', {
        key: 'input',
        value: text,
        'data-testid': 'search',
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      }),
      createElement(
        'button',
        { key: 'place', type: 'button', 'data-testid': 'pick-amsterdam', onClick: () => onSelectPlace(AMSTERDAM) },
        'Amsterdam',
      ),
    ]),
}));

const { GymStep } = await import('../GymStep');

const BOULDERHAL = {
  uuid: 'gym-1',
  name: 'Boulderhal',
  address: 'Fokkerweg 75',
  latitude: 52.3705,
  longitude: 4.8888,
  boardCount: 3,
  boardTypes: ['kilter'],
  listingState: 'RUN_BY_GYM',
} as unknown as Gym;

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  state.location = { status: 'idle', permission: 'unknown', coords: null };
  state.gyms = undefined;
  state.gymsArgs = [];
  state.mapCenter = undefined;
  requestIfAllowedMock.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('GymStep', () => {
  it('asks for nothing on open: it reads the permission, shows the world, and offers the prompt', async () => {
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    expect(requestIfAllowedMock).toHaveBeenCalledOnce();
    expect(requestMock).not.toHaveBeenCalled();
    expect(state.mapCenter).toBeNull();
    // A spinner while the permission is read, then the button that asks.
    expect(screen.getByTestId('location-prompt').textContent).toBe('idle');
    await settle();
    expect(screen.getByTestId('location-prompt').textContent).toBe('unavailable');
    expect(requestMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('location-prompt'));
    expect(requestMock).toHaveBeenCalledOnce();
  });

  it('offers Settings once location is refused for good', async () => {
    state.location = { status: 'idle', permission: 'blocked', coords: null };
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    expect(screen.getByTestId('location-prompt').textContent).toBe('denied');
  });

  it('flies to a picked town and lists the gyms within 50 km of it, without location', async () => {
    state.gyms = { gyms: [BOULDERHAL] };
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();

    fireEvent.click(screen.getByTestId('pick-amsterdam'));
    await settle();
    const amsterdam = { latitude: AMSTERDAM.latitude, longitude: AMSTERDAM.longitude };
    expect(setCenterMock).toHaveBeenLastCalledWith(amsterdam);
    expect(state.gymsArgs[0]).toEqual(amsterdam);
    expect(state.gymsArgs[1]).toBe(50);
    expect(state.gymsArgs[2]).toBeUndefined();
    expect(screen.queryByTestId('location-prompt')).toBeNull();
    expect((screen.getByTestId('search') as HTMLInputElement).value).toBe('Amsterdam, North Holland, Netherlands');
    // No distance from a town: the row says where the gym is, not how far from it.
    expect(screen.getByTestId('gym:gym-1').textContent).toBe('Boulderhal | Fokkerweg 75 | 3mobile.gyms.boardCount');
    expect(trackMock).toHaveBeenCalledWith('Board Wall Search Started', expect.objectContaining({ method: 'place' }));
  });

  it('flies from the world to the climber when a fix arrives, and measures rows from them', async () => {
    state.gyms = { gyms: [BOULDERHAL] };
    const view = render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    expect(setCenterMock).not.toHaveBeenCalled();

    const climber = { latitude: 52.3791, longitude: 4.9003 };
    state.location = { status: 'granted', permission: 'granted', coords: climber };
    view.rerender(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    expect(setCenterMock).toHaveBeenCalledWith(climber);
    expect(state.gymsArgs[0]).toEqual(climber);
    expect(screen.getByTestId('gym:gym-1').textContent).toContain('1.2 km · Fokkerweg 75');
  });

  it('filters gyms by the name typed', async () => {
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    fireEvent.change(screen.getByTestId('search'), { target: { value: 'Monk' } });
    await settle();
    expect(state.gymsArgs[0]).toBeNull();
    expect(state.gymsArgs[2]).toBe('Monk');
    expect(trackMock).toHaveBeenCalledWith(
      'Board Wall Search Started',
      expect.objectContaining({ method: 'text', queryLength: 4 }),
    );
  });

  it('picks a gym, and adds one, with the board type chosen in the capsule', async () => {
    state.location = { status: 'granted', permission: 'granted', coords: { latitude: 52.37, longitude: 4.9 } };
    state.gyms = { gyms: [BOULDERHAL] };
    const onPickGym = vi.fn();
    const onAddGym = vi.fn();
    render(createElement(GymStep, { onPickGym, onAddGym, initialBoardType: null }));
    await settle();

    fireEvent.click(screen.getByTestId('type-kilter'));
    await settle();
    expect(state.gymsArgs[3]).toEqual(['kilter']);
    fireEvent.click(screen.getByTestId('gym:gym-1'));
    expect(onPickGym).toHaveBeenCalledWith(BOULDERHAL, 'kilter');

    fireEvent.click(screen.getByTestId('type-any'));
    fireEvent.click(screen.getByTestId('add-gym'));
    expect(onAddGym).toHaveBeenCalledWith(null);
  });

  it('shows the step counter only when the flow counts its steps', () => {
    const view = render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    expect(screen.queryByTestId('step-counter')).toBeNull();
    view.rerender(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn(), stepLabel: 'Step 2 of 3' }));
    expect(screen.getByTestId('step-counter').textContent).toBe('Step 2 of 3');
  });
});

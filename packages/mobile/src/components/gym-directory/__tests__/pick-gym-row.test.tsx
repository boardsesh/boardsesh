// @vitest-environment jsdom
//
// The "Which gym?" rows, moved out of the gym map's panel: a gym picks with
// one tap and shows its distance line and pills, a town picks itself, a failed
// lookup offers Try again, and Add my gym is its own card.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Gym, PlaceSuggestion } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../StatusPill', () => ({
  StatusPill: ({ label, testID }: { label: string; testID?: string }) =>
    createElement('span', { 'data-testid': testID }, label),
}));
vi.mock('../../gym-page/GymListingPill', () => ({
  GymListingPill: ({ testID }: { testID?: string }) => createElement('span', { 'data-testid': testID }, 'Run by'),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, testID }: Children & { onPress?: () => void; testID?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-testid': testID }, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { tertiaryFill: '#eee', secondaryLabel: '#666', accent: '#639' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8 } }));
vi.mock('../../gym-page/InsetGroupedCell', () => ({
  InsetGroupedCell: ({ children, position }: Children & { position: string }) =>
    createElement('div', { 'data-position': position }, children),
}));
vi.mock('../../ArtRow', () => ({
  ArtRow: ({
    title,
    subtitle,
    onPress,
    selected,
    testID,
  }: {
    title: string;
    subtitle?: ReactNode;
    onPress?: () => void;
    selected?: boolean;
    testID?: string;
  }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-testid': testID, 'data-selected': selected }, [
      createElement('span', { key: 'title' }, title),
      createElement('span', { key: 'subtitle' }, subtitle),
    ]),
}));

const { AddGymRow, PickGymRow, PickPlaceRow, PickRetryAction } = await import('../PickGymRow');

const runByGym = {
  uuid: 'g3',
  name: 'Boulderhal Luchthaven',
  address: 'Fokkerweg 75',
  boardCount: 3,
  boardTypes: ['kilter'],
  listingState: 'RUN_BY_GYM',
} as unknown as Gym;
const climberListed = { ...runByGym, uuid: 'g4', name: 'Home Board', listingState: 'CLIMBER_LISTED' } as Gym;

afterEach(cleanup);

describe('PickGymRow', () => {
  it('draws the distance line, the boards pill, and the run-by-gym pill only where staff run it', () => {
    const view = render(
      <div>
        <PickGymRow
          gym={runByGym}
          subtitle="1.2 km · Fokkerweg 75"
          boardsLabel="3 boards"
          position="first"
          selected={false}
          onPickGym={vi.fn()}
        />
        <PickGymRow
          gym={climberListed}
          subtitle={null}
          boardsLabel="No boards yet"
          position="last"
          selected
          onPickGym={vi.fn()}
        />
      </div>,
    );
    expect(view.getByText('1.2 km · Fokkerweg 75')).toBeTruthy();
    // No distance and no address: the line is left out, not filled with filler.
    expect(view.getByTestId('gym-pick-g4').textContent).toBe('Home BoardNo boards yet');
    expect(view.getAllByTestId('gym-pick-boards').map((pill) => pill.textContent)).toEqual([
      '3 boards',
      'No boards yet',
    ]);
    expect(view.getAllByTestId('gym-pick-listing')).toHaveLength(1);
    expect(view.getByTestId('gym-pick-g4').getAttribute('data-selected')).toBe('true');
    expect(view.getByTestId('gym-pick-g3').closest('[data-position]')?.getAttribute('data-position')).toBe('first');
  });

  it('picks the gym with one tap', () => {
    const onPickGym = vi.fn();
    const view = render(
      <PickGymRow
        gym={runByGym}
        subtitle={null}
        boardsLabel="3 boards"
        position="only"
        selected={false}
        onPickGym={onPickGym}
      />,
    );
    fireEvent.click(view.getByTestId('gym-pick-g3'));
    expect(onPickGym).toHaveBeenCalledWith(runByGym);
  });
});

describe('PickPlaceRow', () => {
  it('hands its town over on a tap', () => {
    const place: PlaceSuggestion = {
      id: 2759794,
      name: 'Amsterdam',
      region: 'North Holland',
      country: 'Netherlands',
      countryCode: 'NL',
      latitude: 52.374,
      longitude: 4.8897,
    };
    const onSelectPlace = vi.fn();
    const view = render(
      <PickPlaceRow place={place} label="Amsterdam, North Holland" position="only" onSelectPlace={onSelectPlace} />,
    );
    fireEvent.click(view.getByTestId('gym-pick-place-2759794'));
    expect(onSelectPlace).toHaveBeenCalledWith(place);
    expect(view.getByText('Amsterdam, North Holland')).toBeTruthy();
  });
});

describe('PickRetryAction and AddGymRow', () => {
  it('offers Try again, and Add my gym on its own card', () => {
    const onRetry = vi.fn();
    const onAddGym = vi.fn();
    const view = render(
      <div>
        <PickRetryAction label="Try again" onPress={onRetry} />
        <AddGymRow title="Add my gym" subtitle="Not listed? Add it with your board" onAddGym={onAddGym} />
      </div>,
    );
    fireEvent.click(view.getByTestId('gym-pick-retry'));
    expect(onRetry).toHaveBeenCalledOnce();
    fireEvent.click(view.getByTestId('gym-pick-add-gym'));
    expect(onAddGym).toHaveBeenCalledOnce();
    expect(view.getByTestId('gym-pick-add-gym').closest('[data-position]')?.getAttribute('data-position')).toBe('only');
  });
});

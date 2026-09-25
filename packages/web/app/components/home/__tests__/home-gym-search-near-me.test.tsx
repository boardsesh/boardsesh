import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const { push, requestPermission, useGeolocation } = vi.hoisted(() => ({
  push: vi.fn(),
  requestPermission: vi.fn(),
  useGeolocation: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/app/hooks/use-geolocation', () => ({ useGeolocation }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => tFromCatalog('gyms', key) }) }));
import HomeGymSearchNearMe from '../home-gym-search-near-me';

type LocationState = {
  coordinates: { latitude: number; longitude: number } | null;
  error: { code: number } | null;
  loading: boolean;
};
let locationState: LocationState;
const originalGeolocation = Object.getOwnPropertyDescriptor(navigator, 'geolocation');

beforeEach(() => {
  vi.clearAllMocks();
  locationState = { coordinates: null, error: null, loading: false };
  useGeolocation.mockImplementation(() => ({ ...locationState, requestPermission }));
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {} });
});
afterEach(() => {
  if (originalGeolocation) Object.defineProperty(navigator, 'geolocation', originalGeolocation);
  else Reflect.deleteProperty(navigator, 'geolocation');
});

describe('homepage near me', () => {
  it('only requests location after a press, then navigates with rounded coordinates and locale', async () => {
    const view = render(<HomeGymSearchNearMe locale="de" />);
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    expect(requestPermission).toHaveBeenCalledOnce();
    locationState.coordinates = { latitude: 52.123456, longitude: 4.987654 };
    view.rerender(<HomeGymSearchNearMe locale="de" />);
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    const destination = new URL(push.mock.calls[0][0], 'https://www.boardsesh.com');
    expect(destination.pathname).toBe('/de/gyms');
    expect(destination.searchParams.get('lat')).toBe('52.123');
    expect(destination.searchParams.get('lng')).toBe('4.988');
    expect(destination.searchParams.get('radius')).toBe('25');
  });

  it('does not navigate on an unsolicited fix, but reuses it after a press', () => {
    locationState.coordinates = { latitude: 51, longitude: 4 };
    render(<HomeGymSearchNearMe locale="en-US" />);
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/gyms\?/));
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it.each([
    [1, 'nearMe.deniedBody'],
    [2, 'nearMe.unavailableBody'],
  ])('shows a text-search fallback for error %s', (code, key) => {
    locationState.error = { code: Number(code) };
    render(<HomeGymSearchNearMe locale="en-US" />);
    expect(screen.getByRole('alert').textContent).toContain(tFromCatalog('gyms', String(key)));
    expect(push).not.toHaveBeenCalled();
  });

  it('disables the button when geolocation is unsupported', () => {
    Reflect.deleteProperty(navigator, 'geolocation');
    render(<HomeGymSearchNearMe locale="en-US" />);
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain(tFromCatalog('gyms', 'nearMe.unsupportedBody'));
  });

  it('prevents repeat presses while locating', () => {
    locationState.loading = true;
    render(<HomeGymSearchNearMe locale="en-US" />);
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
  });
});

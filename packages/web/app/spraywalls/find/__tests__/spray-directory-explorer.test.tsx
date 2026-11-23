import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { parseSprayDirectoryQuery } from '../directory-model';
import SprayDirectoryExplorer from '../spray-directory-explorer';
import type { MapPin } from '@/app/gyms/near-me-model';

const { requestDirectory, requestLocation, location } = vi.hoisted(() => ({
  requestDirectory: vi.fn(),
  requestLocation: vi.fn(),
  location: {
    coordinates: null as { latitude: number; longitude: number } | null,
    error: null as { code: number } | null,
    loading: false,
  },
}));
vi.mock('../directory-request', () => ({ requestSprayDirectory: requestDirectory }));
vi.mock('@/app/hooks/use-geolocation', () => ({
  useGeolocation: () => ({ ...location, requestPermission: requestLocation }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
  }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/app/gyms/gym-place-search', () => ({
  default: ({ actions, children }: { actions: React.ReactNode; children: React.ReactNode }) => (
    <>
      {actions}
      {children}
    </>
  ),
}));
vi.mock('@/app/gyms/gym-directory-map', () => ({
  default: ({ pins }: { pins: MapPin[] }) => <div data-testid="map-pins">{pins.map((pin) => pin.name).join(',')}</div>,
}));

const wall = {
  uuid: 'nearby',
  slug: 'nearby-wall',
  name: 'Nearby crew',
  angle: 40,
  locationName: 'Town',
  gymName: null,
  latitude: 52,
  longitude: 4,
  distanceMeters: 1000,
};

const scrollIntoView = vi.fn();

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SprayDirectoryExplorer
        query={parseSprayDirectoryQuery({ q: 'crew', angle: '40' })}
        locale="en-US"
        walls={[{ ...wall, name: 'Browse crew' }]}
        filters={<span>Filters</span>}
      >
        <span>Browse results</span>
      </SprayDirectoryExplorer>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  location.coordinates = null;
  location.error = null;
  location.loading = false;
  requestDirectory.mockReset().mockResolvedValue({ boards: [wall], totalCount: 1, hasMore: false });
  requestLocation.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {} });
  Element.prototype.scrollIntoView = scrollIntoView.mockClear();
  window.history.replaceState({}, '', '/spraywalls/find');
});
afterEach(cleanup);

describe('spray directory nearby and map interactions', () => {
  it('waits for opt-in, keeps filters, rounds location and updates list and map together', async () => {
    location.coordinates = { latitude: 52.123456, longitude: 4.123456 };
    mount();
    expect(requestDirectory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Near me' }));
    await screen.findByRole('link', { name: 'Nearby crew' });
    expect(requestLocation).toHaveBeenCalledOnce();
    expect(requestDirectory.mock.calls[0][0]).toEqual({
      boardType: 'spray',
      query: 'crew',
      angles: [40],
      latitude: 52.123,
      longitude: 4.123,
      radiusKm: 25,
      limit: 50,
      offset: 0,
    });
    expect(screen.getByTestId('map-pins').textContent).toBe('Nearby crew');
    expect(window.location.search).not.toContain('lat');
    fireEvent.click(screen.getByRole('button', { name: '100 km' }));
    await waitFor(() =>
      expect(requestDirectory).toHaveBeenLastCalledWith(
        expect.objectContaining({ radiusKm: 100, angles: [40] }),
        expect.any(AbortSignal),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'All spray walls' }));
    expect(screen.getByText('Browse results')).toBeTruthy();
    expect(screen.getByTestId('map-pins').textContent).toBe('Browse crew');
  });

  it('keeps ordinary results available when location is denied', () => {
    location.error = { code: 1 };
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Near me' }));
    expect(screen.getByRole('alert').textContent).toContain('Type a town');
    expect(screen.getByText('Browse results')).toBeTruthy();
    expect(requestDirectory).not.toHaveBeenCalled();
  });

  it('shows failures separately, clears stale pins and retries the same filters', async () => {
    location.coordinates = { latitude: 52, longitude: 4 };
    requestDirectory.mockRejectedValueOnce(new Error('Unavailable'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Near me' }));
    const alert = await screen.findByRole('alert');
    expect(alert.closest('#spray-directory-results')).toBeNull();
    expect(screen.getByTestId('map-pins').textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('map-pins').textContent).toBe('Nearby crew'));
    expect(requestDirectory).toHaveBeenCalledTimes(2);
  });

  it('restores the map toggle when browser history changes', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show map' }));
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(window.location.search).toBe('?view=map');
    act(() => {
      window.history.replaceState({}, '', '/spraywalls/find');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByRole('button', { name: 'Show map' }).getAttribute('aria-expanded')).toBe('false');
  });
});

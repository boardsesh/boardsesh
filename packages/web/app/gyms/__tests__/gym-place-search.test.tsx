import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { parseDirectoryQuery } from '../directory-facets';
import GymPlaceSearch from '../gym-place-search';

const { request, push } = vi.hoisted(() => ({ request: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => tFromCatalog('gyms', key) }) }));

const sydney = {
  id: 2147714,
  name: 'Sydney',
  region: 'New South Wales',
  country: 'Australia',
  countryCode: 'AU',
  latitude: -33.86785,
  longitude: 151.20732,
};
const selectedQuery = parseDirectoryQuery('kilter', {
  place: 'Sydney, New South Wales, Australia',
  lat: '-33.86785',
  lng: '151.20732',
  radius: '50',
});

beforeEach(() => {
  request.mockReset().mockResolvedValue({ searchPlaces: [sydney] });
  push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('place suggestions', () => {
  it('preserves legacy geographic filters when editing a gym-name query', () => {
    render(
      <GymPlaceSearch
        facet="all"
        query={parseDirectoryQuery('all', { q: 'Nine', lat: '-33.86', lng: '151.2', radius: '25' })}
        locale="en-US"
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '9 Degrees' } });
    const submitted = new FormData(screen.getByRole('search') as HTMLFormElement);
    expect(submitted.get('q')).toBe('9 Degrees');
    expect(submitted.get('lat')).toBe('-33.86');
    expect(submitted.get('radius')).toBe('25');
  });
  it('selects a city by keyboard without adding a gym-name filter, preserving facet and locale', async () => {
    render(<GymPlaceSearch facet="kilter" query={parseDirectoryQuery('kilter', { page: '3' })} locale="fr" />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Sydney' } });
    await screen.findByRole('option', { name: 'Sydney, New South Wales, Australia' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledOnce();
    const url = new URL(push.mock.calls[0][0], 'https://www.boardsesh.com');
    expect(url.pathname).toBe('/fr/gyms/kilter');
    expect(url.searchParams.get('lat')).toBe('-33.86785');
    expect(url.searchParams.get('radius')).toBe('50');
    expect(url.searchParams.has('q')).toBe(false);
    expect(url.searchParams.has('page')).toBe(false);
  });
  it('keeps a plain GET gym-name search when suggestions fail', async () => {
    request.mockRejectedValue(new Error('Offline'));
    render(<GymPlaceSearch facet="all" query={parseDirectoryQuery('all', { boardType: 'tension' })} locale="en-US" />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '9 Degrees' } });
    await screen.findByText(/Town suggestions are unavailable/);
    const form = screen.getByRole('search') as HTMLFormElement;
    expect(form.method).toBe('get');
    expect(new FormData(form).get('q')).toBe('9 Degrees');
    expect(new FormData(form).get('boardType')).toBe('tension');
    expect(push).not.toHaveBeenCalled();
  });
  it('keeps selected places out of q and removes geographic fields when edited', () => {
    render(<GymPlaceSearch facet="kilter" query={selectedQuery} locale="en-US" />);
    const form = screen.getByRole('search') as HTMLFormElement;
    expect(new FormData(form).has('q')).toBe(false);
    expect(new FormData(form).get('place')).toContain('Sydney');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '9 Degrees' } });
    const submitted = new FormData(form);
    expect(submitted.get('q')).toBe('9 Degrees');
    expect(submitted.has('lat')).toBe(false);
    expect(submitted.has('place')).toBe(false);
  });
  it('debounces requests and ignores responses for stale text', async () => {
    let finishFirst: ((response: { searchPlaces: (typeof sydney)[] }) => void) | undefined;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    render(<GymPlaceSearch facet="all" query={parseDirectoryQuery('all', {})} locale="en-US" />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Syd' } });
    expect(request).not.toHaveBeenCalled();
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    const signal = request.mock.calls[0][0].signal as AbortSignal;
    fireEvent.change(input, { target: { value: 'Sy' } });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finishFirst?.({ searchPlaces: [sydney] });
    });
    expect(screen.queryByRole('option')).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });
});

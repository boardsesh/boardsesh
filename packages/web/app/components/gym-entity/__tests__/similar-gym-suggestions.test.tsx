import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import type { SimilarGym } from '@boardsesh/shared-schema';

// Minimal i18n: echo the key with {{var}} interpolation so assertions can target
// the interpolated distance strings.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (!vars) return key;
      return Object.entries(vars).reduce((out, [name, value]) => out.replace(`{{${name}}}`, String(value)), key);
    },
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  FIND_SIMILAR_GYMS: 'FIND_SIMILAR_GYMS',
}));

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({
  trackGymFunnelEvent,
  viewerStateFrom: (isAuthenticated: boolean) => (isAuthenticated ? 'signed-in' : 'signed-out'),
}));

// Stub the claim dialog so we can assert it opens without pulling in its own
// graphql/token wiring.
vi.mock('../claim-gym-dialog', () => ({
  default: ({ open, gymName }: { open: boolean; gymName: string }) =>
    open ? <div data-testid="claim-dialog">{`claiming ${gymName}`}</div> : null,
}));

import SimilarGymSuggestions from '../similar-gym-suggestions';

const gymFixture = (overrides: Partial<SimilarGym> = {}): SimilarGym => ({
  uuid: 'gym-1',
  slug: 'bahnhof-bloc',
  name: 'Bahnhof Bloc',
  address: 'Zurich',
  website: null,
  distanceMeters: 60,
  ownerType: 'SYSTEM',
  isClaimable: true,
  canClaimByDomain: false,
  providerOrigins: ['kilter'],
  ...overrides,
});

function renderSuggestions(name = 'Bahnhof Bloc') {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <SimilarGymSuggestions name={name} latitude={47.0} longitude={8.0} />
    </QueryClientProvider>,
  );
}

describe('SimilarGymSuggestions', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    trackGymFunnelEvent.mockReset();
  });

  it('renders suggestion cards with distance, provider badge, and view/claim actions', async () => {
    mockRequest.mockResolvedValueOnce({
      findSimilarGyms: [gymFixture(), gymFixture({ uuid: 'gym-2', name: 'Bahnhof Bloc Annex', distanceMeters: 1200 })],
    });

    renderSuggestions();

    // Heading + both cards appear after the debounce + query resolve.
    await waitFor(() => expect(screen.getByText('similarGyms.heading')).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText('Bahnhof Bloc')).toBeTruthy();
    expect(screen.getByText('Bahnhof Bloc Annex')).toBeTruthy();

    // Distance formatting: metres under 1 km, km above.
    expect(screen.getByText('similarGyms.distanceMeters')).toBeTruthy();
    expect(screen.getByText('similarGyms.distanceKm')).toBeTruthy();

    // Provider origin badge + view link + claim action + the "create anyway" caption.
    expect(screen.getAllByText('similarGyms.providerBadge').length).toBeGreaterThan(0);
    expect(screen.getAllByText('similarGyms.viewGym').length).toBeGreaterThan(0);
    expect(screen.getAllByText('similarGyms.claim').length).toBeGreaterThan(0);
    expect(screen.getByText('similarGyms.createAnyway')).toBeTruthy();
  });

  it('opens the claim dialog when "this is my gym" is pressed', async () => {
    mockRequest.mockResolvedValueOnce({ findSimilarGyms: [gymFixture()] });

    renderSuggestions();

    await waitFor(() => expect(screen.getByText('similarGyms.claim')).toBeTruthy(), { timeout: 3000 });
    fireEvent.click(screen.getByText('similarGyms.claim'));

    expect(screen.getByTestId('claim-dialog').textContent).toBe('claiming Bahnhof Bloc');
  });

  it('reports the claim CTA click under the similar-gyms placement', async () => {
    mockRequest.mockResolvedValueOnce({ findSimilarGyms: [gymFixture()] });

    renderSuggestions();

    await waitFor(() => expect(screen.getByText('similarGyms.claim')).toBeTruthy(), { timeout: 3000 });
    fireEvent.click(screen.getByText('similarGyms.claim'));

    // The uuid is the SUGGESTED gym's, not the one being created — this list is
    // the create-gym form's duplicate check.
    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym Claim CTA Clicked',
      properties: { placement: 'similar-gyms', viewerState: 'signed-in', gymUuid: 'gym-1' },
    });
  });

  it('renders nothing while the name is too short to query', () => {
    const { container } = renderSuggestions('ab');
    expect(container.firstChild).toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import type { SimilarGym } from '@boardsesh/shared-schema';

// Minimal i18n: echo the key (with {{var}} interpolation) so assertions target keys.
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
  useWsAuthToken: () => ({ token: 'test-token' }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  FIND_SIMILAR_GYMS: 'FIND_SIMILAR_GYMS',
  REPORT_GYM_DUPLICATE: 'REPORT_GYM_DUPLICATE',
}));

vi.mock('@boardsesh/gym-claim', () => ({
  GYM_CLAIM_MESSAGE_MAX_LENGTH: 1000,
}));

import ReportDuplicateDialog from '../report-duplicate-dialog';

const gymFixture = (overrides: Partial<SimilarGym> = {}): SimilarGym => ({
  uuid: 'gym-2',
  slug: 'bahnhof-bloc-annex',
  name: 'Bahnhof Bloc Annex',
  address: 'Zurich',
  website: null,
  distanceMeters: 60,
  ownerType: 'SYSTEM',
  isClaimable: false,
  canClaimByDomain: false,
  providerOrigins: ['kilter'],
  ...overrides,
});

// The FIND query returns suggestions; the REPORT mutation returns a status. Branch
// on the (mocked) operation constant so one mock serves both round-trips.
function wireRequests(opts: { suggestions: SimilarGym[]; reportStatus?: 'reported' | 'already_reported' }) {
  mockRequest.mockImplementation((operation: string) => {
    if (operation === 'REPORT_GYM_DUPLICATE') {
      return Promise.resolve({ reportGymDuplicate: { status: opts.reportStatus ?? 'reported' } });
    }
    return Promise.resolve({ findSimilarGyms: opts.suggestions });
  });
}

function renderDialog() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ReportDuplicateDialog
        gymUuid="gym-self"
        gymName="Bahnhof Bloc"
        latitude={47.0}
        longitude={8.0}
        open
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe('ReportDuplicateDialog', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('reuses findSimilarGyms for suggestions and never offers the gym itself', async () => {
    wireRequests({
      suggestions: [gymFixture(), gymFixture({ uuid: 'gym-self', name: 'This Very Gym' })],
    });

    renderDialog();

    // The seeded search (the gym's own name) fires the lookup after the debounce.
    await waitFor(() => expect(screen.getByText('Bahnhof Bloc Annex')).toBeTruthy(), { timeout: 3000 });
    // The current gym is filtered out of its own duplicate suggestions.
    expect(screen.queryByText('This Very Gym')).toBeNull();

    // The FIND query was seeded with the gym's own name.
    const findCall = mockRequest.mock.calls.find((call) => call[0] === 'FIND_SIMILAR_GYMS');
    expect(findCall?.[1]).toMatchObject({ input: { name: 'Bahnhof Bloc', latitude: 47.0, longitude: 8.0 } });
  });

  it('submits a report for the picked duplicate and confirms', async () => {
    wireRequests({ suggestions: [gymFixture()], reportStatus: 'reported' });

    renderDialog();

    await waitFor(() => expect(screen.getByText('Bahnhof Bloc Annex')).toBeTruthy(), { timeout: 3000 });

    // Submit is gated until a candidate is picked.
    expect(screen.getByText('reportDuplicate.submit').closest('button')?.disabled).toBe(true);

    fireEvent.click(screen.getByText('Bahnhof Bloc Annex'));
    await waitFor(() => expect(screen.getByText('reportDuplicate.submit').closest('button')?.disabled).toBe(false));

    fireEvent.click(screen.getByText('reportDuplicate.submit'));

    await waitFor(() => expect(screen.getByText('reportDuplicate.sent')).toBeTruthy(), { timeout: 3000 });

    const reportCall = mockRequest.mock.calls.find((call) => call[0] === 'REPORT_GYM_DUPLICATE');
    expect(reportCall?.[1]).toMatchObject({ input: { gymUuid: 'gym-self', duplicateGymUuid: 'gym-2' } });
  });

  it('shows the already-reported message when the pair was flagged before', async () => {
    wireRequests({ suggestions: [gymFixture()], reportStatus: 'already_reported' });

    renderDialog();

    await waitFor(() => expect(screen.getByText('Bahnhof Bloc Annex')).toBeTruthy(), { timeout: 3000 });
    fireEvent.click(screen.getByText('Bahnhof Bloc Annex'));
    fireEvent.click(screen.getByText('reportDuplicate.submit'));

    await waitFor(() => expect(screen.getByText('reportDuplicate.alreadyReported')).toBeTruthy(), { timeout: 3000 });
  });
});

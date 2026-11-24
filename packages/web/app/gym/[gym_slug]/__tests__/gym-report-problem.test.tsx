import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

const session = vi.hoisted(() => ({ status: 'authenticated' as 'authenticated' | 'unauthenticated' | 'loading' }));
vi.mock('@/app/components/providers/session-provider', () => ({
  useOptionalBrowserSession: () => ({
    data: session.status === 'authenticated' ? { user: { id: 'viewer' } } : null,
    status: session.status,
  }),
}));

const openAuthModal = vi.hoisted(() => vi.fn());
vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal }),
}));

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({ trackGymFunnelEvent }));

vi.mock('@/app/lib/i18n/use-locale-router', () => ({ useLocaleRouter: () => ({ refresh: vi.fn() }) }));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'test-token' }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request: vi.fn() }) }));

import { GymReportProblemHost, ReportBoardButton, ReportGymButton } from '../gym-report-problem';

const gym = { uuid: 'gym-1', name: 'Crux', slug: 'crux', listingState: 'RUN_BY_GYM' as const, canClaim: false };
const boards = [
  { uuid: 'board-a', name: 'Kilter', label: 'Kilter · Original 12x12 · 40°', ownerId: 'sam', setup: null },
  { uuid: 'board-b', name: 'Tension', label: 'Tension · TB2 · 30°', ownerId: null, setup: null },
];

function renderGymPage(hostGym = gym) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ReportBoardButton gymUuid="gym-1" boardUuid="board-a" boardName="Kilter" />
      <ReportGymButton gymUuid="gym-1" />
      <GymReportProblemHost gym={hostGym} boards={boards} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  session.status = 'authenticated';
  openAuthModal.mockReset();
  trackGymFunnelEvent.mockReset();
  window.history.replaceState(null, '', '/gym/crux');
});

describe('Report a problem on the gym page', () => {
  it('opens the dialog on a board from its row flag, naming the board and the gym', () => {
    renderGymPage();
    fireEvent.click(screen.getByRole('button', { name: 'Report a problem with Kilter' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Kilter at Crux')).toBeTruthy();
    // The other board at this gym is offered as the duplicate.
    fireEvent.click(screen.getByLabelText(/Listed twice/));
    expect(screen.getByLabelText('Tension · TB2 · 30°')).toBeTruthy();
    expect(trackGymFunnelEvent).toHaveBeenCalledWith(
      expect.objectContaining({ properties: { cta: 'report-problem', gymUuid: 'gym-1' } }),
    );
  });

  it('opens the gym report from the details button', () => {
    renderGymPage();
    fireEvent.click(screen.getByRole('button', { name: 'Report a problem' }));
    expect(screen.getByLabelText(/Closed for good/)).toBeTruthy();
  });

  it('ignores a button for another gym', () => {
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <ReportBoardButton gymUuid="gym-2" boardUuid="board-a" boardName="Kilter" />
        <GymReportProblemHost gym={gym} boards={boards} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Report a problem with Kilter' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends a signed-out climber through the login modal, back to this board', () => {
    session.status = 'unauthenticated';
    renderGymPage();
    fireEvent.click(screen.getByRole('button', { name: 'Report a problem with Kilter' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(openAuthModal).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Log in to report a problem', callbackUrl: '/gym/crux?report=board-a' }),
    );

    // Email and password sign in on the page: the dialog follows straight away.
    const { onSuccess } = openAuthModal.mock.calls[0][0] as { onSuccess: () => void };
    act(() => onSuccess());
    expect(screen.getByText('Kilter at Crux')).toBeTruthy();
  });

  it('reopens the dialog after a social sign-in lands back on ?report=', async () => {
    window.history.replaceState(null, '', '/gym/crux?report=gym');
    renderGymPage();
    expect(await screen.findByLabelText(/Closed for good/)).toBeTruthy();
  });
});

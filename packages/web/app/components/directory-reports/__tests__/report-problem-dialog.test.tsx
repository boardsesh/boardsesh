import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { ReportProblemTarget } from '../report-problem-logic';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token' }),
}));

vi.mock('@/app/components/providers/session-provider', () => ({
  useOptionalBrowserSession: () => ({ data: { user: { id: 'viewer' } }, status: 'authenticated' }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

import ReportProblemDialog from '../report-problem-dialog';
import { REPORT_BOARD, REPORT_GYM } from '@boardsesh/graphql/operations';

const boardTarget: ReportProblemTarget = {
  kind: 'board',
  board: { uuid: 'board-1', name: 'Kilter', ownerId: 'sam', ownerDisplayName: null },
  gym: { uuid: 'gym-1', name: 'Crux', slug: 'crux', listingState: 'RUN_BY_GYM', canClaim: false },
  otherBoards: [{ uuid: 'board-2', label: 'Kilter · Original 12x12 · 40°' }],
};

function renderDialog(target: ReportProblemTarget | null = boardTarget) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ReportProblemDialog open onClose={vi.fn()} target={target} />
    </QueryClientProvider>,
  );
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
}

describe('ReportProblemDialog', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('keeps Send off until a reason is picked, and says who will read it', () => {
    renderDialog();
    expect(screen.getByText('Kilter at Crux')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    // A climber's board at a gym run by the gym, the creator's name kept back.
    expect(screen.getByText('The climber who added this board and Crux staff will see this.')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Not on the wall anymore/));
    expect(sendButton().disabled).toBe(false);
  });

  it('asks which board is the same wall for a duplicate, and sends the pick', async () => {
    mockRequest.mockResolvedValue({
      reportBoard: { status: 'created', reportUuid: 'r1', routedTo: ['creator', 'gym_staff'], otherReporterCount: 0 },
    });
    renderDialog();
    fireEvent.click(screen.getByLabelText(/Listed twice/));
    expect(screen.getByText('Which board is the same wall?')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Kilter · Original 12x12 · 40°'));
    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByText("Sent. We'll tell you when it's sorted.")).toBeTruthy());
    expect(mockRequest).toHaveBeenCalledWith(REPORT_BOARD, {
      input: { boardUuid: 'board-1', reason: 'duplicate', duplicateOfBoardUuid: 'board-2', note: null },
    });
  });

  it('needs a note for Something else', () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText(/Something else/));
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Tell them what's wrong/), { target: { value: 'The wall is a 7x10 now' } });
    expect(sendButton().disabled).toBe(false);
  });

  it('tells a climber who joined others, and one who already reported', async () => {
    mockRequest.mockResolvedValueOnce({
      reportBoard: { status: 'added', reportUuid: 'r1', routedTo: ['creator'], otherReporterCount: 2 },
    });
    const { unmount } = renderDialog();
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText('2 other climbers flagged this too. Yours is added.')).toBeTruthy());
    unmount();

    mockRequest.mockResolvedValueOnce({
      reportBoard: { status: 'already_reported', reportUuid: 'r1', routedTo: ['creator'], otherReporterCount: 2 },
    });
    renderDialog();
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    fireEvent.click(sendButton());
    await waitFor(() =>
      expect(screen.getByText("You already reported this. We'll tell you when it's sorted.")).toBeTruthy(),
    );
  });

  it('says the report did not go through, never the server’s words', async () => {
    mockRequest.mockRejectedValue(new Error('Reporting a problem isn’t available yet.'));
    renderDialog();
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText("Your report didn't go through. Try again.")).toBeTruthy());
    expect(screen.queryByText('Reporting a problem isn’t available yet.')).toBeNull();
  });

  it('reports a gym, and offers the claim on a gym nobody runs', async () => {
    mockRequest.mockResolvedValue({
      reportGym: { status: 'created', reportUuid: 'r2', routedTo: ['admin'], otherReporterCount: 0 },
    });
    renderDialog({
      kind: 'gym',
      gym: { uuid: 'gym-1', name: 'Crux', slug: 'crux', listingState: 'UNCLAIMED', canClaim: true },
    });
    expect(screen.getByText('Our team will see this.')).toBeTruthy();
    expect(screen.getByText('Run Crux? Claim it and fix it yourself.').closest('a')?.getAttribute('href')).toContain(
      '/gym/crux?claim=1',
    );
    fireEvent.click(screen.getByLabelText(/Closed for good/));
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText("Sent. We'll tell you when it's sorted.")).toBeTruthy());
    expect(mockRequest).toHaveBeenCalledWith(REPORT_GYM, {
      input: { gymUuid: 'gym-1', reason: 'closed', duplicateOfGymUuid: null, note: null },
    });
  });

  it('shows a spinner while the page reads the board, and a retry when that failed', () => {
    const { unmount } = renderDialog(null);
    expect(screen.getByLabelText('Loading')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    unmount();

    const onRetry = vi.fn();
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <ReportProblemDialog open onClose={vi.fn()} target={null} loadFailed onRetryLoad={onRetry} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

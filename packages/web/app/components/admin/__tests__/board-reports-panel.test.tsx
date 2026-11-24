import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DirectoryReport } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'admin-token' }),
}));

vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ replace: vi.fn() }),
  usePathnameWithoutLocale: () => '/admin/board-reports',
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(),
}));

const mockShowMessage = vi.hoisted(() => vi.fn());
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

import BoardReportsPanel from '../board-reports-panel';

const escalated: DirectoryReport = {
  uuid: '0c7a7b1e-1f2b-4c3d-9e8f-001122334455',
  targetKind: 'board',
  reason: 'wrong_place',
  status: 'escalated',
  routedTo: ['creator', 'admin'],
  boardUuid: 'board-1',
  boardName: 'Garage Kilter',
  gymUuid: 'gym-1',
  gymName: 'Crux',
  reporterCount: 2,
  notes: [
    {
      note: 'This is a house, not a gym',
      createdAt: '2026-11-20T10:00:00.000Z',
      reporter: { userId: 'u1', displayName: 'Ana' },
    },
  ],
  createdAt: '2026-11-20T10:00:00.000Z',
  escalatesAt: '2026-12-04T10:00:00.000Z',
  viewerRole: 'admin',
  viewerIsReporter: false,
  viewerCanResolve: true,
};

function closedError(): Error {
  return Object.assign(new Error('This report is closed already.'), {
    response: { errors: [{ message: 'This report is closed already.', extensions: { code: 'REPORT_CLOSED' } }] },
  });
}

beforeEach(() => {
  mockRequest.mockReset();
  mockShowMessage.mockReset();
});

describe('BoardReportsPanel', () => {
  it('shows the reporters’ names to admins, beside their notes', async () => {
    mockRequest.mockResolvedValue({ adminDirectoryReports: { reports: [escalated], nextCursor: null } });
    render(<BoardReportsPanel highlightReportUuid={null} />);
    expect(await screen.findByText('Ana: This is a house, not a gym')).toBeTruthy();
    expect(screen.getByText('Garage Kilter at Crux')).toBeTruthy();
    expect(screen.getByText('Sent straight to us')).toBeTruthy();
  });

  it('deletes the board, then treats the report the delete already closed as done', async () => {
    mockRequest.mockImplementation(async (document: string) => {
      if (document.includes('adminDirectoryReports')) {
        return { adminDirectoryReports: { reports: [escalated], nextCursor: null } };
      }
      if (document.includes('deleteBoard')) return { deleteBoard: true };
      if (document.includes('resolveDirectoryReport')) throw closedError();
      return {};
    });
    render(<BoardReportsPanel highlightReportUuid={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete board' }));
    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText('Delete Garage Kilter for everyone?')).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete board' }));

    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith('Board deleted. The report is closed.', 'success'),
    );
    const calls = mockRequest.mock.calls.map(([document]) => String(document));
    const deleteIndex = calls.findIndex((document) => document.includes('deleteBoard'));
    const resolveIndex = calls.findIndex((document) => document.includes('resolveDirectoryReport'));
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(resolveIndex).toBeGreaterThan(deleteIndex);
    await waitFor(() => expect(screen.queryByText('Garage Kilter at Crux')).toBeNull());
  });

  it('keeps the row and says so when the action fails', async () => {
    mockRequest.mockImplementation(async (document: string) => {
      if (document.includes('adminDirectoryReports')) {
        return { adminDirectoryReports: { reports: [escalated], nextCursor: null } };
      }
      if (document.includes('detachBoardFromGym')) throw new Error('boom');
      return {};
    });
    render(<BoardReportsPanel highlightReportUuid={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from gym' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove from gym' }));

    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith("That didn't go through. Try again.", 'error'));
    expect(screen.getByText('Garage Kilter at Crux')).toBeTruthy();
    expect(mockRequest.mock.calls.some(([document]) => String(document).includes('resolveDirectoryReport'))).toBe(
      false,
    );
  });

  it('closes the report when the board already left the gym', async () => {
    mockRequest.mockImplementation(async (document: string) => {
      if (document.includes('adminDirectoryReports')) {
        return { adminDirectoryReports: { reports: [escalated], nextCursor: null } };
      }
      if (document.includes('detachBoardFromGym')) {
        throw Object.assign(new Error('This board is not listed at this gym.'), {
          response: {
            errors: [{ message: 'This board is not listed at this gym.', extensions: { code: 'BAD_USER_INPUT' } }],
          },
        });
      }
      return { resolveDirectoryReport: { ...escalated, status: 'removed' } };
    });
    render(<BoardReportsPanel highlightReportUuid={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from gym' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove from gym' }));

    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith('Removed from the gym. The report is closed.', 'success'),
    );
    expect(mockRequest).toHaveBeenCalledWith(expect.stringContaining('resolveDirectoryReport'), {
      input: { reportUuid: escalated.uuid, outcome: 'removed', note: null },
    });
  });

  it('keeps a report with the admin’s note', async () => {
    mockRequest.mockImplementation(async (document: string) => {
      if (document.includes('adminDirectoryReports')) {
        return { adminDirectoryReports: { reports: [escalated], nextCursor: null } };
      }
      return { resolveDirectoryReport: { ...escalated, status: 'kept' } };
    });
    render(<BoardReportsPanel highlightReportUuid={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep as it is' }));
    const confirm = await screen.findByRole('dialog');
    fireEvent.change(within(confirm).getByLabelText('A note for them (optional)'), {
      target: { value: ' It is a public wall ' },
    });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep as it is' }));

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith(expect.stringContaining('resolveDirectoryReport'), {
        input: { reportUuid: escalated.uuid, outcome: 'kept', note: 'It is a public wall' },
      }),
    );
  });
});

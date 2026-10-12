import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AppFeedbackReport } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import FeedbackPanel from '../feedback-panel';

const request = vi.fn();
const translate = (key: string, options?: Record<string, unknown>) => tFromCatalog('admin', key, options);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'admin-token' }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request }) }));
vi.mock('@boardsesh/graphql/operations', () => ({ ADMIN_APP_FEEDBACK: 'LIST', UPDATE_APP_FEEDBACK_STATUS: 'UPDATE' }));
const report: AppFeedbackReport = {
  id: '1',
  source: 'share-bug',
  platform: 'ios',
  createdAt: '2026-10-11T00:00:00Z',
  status: 'new',
  comment: 'Shared a broken screen',
  screenshotUrls: ['https://media.boardsesh.com/image.jpg'],
  recordingUrls: ['https://media.boardsesh.com/movie.mov'],
};
beforeEach(() => {
  vi.clearAllMocks();
});
describe('feedback admin attachment triage', () => {
  it('shows share-bug as a bug and retains playable recordings after marking done', async () => {
    request
      .mockResolvedValueOnce({
        adminAppFeedback: {
          reports: [report],
          totalCount: 1,
          hasMore: false,
          statusCounts: { new: 1, inProgress: 0, resolved: 0, wontFix: 0 },
        },
      })
      .mockResolvedValueOnce({ updateAppFeedbackStatus: { ...report, status: 'resolved' } });
    render(<FeedbackPanel />);
    await screen.findByText('Shared a broken screen');
    expect(screen.getByText('Bug')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle details' }));
    expect(screen.getByRole('link', { name: 'Recording 1' }).getAttribute('href')).toBe(report.recordingUrls[0]);
    const video = screen.getByLabelText('Recording 1');
    expect(video.tagName).toBe('VIDEO');
    expect(video.hasAttribute('controls')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await screen.findByText('Status updated');
    expect(screen.getByRole('link', { name: 'Recording 1' })).toBeTruthy();
    expect(screen.getByAltText('Screenshot 1')).toBeTruthy();
    expect(request).toHaveBeenLastCalledWith('UPDATE', { input: { id: report.id, status: 'resolved' } });
  });
});

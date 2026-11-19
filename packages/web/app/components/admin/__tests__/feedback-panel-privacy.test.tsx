import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { ClientError } from 'graphql-request';
import { GraphQLError } from 'graphql';
import FeedbackPanel from '../feedback-panel';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'fixture-admin' }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it('retains retry feedback and omits a private search carried inside ClientError from the console', async () => {
  const marker = 'private-browser-search-fixture';
  request.mockImplementation(async (_document, variables) => {
    if (variables.input.search) {
      const error = new ClientError(
        { status: 503, headers: new Headers(), errors: [new GraphQLError('Unavailable')], body: '' },
        { query: 'query AdminAppFeedback', variables },
      );
      expect(error.message).toContain(marker);
      throw error;
    }
    return {
      adminAppFeedback: {
        reports: [],
        hasMore: false,
        totalCount: 0,
        statusCounts: { new: 0, inProgress: 0, resolved: 0, wontFix: 0 },
      },
    };
  });
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(<FeedbackPanel />);
    const search = screen.getByPlaceholderText('feedback.search.placeholder');
    expect(search.closest('.rr-block.sentry-block.ph-no-capture')).toBeTruthy();
    fireEvent.change(search, { target: { value: marker } });
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(logged).toHaveBeenCalledWith('[FeedbackPanel] Failed to fetch feedback');
    expect(logged.mock.calls.flat().map(String).join(' ')).not.toContain(marker);
  } finally {
    logged.mockRestore();
  }
});

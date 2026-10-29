import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  GET_MY_PROJECT_NEWS_EMAIL_CONSENT,
  SET_PROJECT_NEWS_EMAIL_CONSENT,
} from '@boardsesh/graphql/operations/project-news-email';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import ProjectNewsEmailCard from '../project-news-email-card';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'u1' } }, status: 'authenticated' }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'token-1', isLoading: false, error: null }),
}));

const mockExecuteGraphQL = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  executeGraphQL: (...args: unknown[]) => mockExecuteGraphQL(...args),
}));

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectNewsEmailCard />
    </QueryClientProvider>,
  );
}

function answerWith(subscribed: boolean | null, saveResult?: { subscribed: boolean } | Error) {
  mockExecuteGraphQL.mockImplementation(async (document: unknown) => {
    if (document === GET_MY_PROJECT_NEWS_EMAIL_CONSENT) {
      return {
        myProjectNewsEmailConsent:
          subscribed === null
            ? { subscribed: false, decidedAt: null }
            : { subscribed, decidedAt: '2026-11-20T10:00:00.000Z' },
      };
    }
    if (document === SET_PROJECT_NEWS_EMAIL_CONSENT) {
      if (saveResult instanceof Error) throw saveResult;
      return { setProjectNewsEmailConsent: { ...saveResult, decidedAt: '2026-11-21T10:00:00.000Z' } };
    }
    throw new Error('unexpected document');
  });
}

const toggleLabel = tFromCatalog('settings', 'projectNews.toggle');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProjectNewsEmailCard', () => {
  it('is off for a climber who never answered, and says what they would get', async () => {
    answerWith(null);
    renderCard();
    const toggle = screen.getByLabelText(toggleLabel) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(tFromCatalog('settings', 'projectNews.description'))).toBeTruthy();
  });

  it('stays disabled until the account answer loads', () => {
    mockExecuteGraphQL.mockReturnValue(new Promise(() => undefined));
    renderCard();
    expect((screen.getByLabelText(toggleLabel) as HTMLInputElement).disabled).toBe(true);
  });

  it('turns it on with the web as the source', async () => {
    answerWith(false, { subscribed: true });
    renderCard();
    const toggle = screen.getByLabelText(toggleLabel) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(mockExecuteGraphQL).toHaveBeenCalledWith(
      SET_PROJECT_NEWS_EMAIL_CONSENT,
      { input: { subscribed: true, source: 'web' } },
      'token-1',
    );
  });

  it('says so when the save fails and shows the saved answer again', async () => {
    answerWith(true, new Error('network'));
    renderCard();
    const toggle = screen.getByLabelText(toggleLabel) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText(tFromCatalog('settings', 'projectNews.saveFailed'))).toBeTruthy());
    expect(toggle.checked).toBe(true);
  });
});

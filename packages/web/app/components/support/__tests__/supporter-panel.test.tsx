// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MySupporterStatus } from '@boardsesh/graphql/operations/support';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import SupporterPanel from '../supporter-panel';
import { linkOutcomeFromError, linkOutcomeFromStatus } from '../use-supporter-status';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

type SessionState = { data: { user: { id: string; email: string } } | null; status: string };
const session = vi.hoisted(() => ({ current: null as SessionState | null }));
vi.mock('next-auth/react', () => ({
  useSession: () => session.current,
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({
    token: session.current?.status === 'authenticated' ? 'session-jwt' : null,
    isAuthenticated: session.current?.status === 'authenticated',
    isLoading: false,
    error: null,
  }),
}));

const executeGraphQL = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/client', () => ({ executeGraphQL }));

const NO_SUPPORT: MySupporterStatus = {
  isSupporter: false,
  showPublicly: false,
  source: null,
  creditUntil: null,
  hasSubscription: false,
  cancelAtPeriodEnd: false,
};
const GIFT_UNTIL_MARCH: MySupporterStatus = {
  ...NO_SUPPORT,
  isSupporter: true,
  source: 'stripe',
  creditUntil: '2027-03-15T12:00:00.000Z',
};

function operationName(document: unknown): string {
  const match = /(query|mutation)\s+(\w+)/.exec(String(document));
  return match?.[2] ?? 'unknown';
}

/** Answers the panel's GraphQL calls by operation name. */
function backend(handlers: Record<string, (variables: Record<string, unknown>) => unknown>) {
  executeGraphQL.mockImplementation(async (document: unknown, variables: Record<string, unknown>) => {
    const handler = handlers[operationName(document)];
    if (!handler) throw new Error(`unexpected ${operationName(document)}`);
    return handler(variables);
  });
}

function signedIn() {
  session.current = { data: { user: { id: 'user-1', email: 'climber@example.com' } }, status: 'authenticated' };
}

function renderPanel(variant: 'thanks' | 'settings') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SupporterPanel variant={variant} />
    </QueryClientProvider>,
  );
}

function settingsText(key: string, options?: Record<string, unknown>): string {
  return tFromCatalog('settings', key, options);
}

function graphqlError(code: string): Error {
  return Object.assign(new Error(code), { response: { errors: [{ message: code, extensions: { code } }] } });
}

beforeEach(() => {
  executeGraphQL.mockReset();
  session.current = { data: null, status: 'unauthenticated' };
});

afterEach(cleanup);

describe('SupporterPanel signed out', () => {
  it('invites a giver on the thank-you card to sign in and come back', () => {
    const { container } = renderPanel('thanks');

    expect(screen.getByText(settingsText('supporter.signedOut.body'))).toBeTruthy();
    const signIn = container.querySelector('a');
    expect(signIn?.getAttribute('href')).toBe(`/auth/login?callbackUrl=${encodeURIComponent('/support?thanks=1')}`);
    expect(executeGraphQL).not.toHaveBeenCalled();
  });

  it('renders nothing on settings', () => {
    const { container } = renderPanel('settings');

    expect(container.textContent).toBe('');
  });
});

describe('SupporterPanel signed in', () => {
  beforeEach(signedIn);

  it('says when no gift is linked yet, with credit off', async () => {
    backend({ GetMySupporterStatus: () => ({ mySupporterStatus: NO_SUPPORT }) });

    renderPanel('settings');

    expect(await screen.findByText(settingsText('supporter.status.none'))).toBeTruthy();
    const toggle = screen.getByRole('switch') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(settingsText('supporter.visibility.hint'))).toBeTruthy();
  });

  it('tells a giver on the thank-you card that Stripe may still be confirming', async () => {
    backend({ GetMySupporterStatus: () => ({ mySupporterStatus: NO_SUPPORT }) });

    renderPanel('thanks');

    expect(await screen.findByText(settingsText('supporter.status.confirming'))).toBeTruthy();
  });

  it('shows when one-off time runs out', async () => {
    backend({ GetMySupporterStatus: () => ({ mySupporterStatus: GIFT_UNTIL_MARCH }) });

    renderPanel('settings');

    expect(await screen.findByTestId('supporter-status')).toBeTruthy();
    expect(screen.getByTestId('supporter-status').textContent).toBe(
      settingsText('supporter.status.until', { date: 'March 15, 2027' }),
    );
  });

  it('names a monthly subscription that is ending', async () => {
    backend({
      GetMySupporterStatus: () => ({
        mySupporterStatus: { ...NO_SUPPORT, isSupporter: true, hasSubscription: true, cancelAtPeriodEnd: true },
      }),
    });

    renderPanel('settings');

    expect(await screen.findByText(settingsText('supporter.status.monthlyEnding'))).toBeTruthy();
  });

  it('turns public credit on through updateSupporterVisibility', async () => {
    const update = vi.fn((variables: Record<string, unknown>) => ({
      updateSupporterVisibility: { ...NO_SUPPORT, showPublicly: variables.showPublicly },
    }));
    backend({ GetMySupporterStatus: () => ({ mySupporterStatus: NO_SUPPORT }), UpdateSupporterVisibility: update });

    renderPanel('thanks');
    fireEvent.click(await screen.findByRole('switch'));

    await waitFor(() => expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true));
    expect(update).toHaveBeenCalledWith({ showPublicly: true });
  });

  it('says so when the switch did not save', async () => {
    backend({
      GetMySupporterStatus: () => ({ mySupporterStatus: NO_SUPPORT }),
      UpdateSupporterVisibility: () => {
        throw new Error('backend down');
      },
    });

    renderPanel('settings');
    fireEvent.click(await screen.findByRole('switch'));

    expect(await screen.findByText(settingsText('supporter.visibility.error'))).toBeTruthy();
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);
  });

  it('links a past gift by email and shows what it found', async () => {
    backend({
      GetMySupporterStatus: () => ({ mySupporterStatus: NO_SUPPORT }),
      ClaimSupporterByEmail: () => ({ claimSupporterByEmail: GIFT_UNTIL_MARCH }),
    });

    renderPanel('settings');
    await screen.findByTestId('supporter-status');
    fireEvent.click(screen.getByText(settingsText('supporter.link.cta')));

    expect((await screen.findByTestId('supporter-link-outcome')).textContent).toBe(
      settingsText('supporter.link.linked'),
    );
    expect(screen.getByTestId('supporter-status').textContent).toBe(
      settingsText('supporter.status.until', { date: 'March 15, 2027' }),
    );
  });

  // Honest about a miss: it names the email it searched with.
  it('says nothing was found for the account email', async () => {
    backend({
      GetMySupporterStatus: () => ({ mySupporterStatus: NO_SUPPORT }),
      ClaimSupporterByEmail: () => ({ claimSupporterByEmail: NO_SUPPORT }),
    });

    renderPanel('thanks');
    await screen.findByTestId('supporter-status');
    fireEvent.click(screen.getByText(settingsText('supporter.link.cta')));

    expect((await screen.findByTestId('supporter-link-outcome')).textContent).toBe(
      settingsText('supporter.link.notFound', { email: 'climber@example.com' }),
    );
  });

  it('asks for a verified email when the backend refuses an unverified one', async () => {
    backend({
      GetMySupporterStatus: () => ({ mySupporterStatus: NO_SUPPORT }),
      ClaimSupporterByEmail: () => {
        throw graphqlError('EMAIL_NOT_VERIFIED');
      },
    });

    renderPanel('settings');
    await screen.findByTestId('supporter-status');
    fireEvent.click(screen.getByText(settingsText('supporter.link.cta')));

    expect((await screen.findByTestId('supporter-link-outcome')).textContent).toBe(
      settingsText('supporter.link.emailNotVerified'),
    );
  });

  it('says the status could not load instead of spinning', async () => {
    backend({
      GetMySupporterStatus: () => {
        throw new Error('backend down');
      },
    });

    renderPanel('settings');

    expect(await screen.findByText(settingsText('supporter.status.error'))).toBeTruthy();
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true);
  });

  it('never promises anything for the tag', async () => {
    backend({ GetMySupporterStatus: () => ({ mySupporterStatus: GIFT_UNTIL_MARCH }) });

    const { container } = renderPanel('thanks');
    await screen.findByTestId('supporter-status');

    expect(container.textContent).not.toMatch(/unlock|early access|priority|premium|faster|perk/i);
  });
});

describe('link outcomes', () => {
  it.each([
    [GIFT_UNTIL_MARCH, 'linked'],
    [{ ...NO_SUPPORT, source: 'stripe' }, 'expired'],
    [NO_SUPPORT, 'notFound'],
  ] as const)('reads %j as %s', (status, outcome) => {
    expect(linkOutcomeFromStatus(status)).toBe(outcome);
  });

  it.each([
    ['EMAIL_NOT_VERIFIED', 'emailNotVerified'],
    ['SERVICE_UNAVAILABLE', 'unavailable'],
    ['RATE_LIMITED', 'rateLimited'],
    ['INTERNAL_SERVER_ERROR', 'failed'],
  ])('maps %s to %s', (code, outcome) => {
    expect(linkOutcomeFromError(graphqlError(code))).toBe(outcome);
  });
});

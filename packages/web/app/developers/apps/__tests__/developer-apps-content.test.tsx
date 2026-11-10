import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PARTNER_DEVELOPER_TERMS_VERSION } from '@boardsesh/auth-protocol/partner-oauth';
import type { OAuthClient } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  showMessage: vi.fn(),
  writeText: vi.fn(),
  token: { current: 'developer-token' as string | null },
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'developer' } }, status: 'authenticated' }),
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: mocks.token.current, isLoading: false }),
}));
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mocks.showMessage }),
}));
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mocks.request }),
}));

const { default: DeveloperAppsContent } = await import('../developer-apps-content');

const SECRET = 'NewlyMintedSecretShownExactlyOnceZ';

function app(overrides: Partial<OAuthClient> = {}): OAuthClient {
  return {
    clientId: 'bsk_planner',
    name: 'Hangboard Planner',
    publisherName: 'Planner Labs',
    homepageUrl: 'https://planner.example/',
    privacyPolicyUrl: 'https://planner.example/privacy',
    applicationType: 'WEB',
    tokenEndpointAuthMethod: 'CLIENT_SECRET_BASIC',
    redirectUris: ['https://planner.example/oauth/boardsesh'],
    createdAt: '2026-11-10T09:00:00.000Z',
    suspendedAt: null,
    suspensionReason: null,
    maxActiveConnections: 25,
    maxNewConnectionsPerDay: 20,
    activeConnections: 3,
    ...overrides,
  };
}

/** Answers each operation by its name, as the backend would. */
function serve(handlers: Record<string, (variables: Record<string, unknown>) => unknown>) {
  mocks.request.mockImplementation(async (document: string, variables: Record<string, unknown> = {}) => {
    const name = Object.keys(handlers).find((operation) => String(document).includes(operation));
    if (!name) throw new Error(`Unexpected operation ${String(document).slice(0, 60)}`);
    return handlers[name](variables);
  });
}

function graphQLRefusal(extensions: Record<string, unknown>, message = 'Refused') {
  return Object.assign(new Error(message), { response: { errors: [{ message, extensions }] } });
}

let queryClient: QueryClient;

function renderConsole() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DeveloperAppsContent />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.request.mockReset();
  mocks.showMessage.mockReset();
  mocks.token.current = 'developer-token';
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: mocks.writeText.mockReset().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  queryClient?.clear();
});

describe('DeveloperAppsContent', () => {
  it('offers to register a first app when there are none', async () => {
    serve({ MyOAuthClients: () => ({ myOAuthClients: [] }) });
    renderConsole();
    expect(await screen.findByText('No apps yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Register your first app' })).toBeTruthy();
  });

  it('lists each app with its publisher, client ID, client type and connected climbers', async () => {
    serve({ MyOAuthClients: () => ({ myOAuthClients: [app()] }) });
    renderConsole();
    const card = await screen.findByRole('listitem', { name: 'Hangboard Planner' });
    const scoped = within(card);
    expect(scoped.getByText('Made by Planner Labs')).toBeTruthy();
    expect(scoped.getByRole('textbox', { name: 'Client ID' }).textContent).toBe('bsk_planner');
    expect(scoped.getByText('Confidential: secret in an HTTP Basic header')).toBeTruthy();
    expect(scoped.getByText('3 of 25 climbers connected')).toBeTruthy();
    expect(scoped.getByRole('button', { name: 'New secret' })).toBeTruthy();
  });

  it('says plainly when the account is not invited, instead of an empty list', async () => {
    mocks.request.mockRejectedValue(graphQLRefusal({ code: 'FORBIDDEN', reason: 'NOT_ALLOWLISTED' }));
    renderConsole();
    expect(await screen.findByText('App registration is invite-only for now')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Register an app' })).toBeNull();
  });

  it('shows a new secret once, warns it will not be shown again, and keeps it out of the query cache', async () => {
    let createdInput: Record<string, unknown> | undefined;
    serve({
      MyOAuthClients: () => ({ myOAuthClients: [] }),
      CreateOAuthClient: ({ input }) => {
        createdInput = input as Record<string, unknown>;
        return { createOAuthClient: { client: app({ activeConnections: 0 }), clientSecret: SECRET } };
      },
    });
    renderConsole();
    fireEvent.click(await screen.findByRole('button', { name: 'Register your first app' }));
    const form = await screen.findByRole('dialog', { name: 'Register an app' });
    fireEvent.change(within(form).getByLabelText(/App name/), { target: { value: 'Hangboard Planner' } });
    fireEvent.change(within(form).getByLabelText(/Publisher/), { target: { value: 'Planner Labs' } });
    fireEvent.change(within(form).getByLabelText(/Privacy policy URL/), {
      target: { value: 'https://planner.example/privacy' },
    });
    fireEvent.change(within(form).getByLabelText(/Redirect URIs/), {
      target: { value: 'https://planner.example/oauth/boardsesh' },
    });
    fireEvent.click(within(form).getByRole('checkbox', { name: /I accept the Boardsesh developer terms/ }));
    fireEvent.click(within(form).getByRole('button', { name: 'Register app' }));

    const reveal = await screen.findByRole('dialog', { name: 'Hangboard Planner is registered' });
    expect(createdInput).toMatchObject({
      publisherName: 'Planner Labs',
      tokenEndpointAuthMethod: 'CLIENT_SECRET_BASIC',
      acceptedTermsVersion: PARTNER_DEVELOPER_TERMS_VERSION,
    });
    expect(within(reveal).getByText("Copy the client secret now. Boardsesh won't show it again.")).toBeTruthy();
    expect(within(reveal).getByRole('textbox', { name: 'Client secret' }).textContent).toBe(SECRET);
    fireEvent.click(within(reveal).getAllByRole('button', { name: 'Copy' })[1]);
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(SECRET));
    // Neither the query cache nor the address bar ever holds it.
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(SECRET);
    expect(window.location.href).not.toContain(SECRET);

    fireEvent.click(within(reveal).getByRole('button', { name: "I've stored the secret" }));
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());
    expect(await screen.findByRole('listitem', { name: 'Hangboard Planner' })).toBeTruthy();
  });

  it('registers nothing until the developer accepts the terms, and links to them', async () => {
    const create = vi.fn();
    serve({ MyOAuthClients: () => ({ myOAuthClients: [] }), CreateOAuthClient: create });
    renderConsole();
    fireEvent.click(await screen.findByRole('button', { name: 'Register your first app' }));
    const form = await screen.findByRole('dialog', { name: 'Register an app' });
    const termsLink = within(form).getByRole('link', { name: /Read the developer terms/ });
    expect(termsLink.getAttribute('href')).toBe('/developers/terms');
    expect(termsLink.getAttribute('target')).toBe('_blank');
    fireEvent.change(within(form).getByLabelText(/App name/), { target: { value: 'Hangboard Planner' } });
    fireEvent.change(within(form).getByLabelText(/Publisher/), { target: { value: 'Planner Labs' } });
    fireEvent.change(within(form).getByLabelText(/Privacy policy URL/), {
      target: { value: 'https://planner.example/privacy' },
    });
    fireEvent.change(within(form).getByLabelText(/Redirect URIs/), {
      target: { value: 'https://planner.example/oauth/boardsesh' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Register app' }));
    expect(await within(form).findByText('Accept the developer terms to register an app.')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not ask an edit to accept the terms again', async () => {
    serve({ MyOAuthClients: () => ({ myOAuthClients: [app()] }) });
    renderConsole();
    const card = await screen.findByRole('listitem', { name: 'Hangboard Planner' });
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    const form = await screen.findByRole('dialog', { name: 'Edit Hangboard Planner' });
    expect(within(form).queryByRole('checkbox', { name: /developer terms/ })).toBeNull();
  });

  it("shows the server's refusal inside the form and keeps what the developer typed", async () => {
    serve({
      MyOAuthClients: () => ({ myOAuthClients: [app()] }),
      UpdateOAuthClient: () => {
        throw graphQLRefusal(
          { code: 'BAD_USER_INPUT', reason: 'INVALID_INPUT' },
          'The publisher name cannot use or imitate "Boardsesh".',
        );
      },
    });
    renderConsole();
    const card = await screen.findByRole('listitem', { name: 'Hangboard Planner' });
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    const form = await screen.findByRole('dialog', { name: 'Edit Hangboard Planner' });
    fireEvent.change(within(form).getByLabelText(/Publisher/), { target: { value: 'Boardsesh Team' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByText('The publisher name cannot use or imitate "Boardsesh".')).toBeTruthy();
    expect((within(form).getByLabelText(/Publisher/) as HTMLInputElement).value).toBe('Boardsesh Team');
  });

  it('asks before deleting, says how many climbers it disconnects, then removes the app', async () => {
    let deleted: unknown;
    serve({
      MyOAuthClients: () => ({ myOAuthClients: deleted ? [] : [app()] }),
      DeleteOAuthClient: ({ clientId }) => {
        deleted = clientId;
        return { deleteOAuthClient: true };
      },
    });
    renderConsole();
    const card = await screen.findByRole('listitem', { name: 'Hangboard Planner' });
    fireEvent.click(within(card).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Hangboard Planner?' });
    expect(
      within(confirm).getByText(
        '3 climbers are connected. Deleting the app disconnects all of them at once, and their tokens stop working.',
      ),
    ).toBeTruthy();
    expect(deleted).toBeUndefined();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete app' }));
    await waitFor(() => expect(deleted).toBe('bsk_planner'));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Hangboard Planner' })).toBeNull());
    expect(mocks.showMessage).toHaveBeenCalledWith('Hangboard Planner deleted', 'success');
  });

  it('rotates a secret only after a confirmation that says the old one stops at once', async () => {
    serve({
      MyOAuthClients: () => ({ myOAuthClients: [app()] }),
      RotateOAuthClientSecret: () => ({ rotateOAuthClientSecret: { client: app(), clientSecret: SECRET } }),
    });
    renderConsole();
    const card = await screen.findByRole('listitem', { name: 'Hangboard Planner' });
    fireEvent.click(within(card).getByRole('button', { name: 'New secret' }));
    const confirm = await screen.findByRole('dialog', { name: 'Make a new secret for Hangboard Planner?' });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Make new secret' }));
    const reveal = await screen.findByRole('dialog', { name: 'New secret for Hangboard Planner' });
    expect(within(reveal).getByRole('textbox', { name: 'Client secret' }).textContent).toBe(SECRET);
    expect(
      within(reveal).getByText(
        "The old secret has stopped working. Copy the new one now: Boardsesh won't show it again.",
      ),
    ).toBeTruthy();
  });

  it('offers no change to a suspended app, and says why', async () => {
    serve({
      MyOAuthClients: () => ({
        myOAuthClients: [app({ suspendedAt: '2026-11-10T10:00:00.000Z', suspensionReason: 'Phishing reports' })],
      }),
    });
    renderConsole();
    const card = await screen.findByRole('listitem', { name: 'Hangboard Planner' });
    expect(
      within(card).getByText("This app gets no tokens and can't be changed or deleted. Reason: Phishing reports"),
    ).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

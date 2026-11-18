import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { PartnerWebhookSettings } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({ request: vi.fn(), token: 'token-a', userId: 'developer-a' }));
const translations = {
  t: (key: string, options?: Record<string, unknown>) => tFromCatalog('developers', key, options),
};
vi.mock('react-i18next', () => ({ useTranslation: () => translations }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: mocks.userId } } }) }));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: mocks.token }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request: mocks.request }) }));
vi.mock('@boardsesh/graphql/operations', () => ({
  GET_PARTNER_WEBHOOK_SETTINGS: 'SETTINGS',
  GET_PARTNER_WEBHOOK_DELIVERIES: 'DELIVERIES',
  UPDATE_PARTNER_WEBHOOK: 'SAVE',
  ROTATE_PARTNER_WEBHOOK_SECRET: 'ROTATE',
  TEST_PARTNER_WEBHOOK: 'TEST',
}));
vi.mock('../sign-in-again-dialog', () => ({
  default: ({ fromWebhook }: { fromWebhook: boolean }) => (
    <div role="alert">{fromWebhook ? 'Webhook sign-in required' : 'Sign-in required'}</div>
  ),
}));
const { default: WebhookDialog } = await import('../webhook-dialog');

const settings: PartnerWebhookSettings = {
  clientId: 'app',
  url: 'https://partner.example/hooks',
  enabled: true,
  events: ['logbook.changed'],
  disabledReason: null,
  previousSecretExpiresAt: null,
};
const onClose = vi.fn();
let configured: PartnerWebhookSettings | null;

beforeEach(() => {
  mocks.token = 'token-a';
  mocks.userId = 'developer-a';
  configured = settings;
  onClose.mockReset();
  mocks.request.mockReset().mockImplementation(async (operation: string) => {
    if (operation === 'SETTINGS') return { partnerWebhookSettings: configured };
    if (operation === 'DELIVERIES')
      return {
        partnerWebhookDeliveries: [
          {
            id: 'delivery',
            event: 'logbook.changed',
            status: 'delivered',
            attempts: 2,
            lastStatusCode: 204,
            lastError: null,
            createdAt: '2026-11-17T12:00:00Z',
            deliveredAt: '2026-11-17T12:00:01Z',
          },
        ],
      };
    if (operation === 'TEST') return { testPartnerWebhook: 'event-test' };
    if (operation === 'ROTATE') return { rotatePartnerWebhookSecret: { settings, secret: 'new-signing-secret' } };
    return { updatePartnerWebhook: { settings, secret: null } };
  });
});

const show = () => render(<WebhookDialog clientId="app" appName="Planner" onClose={onClose} />);
const ready = () => screen.findByRole('textbox', { name: 'HTTPS endpoint URL' });

describe('developer webhook settings', () => {
  it('loads owned settings and delivery outcomes without exposing a secret', async () => {
    show();
    await ready();
    expect((screen.getByRole('textbox', { name: 'HTTPS endpoint URL' }) as HTMLInputElement).value).toBe(settings.url);
    expect(screen.getByText('logbook.changed · Delivered · 2 attempts · HTTP 204')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Webhook signing secret' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send test delivery' }));
    expect(await screen.findByText('Test delivery queued. Refresh the delivery list to see its result.')).toBeTruthy();
    expect(mocks.request).toHaveBeenCalledWith('TEST', { clientId: 'app' });
  });

  it('reveals new secrets once and requires acknowledgement before closing', async () => {
    show();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate signing secret' }));
    expect(await screen.findByRole('textbox', { name: 'Webhook signing secret' })).toBeTruthy();
    expect(screen.getByText('new-signing-secret')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: "I've stored the secret" }));
    expect(screen.queryByText('new-signing-secret')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('can create an endpoint and refuses invalid URL forms or no selected events', async () => {
    configured = null;
    show();
    const url = await ready();
    expect((screen.getByRole('button', { name: 'Save webhook' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(url, { target: { value: 'http://partner.example/hooks' } });
    expect((screen.getByRole('button', { name: 'Save webhook' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(url, { target: { value: 'https://partner.example/hooks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save webhook' }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith('SAVE', {
        input: {
          clientId: 'app',
          url: 'https://partner.example/hooks',
          events: ['logbook.changed', 'workout.completed', 'connection.revoked'],
          enabled: true,
        },
      }),
    );
  });

  it('shows a recent-sign-in recovery and preserves the entered endpoint', async () => {
    show();
    const url = await ready();
    fireEvent.change(url, { target: { value: 'https://new.example/hooks' } });
    mocks.request.mockRejectedValueOnce({
      response: { errors: [{ extensions: { code: 'FORBIDDEN', reason: 'RECENT_SIGN_IN_REQUIRED' } }] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save webhook' }));
    expect(await screen.findByText('Webhook sign-in required')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'HTTPS endpoint URL' }) as HTMLInputElement).value).toBe(
      'https://new.example/hooks',
    );
  });

  it('does not show a mutation secret after the signed-in account changes', async () => {
    const view = show();
    await ready();
    let resolveRotation: (result: unknown) => void = () => undefined;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRotation = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rotate signing secret' }));
    mocks.userId = 'developer-b';
    mocks.token = 'token-b';
    configured = null;
    view.rerender(<WebhookDialog clientId="app" appName="Planner" onClose={onClose} />);
    await ready();
    resolveRotation({ rotatePartnerWebhookSecret: { settings, secret: 'old-account-secret' } });
    await waitFor(() => expect(screen.queryByText('old-account-secret')).toBeNull());
    expect(screen.queryByRole('textbox', { name: 'Webhook signing secret' })).toBeNull();
  });
});

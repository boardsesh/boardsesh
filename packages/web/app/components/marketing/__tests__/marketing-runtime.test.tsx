import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { MarketingRuntime } from '../marketing-runtime';

vi.mock('../marketing-account-runtime', () => ({
  default: ({ enableExpoAuthBridge }: { enableExpoAuthBridge?: boolean }) => (
    <output>{String(enableExpoAuthBridge)}</output>
  ),
}));
vi.mock('@/app/lib/consent-pending-db', () => ({
  loadPendingConsent: async () => null,
  persistPendingConsent: async () => {},
}));
afterEach(cleanup);

it('passes the server Expo bridge setting through the asynchronously loaded account boundary', async () => {
  render(
    <MarketingRuntime enableExpoAuthBridge>
      <main>Public copy</main>
    </MarketingRuntime>,
  );
  expect(screen.getByText('Public copy')).toBeTruthy();
  expect((await screen.findByRole('status')).textContent).toBe('true');
});

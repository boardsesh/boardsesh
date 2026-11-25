import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { AdminCheck } from '@/app/lib/admin/check-admin';
import AdminPartnerAppsPage, { generateMetadata } from '@/app/(site)/admin/partner-apps/page';

const accessHolder = vi.hoisted(() => ({ access: { authenticated: false } as AdminCheck }));
vi.mock('@/app/lib/admin/check-admin', () => ({ checkAdmin: async () => accessHolder.access }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async (namespace: string) => ({
    locale: 'en-US',
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
  }),
}));
vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/app/components/admin/partner-apps-panel', () => ({
  default: () => <div>Partner app registry</div>,
}));

beforeEach(() => {
  accessHolder.access = { authenticated: false };
});

describe('AdminPartnerAppsPage', () => {
  it('withholds the registry from signed-out visitors', async () => {
    render(await AdminPartnerAppsPage());
    expect(screen.getByText('Please sign in to access the admin panel.')).toBeTruthy();
    expect(screen.queryByText('Partner app registry')).toBeNull();
  });

  it.each([false, true])('withholds the registry from nonglobal roles (board-scoped: %s)', async (boardScopedOnly) => {
    accessHolder.access = {
      authenticated: true,
      userId: 'scoped-admin',
      isAdmin: false,
      boardScopedOnly,
      hasGlobalAdmin: false,
    };
    render(await AdminPartnerAppsPage());
    expect(screen.queryByText('Partner app registry')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('renders the registry only for a global admin', async () => {
    accessHolder.access = {
      authenticated: true,
      userId: 'global-admin',
      isAdmin: true,
      boardScopedOnly: false,
      hasGlobalAdmin: true,
    };
    render(await AdminPartnerAppsPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Partner apps' })).toBeTruthy();
    expect(screen.getByText('Partner app registry')).toBeTruthy();
  });

  it('marks the utility route noindex with its own canonical', async () => {
    const metadata = await generateMetadata();
    expect(metadata.robots).toMatchObject({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe('/admin/partner-apps');
  });
});

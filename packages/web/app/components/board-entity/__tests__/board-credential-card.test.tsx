/**
 * W-21 (#4440): `BoardCredentialCard` moved here out of the deleted
 * `components/settings/aurora-credentials-section.tsx`. The one assertion worth
 * keeping from that file's test — Reconnect comes before Unlink on an expired
 * credential — now aims at the component directly instead of driving it through
 * a 1,500-line section, and the duplicate-circuits sync error is pinned because
 * it is the one sync-error code that must never be shown raw.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR } from '@boardsesh/shared-schema/sync-error-codes';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { BoardCredentialCard } from '../board-credential-card';
import type { AuroraCredentialStatus } from '@/app/lib/aurora-credentials/client';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

function credentialWith(overrides: Partial<AuroraCredentialStatus> = {}): AuroraCredentialStatus {
  return {
    boardType: 'tension',
    auroraUsername: 'tensionuser',
    auroraUserId: 42,
    lastSyncAt: null,
    syncStatus: 'active',
    syncError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderCard(credential: AuroraCredentialStatus | null) {
  return render(
    <BoardCredentialCard
      boardType="tension"
      variant="aurora"
      credential={credential}
      unsyncedCounts={{ ascents: 0, climbs: 0 }}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onImportJson={vi.fn()}
      isRemoving={false}
      isImporting={false}
    />,
  );
}

describe('BoardCredentialCard', () => {
  it('offers Link and Import, but no Unlink, when nothing is connected', () => {
    renderCard(null);

    expect(screen.getByRole('button', { name: tFromCatalog('settings', 'aurora.card.link') })).toBeTruthy();
    expect(screen.getByRole('button', { name: tFromCatalog('settings', 'aurora.card.import') })).toBeTruthy();
    expect(screen.queryByText(tFromCatalog('settings', 'aurora.card.unlink'))).toBeNull();
  });

  it('shows Reconnect before Unlink when the credential is expired', () => {
    renderCard(credentialWith({ syncStatus: 'expired' }));

    const buttons = screen.getAllByRole('button');
    const reconnectIndex = buttons.findIndex((button) =>
      button.textContent?.includes(tFromCatalog('settings', 'aurora.card.reconnect')),
    );
    const unlinkIndex = buttons.findIndex((button) =>
      button.textContent?.includes(tFromCatalog('settings', 'aurora.card.unlink')),
    );

    expect(reconnectIndex).toBeGreaterThanOrEqual(0);
    expect(unlinkIndex).toBeGreaterThanOrEqual(0);
    expect(reconnectIndex).toBeLessThan(unlinkIndex);
  });

  it('offers no Reconnect on an active credential', () => {
    renderCard(credentialWith({ syncStatus: 'active' }));

    expect(screen.queryByText(tFromCatalog('settings', 'aurora.card.reconnect'))).toBeNull();
    expect(screen.getByText(tFromCatalog('settings', 'aurora.status.connected'))).toBeTruthy();
  });

  it('localises the duplicate-circuits sync error instead of printing the raw code', () => {
    renderCard(credentialWith({ syncError: DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR }));

    expect(screen.getByText(tFromCatalog('settings', 'aurora.status.duplicateAccountCircuits'))).toBeTruthy();
    expect(screen.queryByText(DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR)).toBeNull();
  });

  it('renders an unknown sync error verbatim', () => {
    renderCard(credentialWith({ syncError: 'legacy free text failure' }));

    expect(screen.getByText('legacy free text failure')).toBeTruthy();
  });
});

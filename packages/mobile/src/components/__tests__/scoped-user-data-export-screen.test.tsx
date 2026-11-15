// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDataExportStatus } from '@boardsesh/shared-schema';
import type { HttpQueryScope } from '../../lib/graphql/http-query-scope';
import type { UserDataExportDownloadRequest } from '../../lib/user-data-export-action';
import type { MoreFormModel } from '../MoreForm.types';

const selected = vi.hoisted(() => ({
  scope: null as HttpQueryScope | null,
  userId: 'owned-A',
  status: 'not_requested' as UserDataExportStatus['status'],
  generation: 1,
  summary: vi.fn<() => Promise<{ pendingCount: number; deadLetterCount: number }>>(),
  confirm: vi.fn<() => Promise<boolean>>(),
  openDownload: vi.fn<(request: UserDataExportDownloadRequest) => Promise<void>>(),
  model: null as MoreFormModel | null,
}));
vi.mock('../../lib/graphql/use-http-query-scope', () => ({
  useHttpQueryScope: () => {
    if (!selected.scope) throw new Error('Missing export screen fixture');
    return selected.scope;
  },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('../../hooks/use-is-offline', () => ({ useIsOffline: () => false }));
vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));
vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => selected.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === selected.generation,
}));
vi.mock('../../lib/user-data-export-download', () => ({ openUserDataExportDownload: selected.openDownload }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../providers/dialog-provider', () => ({ useConfirm: () => selected.confirm }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { groupedBackground: '#fff' } }),
}));
vi.mock('../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: selected.userId }, isError: false, refetch: vi.fn() }),
}));
vi.mock('../../db', () => ({ getDatabaseHandle: () => ({}) }));
vi.mock('@boardsesh/offline-sync', () => ({ getOutboxSummary: () => selected.summary() }));
vi.mock('../../lib/settings-analytics', () => ({ withSettingTracking: (model: MoreFormModel) => model }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ActivityIndicator: () => createElement('div', null, 'loading'),
}));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../Button', () => ({ Button: () => null }));
vi.mock('../MoreForm', () => ({
  MoreForm: ({ model }: { model: MoreFormModel }) => {
    selected.model = model;
    return createElement(
      'div',
      null,
      model.sections.flatMap((section) => [
        createElement('p', { key: `${section.key}-footer` }, section.footer),
        ...section.rows.map((row) =>
          row.kind === 'button'
            ? createElement(
                'button',
                { key: `${section.key}-${row.key}`, onClick: row.onPress, disabled: row.disabled },
                row.key,
              )
            : createElement('span', { key: `${section.key}-${row.key}` }, 'label' in row ? row.label : null),
        ),
      ]),
    );
  },
}));
import { createScopedHttpFixture } from '../../lib/graphql/__tests__/fixtures/scoped-http';
import { UserDataExportScreen } from '../UserDataExportScreen';

const closeFixtures: (() => void)[] = [];
function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: (result: Result) => resolve(result) };
}
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  closeFixtures.push(() => {
    cache.clear();
    http.dispose();
  });
  const documents: string[] = [];
  http.performFetch.mockImplementation(async (_input, options) => {
    const document = (JSON.parse((options as RequestInit).body as string) as { query: string }).query;
    documents.push(document);
    if (document.includes('userDataExportDownload'))
      return Response.json({
        data: {
          userDataExportDownload: {
            url: `https://private.example.test/archive?signature=${selected.userId}`,
            filename: 'climbs.json',
            expiresAt: '2099-01-01T00:00:00Z',
          },
        },
      });
    const status: UserDataExportStatus = {
      boardType: 'kilter',
      period: '2026-W46',
      status: document.includes('requestUserDataExport') ? 'generating' : selected.status,
      refreshAt: '2099-01-01T00:00:00Z',
      files:
        selected.status === 'ready'
          ? [
              {
                format: 'boardsesh',
                filename: 'climbs.json',
                exportedAt: '2026-11-14T00:00:00Z',
                expiresAt: '2099-01-01T00:00:00Z',
              },
            ]
          : [],
    };
    return Response.json({
      data: document.includes('requestUserDataExport') ? { requestUserDataExport: status } : { userDataExport: status },
    });
  });
  const change = (kind: 'B' | 'ABA') => {
    http.switchAccount('owned-B');
    if (kind === 'ABA') http.switchAccount('owned-A');
    selected.userId = kind === 'B' ? 'owned-B' : 'owned-A';
    selected.scope = http.scope();
  };
  return { ...http, wrapper, cache, documents, change };
}
function button(key: string) {
  return screen.getByRole<HTMLButtonElement>('button', { name: key });
}
beforeEach(() => {
  selected.userId = 'owned-A';
  selected.generation = 1;
  selected.status = 'not_requested';
  selected.summary.mockReset().mockResolvedValue({ pendingCount: 0, deadLetterCount: 0 });
  selected.confirm.mockReset().mockResolvedValue(true);
  selected.openDownload.mockReset().mockResolvedValue(undefined);
  selected.model = null;
});
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
  selected.scope = null;
});

describe('actual export screen continuations', () => {
  it.each(['B', 'ABA'] as const)(
    'keeps a delayed outbox read and busy state out of the new %s screen',
    async (change) => {
      const current = fixture();
      const outbox = deferred<{ pendingCount: number; deadLetterCount: number }>();
      selected.summary.mockReturnValueOnce(outbox.promise);
      const rendered = render(<UserDataExportScreen />, current);
      await waitFor(() => expect(button('generate').disabled).toBe(false));
      const oldGenerate = selected
        .model!.sections.flatMap((section) => section.rows)
        .find((row) => row.key === 'generate');
      if (oldGenerate?.kind !== 'button') throw new Error('Expected original generate callback');
      fireEvent.click(button('generate'));
      await waitFor(() => expect(selected.summary).toHaveBeenCalledOnce());
      current.change(change);
      rendered.rerender(<UserDataExportScreen />);
      await waitFor(() => expect(button('generate').disabled).toBe(false));
      await act(async () => outbox.resolve({ pendingCount: 1, deadLetterCount: 0 }));
      expect(selected.confirm).not.toHaveBeenCalled();
      expect(current.documents.filter((document) => document.includes('requestUserDataExport'))).toHaveLength(0);
      const reads = selected.summary.mock.calls.length;
      await act(async () => oldGenerate.onPress());
      expect(selected.summary).toHaveBeenCalledTimes(reads);
      expect(button('generate').disabled).toBe(false);
    },
  );

  it.each(['B', 'ABA'] as const)('refuses an old confirmation before generation under %s', async (change) => {
    const current = fixture();
    const confirmation = deferred<boolean>();
    selected.summary.mockResolvedValue({ pendingCount: 1, deadLetterCount: 0 });
    selected.confirm.mockReturnValueOnce(confirmation.promise);
    const rendered = render(<UserDataExportScreen />, current);
    await waitFor(() => expect(button('generate').disabled).toBe(false));
    fireEvent.click(button('generate'));
    await waitFor(() => expect(selected.confirm).toHaveBeenCalledOnce());
    current.change(change);
    rendered.rerender(<UserDataExportScreen />);
    await waitFor(() => expect(button('generate').disabled).toBe(false));
    await act(async () => confirmation.resolve(true));
    expect(current.documents.filter((document) => document.includes('requestUserDataExport'))).toHaveLength(0);
    expect(button('generate').disabled).toBe(false);
  });

  it('keeps current confirmation and generation usable through the actual mutation/cache', async () => {
    const current = fixture();
    selected.summary.mockResolvedValue({ pendingCount: 1, deadLetterCount: 0 });
    render(<UserDataExportScreen />, current);
    await waitFor(() => expect(button('generate').disabled).toBe(false));
    fireEvent.click(button('generate'));
    await waitFor(() =>
      expect(current.documents.filter((document) => document.includes('requestUserDataExport'))).toHaveLength(1),
    );
    await waitFor(() => expect(screen.getByText('export.generating')).toBeDefined());
    expect(selected.confirm).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(
        current.cache
          .getMutationCache()
          .getAll()
          .map((entry) => entry.state),
      ),
    ).not.toContain('signature=');
  });

  it('abandons an old platform await without clearing the new account download', async () => {
    const current = fixture();
    selected.status = 'ready';
    const oldPlatform = deferred<void>();
    const newPlatform = deferred<void>();
    const platformRequests: UserDataExportDownloadRequest[] = [];
    selected.openDownload.mockImplementation((request) => {
      platformRequests.push(request);
      return platformRequests.length === 1 ? oldPlatform.promise : newPlatform.promise;
    });
    const rendered = render(<UserDataExportScreen />, current);
    await waitFor(() => expect(button('download').disabled).toBe(false));
    fireEvent.click(button('download'));
    await waitFor(() => expect(platformRequests).toHaveLength(1));
    expect(platformRequests[0].isCurrent()).toBe(true);
    current.change('B');
    rendered.rerender(<UserDataExportScreen />);
    await waitFor(() => expect(button('download').disabled).toBe(false));
    expect(platformRequests[0].isCurrent()).toBe(false);
    expect(platformRequests[0].signal.aborted).toBe(true);
    fireEvent.click(button('download'));
    await waitFor(() => expect(platformRequests).toHaveLength(2));
    await act(async () => oldPlatform.resolve());
    expect(button('download').disabled).toBe(true);
    expect(platformRequests[1].isCurrent()).toBe(true);
    await act(async () => newPlatform.resolve());
    await waitFor(() => expect(button('download').disabled).toBe(false));
    expect(screen.queryByText('export.downloadFailed')).toBeNull();
  });
});

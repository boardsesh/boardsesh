// @vitest-environment node
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';
import { SUPPORTED_LOCALES, type Locale } from '@/app/lib/i18n/config';
import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import { reportMissingI18nKey } from '@/app/lib/i18n/missing-key-reporter';
import ServerI18nProvider from '@/app/components/providers/i18n-provider';

const request = vi.hoisted(() => ({ locale: 'en-US' as Locale }));
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => request.locale }));
vi.mock('@/app/lib/i18n/missing-key-reporter', () => ({ reportMissingI18nKey: vi.fn() }));
vi.mock('@/app/lib/backend-url', () => ({ getBackendHttpUrl: () => 'https://backend.example.com' }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
}));
vi.mock('@/app/components/ui/page-shell', () => ({
  PageShell: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
  PageSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
import WorkoutLaunchPage, { generateMetadata } from '@/app/(site)/w/[workoutId]/page';

async function renderLanding(sourceName?: string) {
  const client = new QueryClient();
  if (sourceName) client.setQueryData(['publicAppWorkoutLaunch', 'wk_example'], sourceName);
  const page = await WorkoutLaunchPage({ params: Promise.resolve({ workoutId: 'wk_example' }) });
  const tree = await resolveServerTree(<ServerI18nProvider locale={request.locale}>{page}</ServerI18nProvider>);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{tree}</QueryClientProvider>);
}

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  vi.mocked(reportMissingI18nKey).mockClear();
  request.locale = 'en-US';
});

describe('private workout launch landing', () => {
  it.each(SUPPORTED_LOCALES)('translates the fetched source name using route resources in %s', async (locale) => {
    request.locale = locale;
    const html = await renderLanding('Boardsesh MCP');
    const { t } = await getServerTranslationForLocale(locale, 'session');
    expect(html).toContain(t('partnerWorkouts.from', { app: 'Boardsesh MCP' }));
    expect(html).not.toContain('partnerWorkouts.from');
    expect(reportMissingI18nKey).not.toHaveBeenCalled();
  });
  it('server-renders the launch action without fetching or disclosing private plan details', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            publicAppWorkoutLaunch: {
              sourceAppName: 'Training Planner',
              title: 'Private title',
              notes: 'Secret coach note',
              blocks: ['secret block'],
            },
          },
        }),
      ),
    );
    const html = await renderLanding();
    expect(html).not.toContain('Training Planner');
    expect(html).toContain('com.boardsesh.app://w/wk_example');
    expect(html).not.toMatch(/Private title|Secret coach note|secret block/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the scheme and store fallback available when the backend is unavailable', async () => {
    fetchMock.mockRejectedValue(new Error('network unavailable'));
    const html = await renderLanding();
    expect(html).toContain('com.boardsesh.app://w/wk_example');
    expect(html).toContain('apps.apple.com');
    expect(html).toContain('play.google.com');
    const metadata = await generateMetadata({ params: Promise.resolve({ workoutId: 'wk_example' }) });
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it('refuses malformed identifiers before making a backend request', async () => {
    await expect(WorkoutLaunchPage({ params: Promise.resolve({ workoutId: '../private' }) })).rejects.toThrow(
      'not found',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

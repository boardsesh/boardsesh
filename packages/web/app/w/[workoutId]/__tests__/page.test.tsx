import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({
    locale: 'en-US',
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog('session', key, options),
  }),
}));
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
import WorkoutLaunchPage, { generateMetadata } from '../page';

async function renderLanding() {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      {await WorkoutLaunchPage({ params: Promise.resolve({ workoutId: 'wk_example' }) })}
    </QueryClientProvider>,
  );
}

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

describe('private workout launch landing', () => {
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

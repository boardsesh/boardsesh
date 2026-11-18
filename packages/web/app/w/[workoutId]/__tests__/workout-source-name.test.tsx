// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { executeGraphQL } from '@/app/lib/graphql/client';
import { WorkoutSourceName } from '../workout-source-name';

vi.mock('@/app/lib/graphql/client', () => ({ executeGraphQL: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options: { app: string }) => `From ${options.app}` }),
}));

describe('public workout source name', () => {
  it('requests only the public name through the browser GraphQL transport', async () => {
    vi.mocked(executeGraphQL).mockResolvedValue({ publicAppWorkoutLaunch: { sourceAppName: 'Coach app' } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkoutSourceName workoutId="wk_public" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('From Coach app')).toBeDefined());
    expect(executeGraphQL).toHaveBeenCalledWith(
      'query PublicAppWorkoutLaunch($id: ID!) { publicAppWorkoutLaunch(id: $id) { sourceAppName } }',
      { id: 'wk_public' },
    );
  });
});

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Gym } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const gym = {
  uuid: '87f2c9c4-bbd9-4510-8ed5-f9aad68095dd',
  slug: 'blackheath-bouldering-club',
  name: 'Blackheath Bouldering Club',
  canEdit: true,
} as Gym;
const mocks = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn(), create: vi.fn(), edit: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: React.forwardRef<HTMLAnchorElement, React.ComponentProps<'a'>>((props, ref) => <a {...props} ref={ref} />),
}));
vi.mock('../actions', () => ({ refreshGymDirectory: mocks.refresh }));
vi.mock('@/app/components/gym-entity/create-gym-form', () => ({
  default: ({ onSuccess }: { onSuccess: (gym: Gym) => Promise<void> }) => (
    <button
      onClick={() => {
        mocks.create();
        void onSuccess(gym);
      }}
    >
      Create test gym
    </button>
  ),
}));
vi.mock('@/app/components/gym-entity/edit-gym-form', () => ({
  default: ({ gym: editingGym, onSuccess }: { gym: Gym; onSuccess: (gym: Gym) => Promise<void> }) => (
    <>
      <input aria-label="Gym name draft" defaultValue={editingGym.name} />
      <button
        onClick={() => {
          mocks.edit();
          void onSuccess(editingGym);
        }}
      >
        Save test gym
      </button>
    </>
  ),
}));
vi.mock('@/app/components/gym-entity/manage/gym-boards-tab', () => ({
  GymBoardAssociation: ({ onAssociated }: { onAssociated: () => Promise<void> }) => (
    <button onClick={() => void onAssociated()}>Link test board</button>
  ),
}));
const { default: GymSetup } = await import('../gym-setup');

function renderSetup(initialGym: Gym | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderGymSetup = (nextGym: Gym | null) => (
    <QueryClientProvider client={queryClient}>
      <GymSetup initialGym={nextGym} />
    </QueryClientProvider>
  );
  const renderedSetup = render(renderGymSetup(initialGym));
  return {
    ...renderedSetup,
    rerenderSetup: (nextGym: Gym | null) => renderedSetup.rerender(renderGymSetup(nextGym)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockResolvedValue(true);
});

describe('gym setup', () => {
  it('preserves the editor and unsaved input when the same gym is refreshed', () => {
    const { rerenderSetup } = renderSetup(gym);
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Gym name draft' }), {
      target: { value: 'Unsaved gym name' },
    });

    rerenderSetup({ ...gym });

    expect(screen.getByRole('textbox', { name: 'Gym name draft' })).toHaveProperty('value', 'Unsaved gym name');
    expect(screen.getByRole('button', { name: 'Save test gym' })).toBeTruthy();
  });

  it('preserves edits made before the first save finishes refreshing the server page', async () => {
    let finishRefresh: ((refreshed: boolean) => void) | undefined;
    mocks.refresh.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishRefresh = resolve;
      }),
    );
    const { rerenderSetup } = renderSetup(null);
    fireEvent.click(screen.getByRole('button', { name: 'Create test gym' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Gym name draft' }), { target: { value: 'Keep this draft' } });

    rerenderSetup({ ...gym });
    await act(async () => {
      finishRefresh?.(true);
    });

    expect(screen.getByRole('textbox', { name: 'Gym name draft' })).toHaveProperty('value', 'Keep this draft');
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('opens the board step when navigating to a different saved gym', () => {
    const { rerenderSetup } = renderSetup(gym);
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    const nextGym = { ...gym, uuid: '8d73d083-ae2b-4203-a568-7a3a10613cb6', slug: 'another-gym', name: 'Another gym' };

    rerenderSetup(nextGym);

    expect(screen.queryByRole('textbox', { name: 'Gym name draft' })).toBeNull();
    expect(screen.getByRole('link', { name: 'See gym' }).getAttribute('href')).toBe('/gym/another-gym');
  });

  it('starts a fresh gym when the saved gym is removed from the route', () => {
    const { rerenderSetup } = renderSetup(gym);

    rerenderSetup(null);

    expect(screen.getByRole('button', { name: 'Create test gym' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Link test board' })).toBeNull();
  });

  it('stores the gym before cache refresh, then edits it without replaying create', async () => {
    mocks.refresh.mockResolvedValueOnce(false);
    renderSetup(null);
    fireEvent.click(screen.getByRole('button', { name: 'Create test gym' }));
    await screen.findByText(/Blackheath Bouldering Club is saved/);
    expect(mocks.replace).toHaveBeenCalledWith(`/gyms/new?gym=${gym.uuid}`, { scroll: false });
    expect(await screen.findByText(/directory has not refreshed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create test gym' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh directory' }));
    await waitFor(() => expect(screen.queryByText(/directory has not refreshed/)).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save test gym' }));
    await screen.findByText(/Blackheath Bouldering Club is saved/);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.edit).toHaveBeenCalledTimes(1);
  });

  it('resumes the board step and links Finish and Skip to the saved gym', async () => {
    renderSetup(gym);
    expect(screen.queryByRole('button', { name: 'Create test gym' })).toBeNull();
    expect(screen.getByRole('link', { name: 'See gym' }).getAttribute('href')).toBe(`/gym/${gym.slug}`);
    expect(screen.getByRole('link', { name: 'Skip for now' }).getAttribute('href')).toBe(`/gym/${gym.slug}`);
    fireEvent.click(screen.getByRole('button', { name: 'Link test board' }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith(gym.uuid));
  });

  it('keeps the saved board step when cache transport fails', async () => {
    mocks.refresh.mockRejectedValueOnce(new Error('network unavailable'));
    renderSetup(null);
    fireEvent.click(screen.getByRole('button', { name: 'Create test gym' }));
    expect(await screen.findByText(/directory has not refreshed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Link test board' })).toBeTruthy();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});

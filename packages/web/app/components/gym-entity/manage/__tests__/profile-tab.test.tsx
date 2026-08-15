import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { Gym } from '@boardsesh/shared-schema';
import ProfileTab from '../profile-tab';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

// The shared form embeds a Leaflet-backed location picker; stub it so this test
// stays focused on the profile fields.
vi.mock('@/app/components/board-entity/map-location-picker', () => ({
  default: () => <div data-testid="map-picker" />,
}));

// The console profile form must save through the SAME mutation the sheet used
// (UPDATE_GYM via useEntityMutation). Capture the execute call at the hook seam.
const mockExecute = vi.fn();
vi.mock('@/app/hooks/use-entity-mutation', () => ({
  useEntityMutation: () => ({ execute: mockExecute, token: 'test-token' }),
}));

function makeGym(overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: 'gym-uuid-1',
    slug: 'test-gym',
    ownerId: 'user-owner',
    name: 'Test Gym',
    description: 'A gym',
    address: '1 Crux St',
    website: 'https://example.com',
    isPublic: true,
    ...overrides,
  } as unknown as Gym;
}

beforeEach(() => {
  mockExecute.mockReset();
});

describe('ProfileTab', () => {
  it('mounts the shared gym profile form in the console', () => {
    render(<ProfileTab gym={makeGym()} onGymChange={vi.fn()} />);

    expect(screen.getByText('Gym profile')).toBeTruthy();
    // The shared EditGymForm's name field, prefilled from the gym.
    expect(screen.getByDisplayValue('Test Gym')).toBeTruthy();
  });

  it('saves through the same mutation and pushes the result to the shell', async () => {
    const updatedGym = makeGym({ name: 'Test Gym' });
    mockExecute.mockResolvedValue({ updateGym: updatedGym });
    const onGymChange = vi.fn();

    render(<ProfileTab gym={makeGym()} onGymChange={onGymChange} />);

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
    const variables = mockExecute.mock.calls[0][0];
    expect(variables.input.gymUuid).toBe('gym-uuid-1');
    expect(variables.input.name).toBe('Test Gym');

    await waitFor(() => {
      expect(onGymChange).toHaveBeenCalledWith(updatedGym);
    });
  });

  it('prefills the gym opening hours and saves them trimmed', async () => {
    mockExecute.mockResolvedValue({ updateGym: makeGym() });

    render(<ProfileTab gym={makeGym({ hours: 'Mon-Fri 7-22' })} onGymChange={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue('Mon-Fri 7-22'), {
      target: { value: '  Mon-Fri 7-23, Sat-Sun 9-20  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
    expect(mockExecute.mock.calls[0][0].input.hours).toBe('Mon-Fri 7-23, Sat-Sun 9-20');
  });

  it('sends null when the owner clears the hours, so the column actually clears', async () => {
    mockExecute.mockResolvedValue({ updateGym: makeGym() });

    render(<ProfileTab gym={makeGym({ hours: 'Mon-Fri 7-22' })} onGymChange={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue('Mon-Fri 7-22'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
    // `undefined` is updateGym's "leave the column untouched" sentinel — sending
    // it here would make the field impossible to empty.
    const { input } = mockExecute.mock.calls[0][0];
    expect(input.hours).toBeNull();
    expect('hours' in input).toBe(true);
  });

  it('bubbles the form dirty state so the shell can guard tab switches', async () => {
    const onDirtyChange = vi.fn();
    render(<ProfileTab gym={makeGym()} onGymChange={vi.fn()} onDirtyChange={onDirtyChange} />);

    // Clean on mount.
    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    });

    // Editing a field flips it to dirty.
    fireEvent.change(screen.getByDisplayValue('Test Gym'), { target: { value: 'Test Gym 2' } });
    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    });
  });
});

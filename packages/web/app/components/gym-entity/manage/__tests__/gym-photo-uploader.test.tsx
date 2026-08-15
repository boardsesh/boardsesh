import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { Gym } from '@boardsesh/shared-schema';
import GymPhotoUploader from '../gym-photo-uploader';
import { GYM_PHOTO_MAX_INPUT_BYTES } from '../photo-image-utils';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockExecute = vi.fn();
const mockOnError = vi.hoisted(() => ({ handler: null as ((error: unknown, message: string | null) => void) | null }));
vi.mock('@/app/hooks/use-entity-mutation', () => ({
  useEntityMutation: (_mutation: unknown, options: { onError?: (e: unknown, m: string | null) => void }) => {
    mockOnError.handler = options.onError ?? null;
    return { execute: mockExecute, token: 'test-token' };
  },
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isLoading: false, error: null }),
}));

vi.mock('@/app/lib/backend-url', () => ({
  getBackendHttpUrl: () => 'https://ws.boardsesh.com',
}));

const PHOTO_PATH = '/static/gym-photos/11111111-2222-4333-8444-555555555555.jpg?v=abc';

function makeGym(overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: 'gym-uuid-1',
    slug: 'test-gym',
    ownerId: 'user-owner',
    name: 'Test Gym',
    isPublic: true,
    ...overrides,
  } as unknown as Gym;
}

function fileInputOf(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error('file input not rendered');
  return input as HTMLInputElement;
}

function pick(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  mockExecute.mockReset();
  mockOnError.handler = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('GymPhotoUploader failure surfaces', () => {
  it('shows an inline error for an unsupported file type and uploads nothing', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { container } = render(<GymPhotoUploader gym={makeGym()} onGymChange={vi.fn()} />);

    pick(fileInputOf(container), new File(['<svg/>'], 'wall.svg', { type: 'image/svg+xml' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Use a JPG, PNG, or WebP image.');
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('shows an inline error for a file over the input cap', async () => {
    const { container } = render(<GymPhotoUploader gym={makeGym()} onGymChange={vi.fn()} />);

    const oversized = new File(['x'], 'wall.jpg', { type: 'image/jpeg' });
    Object.defineProperty(oversized, 'size', { value: GYM_PHOTO_MAX_INPUT_BYTES + 1 });
    pick(fileInputOf(container), oversized);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('over 20MB');
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('routes a failed updateGym into the inline alert instead of a toast', async () => {
    render(<GymPhotoUploader gym={makeGym()} onGymChange={vi.fn()} />);

    expect(mockOnError.handler).not.toBeNull();
    mockOnError.handler!(new Error('boom'), null);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain("Couldn't save the photo.");
    });
  });
});

describe('GymPhotoUploader removal', () => {
  it('nulls the column first, then best-effort deletes the object', async () => {
    const clearedGym = makeGym({ imageUrl: null });
    mockExecute.mockResolvedValue({ updateGym: clearedGym });
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const onGymChange = vi.fn();

    render(<GymPhotoUploader gym={makeGym({ imageUrl: PHOTO_PATH })} onGymChange={onGymChange} />);

    fireEvent.click(screen.getByRole('button', { name: /remove/i }));

    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
    expect(mockExecute.mock.calls[0][0].input).toEqual({ gymUuid: 'gym-uuid-1', imageUrl: null });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ws.boardsesh.com/api/gym-photos?gymUuid=gym-uuid-1');
    expect(init.method).toBe('DELETE');
    expect(onGymChange).toHaveBeenCalledWith(clearedGym);
  });

  it('leaves the object alone when clearing the column failed', async () => {
    // Deleting the object after a failed column clear is exactly the dangling
    // URL we're avoiding — the row would still point at a deleted photo.
    mockExecute.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    render(<GymPhotoUploader gym={makeGym({ imageUrl: PHOTO_PATH })} onGymChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /remove/i }));

    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('GymPhotoUploader helper copy', () => {
  it('tells owners to use a real photo of their wall', () => {
    render(<GymPhotoUploader gym={makeGym()} onGymChange={vi.fn()} />);

    expect(screen.getByText(/real photo of your wall or board area/i)).toBeTruthy();
  });
});

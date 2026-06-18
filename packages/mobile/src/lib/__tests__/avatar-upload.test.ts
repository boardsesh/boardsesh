import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Fixed backend origin so the relative→absolute logic is deterministic and
// independent of EXPO_PUBLIC_BACKEND_URL.
vi.mock('../env', () => ({
  BACKEND_URL: 'https://ws.example.com',
}));

// Mock the auth wrapper so we don't pull in auth-store → expo-secure-store, and
// so we can assert on the request the helper makes.
const mockAuthenticatedFetch = vi.fn();
vi.mock('../auth-interceptor', () => ({
  authenticatedFetch: (...args: unknown[]) => mockAuthenticatedFetch(...args),
}));

import { absolutizeAvatarUrl, uploadAvatar } from '../avatar-upload';

const BACKEND = 'https://ws.example.com';
const file = { uri: 'file:///tmp/avatar.jpg', name: 'avatar.jpg', type: 'image/jpeg' };
const userId = '11111111-2222-3333-4444-555555555555';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('absolutizeAvatarUrl', () => {
  it('prefixes a backend-relative path with the backend origin', () => {
    expect(absolutizeAvatarUrl('/static/avatars/abc.jpg')).toBe(`${BACKEND}/static/avatars/abc.jpg`);
  });

  it('preserves version query params on backend-relative paths', () => {
    expect(absolutizeAvatarUrl('/static/avatars/abc.jpg?v=upload-123')).toBe(
      `${BACKEND}/static/avatars/abc.jpg?v=upload-123`,
    );
  });

  it('passes an already-absolute URL through unchanged', () => {
    const external = 'https://lh3.googleusercontent.com/a/abc';
    expect(absolutizeAvatarUrl(external)).toBe(external);
  });
});

describe('uploadAvatar', () => {
  it('POSTs multipart form data to the avatars endpoint and returns the absolute URL', async () => {
    mockAuthenticatedFetch.mockResolvedValue(
      jsonResponse({ success: true, avatarUrl: '/static/avatars/me.jpg?v=upload-123' }),
    );

    const result = await uploadAvatar(file, userId);

    expect(result).toBe(`${BACKEND}/static/avatars/me.jpg?v=upload-123`);
    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = (mockAuthenticatedFetch as Mock).mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${BACKEND}/api/avatars`);
    expect(options.method).toBe('POST');
    // No explicit Content-Type — RN sets the multipart boundary itself.
    expect(options.headers).toBeUndefined();
    const body = options.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('userId')).toBe(userId);
    expect(body.has('avatar')).toBe(true);
  });

  it('throws the server-provided error message on a non-ok response', async () => {
    mockAuthenticatedFetch.mockResolvedValue(jsonResponse({ error: 'File too large' }, false, 413));
    await expect(uploadAvatar(file, userId)).rejects.toMatchObject({ message: 'File too large', status: 413 });
  });

  it('throws when the response is missing an avatarUrl', async () => {
    mockAuthenticatedFetch.mockResolvedValue(jsonResponse({ success: true }));
    await expect(uploadAvatar(file, userId)).rejects.toThrow('Avatar upload failed');
  });
});

describe('avatar upload URL trailing-slash normalisation', () => {
  it('strips a trailing slash from BACKEND_URL before joining upload and static paths', async () => {
    vi.resetModules();
    const trailingSlashFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        avatarUrl: '/static/avatars/me.jpg?v=upload-123',
      }),
    );
    vi.doMock('../env', () => ({
      BACKEND_URL: 'https://ws.example.com/',
    }));
    vi.doMock('../auth-interceptor', () => ({
      authenticatedFetch: (...args: unknown[]) => trailingSlashFetch(...args),
    }));

    const reloaded = await import('../avatar-upload');
    const result = await reloaded.uploadAvatar(file, userId);

    expect(result).toBe(`${BACKEND}/static/avatars/me.jpg?v=upload-123`);
    expect(trailingSlashFetch).toHaveBeenCalledWith(
      `${BACKEND}/api/avatars`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(reloaded.absolutizeAvatarUrl('/static/avatars/me.jpg?v=upload-123')).toBe(
      `${BACKEND}/static/avatars/me.jpg?v=upload-123`,
    );
  });
});

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

// expo-file-system is native; stub the File class so `.bytes()` resolves to a
// fixed payload in Node.
const fileBytes = new Uint8Array([1, 2, 3]);
vi.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    bytes() {
      return Promise.resolve(fileBytes);
    }
  },
}));

// A minimal FormData that records appended parts as-is (Node's undici FormData
// stringifies non-Blob values, which would hide the part object we need to
// inspect — the whole point of this regression test).
class RecordingFormData {
  parts: [string, unknown][] = [];
  append(name: string, value: unknown) {
    this.parts.push([name, value]);
  }
  get(name: string) {
    return this.parts.find(([key]) => key === name)?.[1];
  }
  has(name: string) {
    return this.parts.some(([key]) => key === name);
  }
}
vi.stubGlobal('FormData', RecordingFormData);

import { absolutizeAvatarUrl, uploadAvatar } from '../avatar-upload';

const BACKEND = 'https://ws.example.com';
const file = { uri: 'file:///tmp/avatar.jpg', name: 'avatar.jpg', type: 'image/jpeg' };
const userId = '11111111-2222-3333-4444-555555555555';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('absolutizeAvatarUrl', () => {
  it('prefixes a backend-relative path with the backend origin', () => {
    expect(absolutizeAvatarUrl('/static/avatars/abc.jpg')).toBe(`${BACKEND}/static/avatars/abc.jpg`);
  });

  it('passes an already-absolute URL through unchanged', () => {
    const external = 'https://lh3.googleusercontent.com/a/abc';
    expect(absolutizeAvatarUrl(external)).toBe(external);
  });
});

describe('uploadAvatar', () => {
  it('POSTs an Expo-fetch-compatible multipart part and returns a cache-busted absolute URL', async () => {
    mockAuthenticatedFetch.mockResolvedValue(jsonResponse({ success: true, avatarUrl: '/static/avatars/me.jpg' }));

    const result = await uploadAvatar(file, userId);

    // Absolutized + stamped so a re-upload of the deterministic filename refetches.
    expect(result).toMatch(/^https:\/\/ws\.example\.com\/static\/avatars\/me\.jpg\?v=\d+$/);

    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = (mockAuthenticatedFetch as Mock).mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${BACKEND}/api/avatars`);
    expect(options.method).toBe('POST');
    // No explicit Content-Type — the fetch layer sets the multipart boundary.
    expect(options.headers).toBeUndefined();

    const body = options.body as unknown as RecordingFormData;
    expect(body.get('userId')).toBe(userId);

    // The regression: the avatar part must expose `bytes()` + name/type, NOT the
    // legacy `{ uri }` descriptor that Expo's fetch rejects.
    const avatarPart = body.get('avatar') as { name: string; type: string; bytes: () => Promise<Uint8Array> };
    expect(avatarPart).not.toHaveProperty('uri');
    expect(avatarPart.name).toBe('avatar.jpg');
    expect(avatarPart.type).toBe('image/jpeg');
    expect(typeof avatarPart.bytes).toBe('function');
    await expect(avatarPart.bytes()).resolves.toBe(fileBytes);
  });

  it('throws the server-provided error message on a non-ok response', async () => {
    mockAuthenticatedFetch.mockResolvedValue(jsonResponse({ error: 'File too large' }, false));
    await expect(uploadAvatar(file, userId)).rejects.toThrow('File too large');
  });

  it('throws when the response is missing an avatarUrl', async () => {
    mockAuthenticatedFetch.mockResolvedValue(jsonResponse({ success: true }));
    await expect(uploadAvatar(file, userId)).rejects.toThrow('Avatar upload failed');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { NativeFormData, type NativeUploadFormData } from '../../../test/native-upload-runtime';

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
    exists = true;
    size = 3;
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    bytes() {
      return Promise.resolve(fileBytes);
    }
  },
}));

afterEach(() => vi.unstubAllGlobals());

import { absolutizeAvatarUrl, uploadAvatar } from '../avatar-upload';

const BACKEND = 'https://ws.example.com';
const file = { uri: 'file:///tmp/avatar.jpg', name: 'avatar.jpg', type: 'image/jpeg' };
const userId = '11111111-2222-3333-4444-555555555555';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('FormData', NativeFormData);
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
  it('POSTs an multipart file readable by RN and Expo fetch and returns a cache-busted absolute URL', async () => {
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

    const body = options.body as unknown as NativeUploadFormData;
    expect(body.get('userId')).toBe(userId);

    // Release builds use RN fetch; its serializer must retain the file URI.
    const avatarPart = body.get('avatar') as { name: string; type: string; bytes: () => Promise<Uint8Array> };
    expect(body.getParts()[0].uri).toBe(file.uri);
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

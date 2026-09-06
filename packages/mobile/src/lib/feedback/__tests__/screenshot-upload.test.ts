import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Fixed backend origin so the endpoint URL is deterministic and independent of
// EXPO_PUBLIC_BACKEND_URL.
vi.mock('../../env', () => ({
  BACKEND_URL: 'https://ws.example.com',
}));

// Mock the auth wrapper so we don't pull in auth-store → expo-secure-store, and
// so we can assert on the request the helper makes.
const mockAuthenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('../../auth-interceptor', () => ({
  authenticatedFetch: (...args: unknown[]) => mockAuthenticatedFetch(...args),
}));

// expo-file-system is native; stub the File class so `.bytes()` resolves to a
// per-URI payload in Node (the payload identifies which file a part carries).
vi.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    bytes() {
      return Promise.resolve(new TextEncoder().encode(this.uri));
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

import { clearScreenshotUploadCache, uploadFeedbackScreenshot, uploadFeedbackScreenshots } from '../screenshot-upload';

const BACKEND = 'https://ws.example.com';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The uploaded-key cache is module state that outlives a single call — it is
  // what stops a retry re-uploading shots that already landed. Without a reset
  // here, a later case reuses an earlier one's keys and never reaches its own
  // mocked response.
  clearScreenshotUploadCache();
});

describe('uploadFeedbackScreenshot', () => {
  it('POSTs an Expo-fetch-compatible multipart part and returns the storage key', async () => {
    mockAuthenticatedFetch.mockResolvedValue(
      jsonResponse({ success: true, key: 'feedback-screenshots/abc.jpg', url: 'https://cdn/abc.jpg' }),
    );

    await expect(uploadFeedbackScreenshot('file:///tmp/shot.jpg')).resolves.toBe('feedback-screenshots/abc.jpg');

    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = (mockAuthenticatedFetch as Mock).mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${BACKEND}/api/feedback-screenshots`);
    expect(options.method).toBe('POST');
    // No explicit Content-Type — the fetch layer sets the multipart boundary.
    expect(options.headers).toBeUndefined();

    const body = options.body as unknown as RecordingFormData;
    // The regression: the part must expose `bytes()` + name/type, NOT the legacy
    // `{ uri }` descriptor that Expo's fetch rejects.
    const part = body.get('screenshot') as { name: string; type: string; bytes: () => Promise<Uint8Array> };
    expect(part).not.toHaveProperty('uri');
    expect(part.name).toBe('screenshot.jpg');
    expect(part.type).toBe('image/jpeg');
    expect(typeof part.bytes).toBe('function');
    await expect(part.bytes()).resolves.toEqual(new TextEncoder().encode('file:///tmp/shot.jpg'));
  });

  it('throws the server-provided error message on a non-ok response', async () => {
    mockAuthenticatedFetch.mockResolvedValue(jsonResponse({ error: 'File too large' }, false));
    await expect(uploadFeedbackScreenshot('file:///tmp/shot.jpg')).rejects.toThrow('File too large');
  });

  it('throws when the response carries no key', async () => {
    mockAuthenticatedFetch.mockResolvedValue(jsonResponse({ success: true }));
    await expect(uploadFeedbackScreenshot('file:///tmp/shot.jpg')).rejects.toThrow('Screenshot upload failed');
  });
});

describe('uploadFeedbackScreenshots', () => {
  it('returns the keys in the order the shots were picked, not the order they landed', async () => {
    // The thumbnails, the GitHub comment and this array all read in pick order,
    // so a slow first upload must not shuffle them.
    const keyByUri: Record<string, string> = {
      'file:///a.jpg': 'feedback-screenshots/a.jpg',
      'file:///b.jpg': 'feedback-screenshots/b.jpg',
      'file:///c.jpg': 'feedback-screenshots/c.jpg',
    };
    let call = 0;
    mockAuthenticatedFetch.mockImplementation(async (_url: string, options: RequestInit) => {
      const body = options.body as unknown as RecordingFormData;
      const part = body.get('screenshot') as { bytes: () => Promise<Uint8Array> };
      const uri = new TextDecoder().decode(await part.bytes());
      // First request resolves last.
      const delay = call++ === 0 ? 20 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return jsonResponse({ success: true, key: keyByUri[uri] });
    });

    await expect(uploadFeedbackScreenshots(['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg'])).resolves.toEqual([
      'feedback-screenshots/a.jpg',
      'feedback-screenshots/b.jpg',
      'feedback-screenshots/c.jpg',
    ]);
    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(3);
  });

  it('sends one request at a time, never overlapping them', async () => {
    // Not a style preference. Reading a picked file goes through an Expo
    // AsyncFunction, and those share ONE serial dispatch queue; overlapping
    // uploads put several file reads in that queue behind whatever else is
    // using it (the board renderer) and the requests can stop settling —
    // which leaves the sheet's submit button disabled with no error (#5197).
    let inFlight = 0;
    let maxInFlight = 0;
    mockAuthenticatedFetch.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return jsonResponse({ success: true, key: 'feedback-screenshots/a.jpg' });
    });

    await uploadFeedbackScreenshots(['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg', 'file:///d.jpg']);

    expect(maxInFlight).toBe(1);
    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(4);
  });

  it('gives every upload a deadline, so a stalled request cannot wedge the sheet', async () => {
    // Without this the promise never settles, the sheet's `finally` never runs,
    // and the submit button stays disabled forever with no toast.
    mockAuthenticatedFetch.mockResolvedValue(jsonResponse({ success: true, key: 'feedback-screenshots/a.jpg' }));

    await uploadFeedbackScreenshots(['file:///a.jpg']);

    const [, options] = mockAuthenticatedFetch.mock.calls[0] as [string, RequestInit];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects when any single upload fails, so the caller can keep the typed report', async () => {
    mockAuthenticatedFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, key: 'feedback-screenshots/a.jpg' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'Unsupported file type' }, false));

    await expect(uploadFeedbackScreenshots(['file:///a.jpg', 'file:///b.gif'])).rejects.toThrow(
      'Unsupported file type',
    );
  });

  it('makes no request at all for an empty list', async () => {
    await expect(uploadFeedbackScreenshots([])).resolves.toEqual([]);
    expect(mockAuthenticatedFetch).not.toHaveBeenCalled();
  });
});
